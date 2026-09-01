import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  NEW_TAB_INDEX_KEY,
  SERVICE_RULES_KEY,
  ensureSchemaV3,
  getEntry,
  getNewTabIndex,
  getServiceRules,
  patchEntry,
  putEntry,
  promoteServiceRules,
  removeEntries
} from "../reporthub/repo";
import { UNDO_KEY } from "../reporthub/tabops";
import {
  DEFAULT_SETTINGS,
  FALLBACK_GROUP,
  type NewTabIndexEntry,
  type ReportEntry,
  type ServiceRule,
  type ServiceRulesStore,
  type Settings,
  type UndoSnapshot
} from "../reporthub/types";
import {
  entryIdFromKey,
  fileName,
  inferGroup,
  inferService,
  matchServiceRule,
  normalizeTarget,
  parentDir,
  serviceHostname
} from "../reporthub/url";
import type { HtmlPreviewData } from "./preview";
import type { HubIndexMatch, HubIndexSnapshot } from "./hubindex";
import { S } from "./strings";

type Kind = ReportEntry["kind"];
type KindFilter = "all" | Kind;
type Band = "open" | "recent" | "later";
type CollapsibleBand = Band | "bookmarks" | "hubIndex";

interface HubEntry extends NewTabIndexEntry {
  tabId?: number;
  windowId?: number;
  chromePinned?: boolean;
}

interface ToastState {
  text: string;
  undo?: { entry: HubEntry; ts: number };
}

interface PreviewState {
  entry: HubEntry;
  serviceRule: ServiceRule | null;
  target: HTMLElement;
  anchorTop: number;
  left: number;
  top: number;
  html?: HtmlPreviewData;
}

type HubIndexModule = typeof import("./hubindex");

interface HubIndexState {
  api: HubIndexModule | null;
  snapshot: HubIndexSnapshot | null;
}

const KINDS: Kind[] = ["web", "html", "pdf"];
const KIND_FILTERS: KindFilter[] = ["all", ...KINDS];
const BANDS: Band[] = ["open", "recent", "later"];
const COLLAPSIBLE_BANDS: CollapsibleBand[] = ["open", "recent", "bookmarks", "hubIndex", "later"];
const SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LAYOUT_STORAGE_KEY = "tabhub:layout";
const PREVIEW_WIDTH = 340;
const PREVIEW_GAP = 10;
const PREVIEW_EDGE = 8;
const PREVIEW_HOVER_DELAY_MS = 200;
const LEDGER_MAINTENANCE_DELAY_MS = 1000;
const SETTINGS_STORAGE_KEY = "settings";
const META_STORAGE_KEY = "meta";

interface LayoutState {
  kind: KindFilter;
  collapsedBands: CollapsibleBand[];
  selectedServices: string[];
  selectedCategories: string[];
}

interface NewTabBootstrap {
  settings: Settings;
  schemaVersion: number;
  serviceRules: ServiceRulesStore | null;
  index: NewTabIndexEntry[] | null;
}

async function getNewTabBootstrap(): Promise<NewTabBootstrap> {
  const got = await chrome.storage.local.get([
    SETTINGS_STORAGE_KEY,
    META_STORAGE_KEY,
    SERVICE_RULES_KEY,
    NEW_TAB_INDEX_KEY
  ]);
  const storedSettings = got[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined;
  const storedMeta = got[META_STORAGE_KEY] as { schemaVersion?: unknown } | undefined;
  const storedIndex = got[NEW_TAB_INDEX_KEY] as NewTabIndexEntry[] | undefined;
  return {
    settings: { ...DEFAULT_SETTINGS, ...storedSettings },
    schemaVersion: typeof storedMeta?.schemaVersion === "number" ? storedMeta.schemaVersion : 1,
    serviceRules: Object.prototype.hasOwnProperty.call(got, SERVICE_RULES_KEY)
      ? got[SERVICE_RULES_KEY] as ServiceRulesStore
      : null,
    index: Array.isArray(storedIndex) ? storedIndex : null
  };
}

function readLayoutState(): LayoutState {
  const fallback: LayoutState = { kind: "all", collapsedBands: [], selectedServices: [], selectedCategories: [] };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null") as Partial<LayoutState> | null;
    if (!stored || !KIND_FILTERS.includes(stored.kind as KindFilter)) return fallback;
    const collapsedBands = Array.isArray(stored.collapsedBands)
      ? stored.collapsedBands.filter((band): band is CollapsibleBand =>
          COLLAPSIBLE_BANDS.includes(band as CollapsibleBand)
        )
      : [];
    const selectedServices = Array.isArray(stored.selectedServices)
      ? [...new Set(stored.selectedServices.filter((id): id is string => typeof id === "string"))]
      : [];
    const selectedCategories = Array.isArray(stored.selectedCategories)
      ? [...new Set(stored.selectedCategories
          .filter((category): category is string => typeof category === "string")
          .map((category) => category.trim().normalize("NFC"))
          .filter(Boolean))]
      : [];
    return { kind: stored.kind as KindFilter, collapsedBands: [...new Set(collapsedBands)], selectedServices, selectedCategories };
  } catch {
    return fallback;
  }
}

async function getLedgerEntriesOnly(): Promise<ReportEntry[]> {
  const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith("entry:"));
  if (!keys.length) return [];
  const stored = await chrome.storage.local.get(keys);
  return keys.map((key) => stored[key]).filter((value): value is ReportEntry => Boolean(value && typeof value === "object"));
}

function buildNewTabIndex(entries: ReportEntry[]): NewTabIndexEntry[] {
  return entries
    .filter((entry) => !entry.archived && (entry.visitCount >= 2 || entry.pinned || entry.later))
    .map(compact)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

function compact(entry: ReportEntry): NewTabIndexEntry {
  const {
    id,
    url,
    path,
    key,
    title,
    group,
    lastSeenAt,
    visitCount,
    pinned,
    archived,
    kind,
    service,
    later,
    laterAt
  } = entry;
  return {
    id,
    url,
    path,
    key,
    title,
    group,
    lastSeenAt,
    visitCount,
    pinned,
    archived,
    kind,
    service,
    later,
    laterAt
  };
}

function searchText(entry: HubEntry): string {
  return `${entry.title}\n${entry.group}\n${entry.path}\n${entry.key}`
    .toLowerCase()
    .normalize("NFC");
}

function faviconUrl(url: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
}

// The SVG hex values below are the approved artwork from spec v0.15.1 and are
// the explicit exception to the rule that raw colors live only in :root.
function PdfTypeIcon() {
  return (
    <svg className="type-icon" data-type-icon="pdf" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 1h5.4L13 5.4v9.1a.9.9 0 0 1-.9.9H3.2a.9.9 0 0 1-.9-.9V1.9a.9.9 0 0 1 .9-.9z" fill="#d93025" />
      <path d="M8.6 1v3.5a.9.9 0 0 0 .9.9H13z" fill="#f6aea9" />
      <text x="7.7" y="12.6" fontSize="5.2" fontWeight="700" fill="#fff" textAnchor="middle"
        fontFamily="Segoe UI, Arial, sans-serif" letterSpacing="-.2">PDF</text>
    </svg>
  );
}

function HtmlTypeIcon() {
  return (
    <svg className="type-icon" data-type-icon="html" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 1h5.4L13 5.4v9.1a.9.9 0 0 1-.9.9H3.2a.9.9 0 0 1-.9-.9V1.9a.9.9 0 0 1 .9-.9z" fill="#12b5cb" />
      <path d="M8.6 1v3.5a.9.9 0 0 0 .9.9H13z" fill="#a1e4ed" />
      <path d="M6.1 8.3 4.7 10l1.4 1.7M9.5 8.3 10.9 10l-1.4 1.7"
        stroke="#fff" strokeWidth="1.15" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WebFallbackIcon() {
  return (
    <svg className="type-icon" data-type-icon="web-fallback" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="#5f6368" strokeWidth="1.2" />
      <ellipse cx="8" cy="8" rx="2.9" ry="6.6" fill="none" stroke="#5f6368" strokeWidth="1.2" />
      <path d="M1.7 6h12.6M1.7 10h12.6" stroke="#5f6368" strokeWidth="1.2" />
    </svg>
  );
}

function ruleColorStyle(rule: ServiceRule | null): React.CSSProperties {
  return { backgroundColor: `var(${rule?.color ?? "--svc-other"})` };
}

function RemoteFavicon({ url }: { url: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) {
    return <WebFallbackIcon />;
  }
  return <img className="favicon" data-type-icon="web-favicon" src={faviconUrl(url)} alt="" onError={() => setFailedUrl(url)} />;
}

function Favicon({ url, rule, kind }: { url: string; rule: ServiceRule | null; kind?: Kind }) {
  if (kind === "pdf") return <PdfTypeIcon />;
  if (kind === "html") return <HtmlTypeIcon />;
  if (url.startsWith("file:")) {
    return <span className="favicon favicon-fallback" style={ruleColorStyle(rule)} aria-hidden="true" />;
  }
  return <RemoteFavicon url={url} />;
}

function rowExtension(entry: HubEntry): string | null {
  if (entry.kind !== "html" && entry.kind !== "pdf") return null;
  return entry.path.match(/\.(?:html?|pdf)$/i)?.[0].toLowerCase() ?? null;
}

function bookmarkBarChildren(tree: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  const rootChildren = tree[0]?.children ?? [];
  const bookmarkBar = rootChildren.find((node) => node.id === "1") ?? rootChildren.find((node) => !node.url);
  return bookmarkBar?.children ?? [];
}

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  return nodes.flatMap((node) => (node.url ? [node] : flattenBookmarks(node.children ?? [])));
}

function bookmarkSearchText(node: chrome.bookmarks.BookmarkTreeNode): string {
  return `${node.title}\n${node.url ?? ""}`.toLowerCase().normalize("NFC");
}

function BookmarkStrip({
  nodes,
  onOpen,
  getRule
}: {
  nodes: chrome.bookmarks.BookmarkTreeNode[];
  onOpen: (url: string) => void;
  getRule: (url: string) => ServiceRule | null;
}) {
  const [openPath, setOpenPath] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [menuLeft, setMenuLeft] = useState(0);
  const stripRef = useRef<HTMLElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const openTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusDropdownRef = useRef(false);
  const currentFolder = openPath.at(-1);

  useEffect(() => {
    if (!currentFolder) return;
    const closeOutside = (event: PointerEvent) => {
      if (!stripRef.current?.contains(event.target as Node)) setOpenPath([]);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        openTriggerRef.current?.focus();
        setOpenPath([]);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [currentFolder]);

  useEffect(() => {
    if (!currentFolder || !focusDropdownRef.current) return;
    focusDropdownRef.current = false;
    dropdownRef.current?.querySelector("button")?.focus();
  }, [currentFolder]);

  const toggleFolder = (node: chrome.bookmarks.BookmarkTreeNode, button: HTMLButtonElement) => {
    if (openPath[0]?.id === node.id) {
      setOpenPath([]);
      return;
    }
    const stripBox = stripRef.current?.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    if (stripBox) setMenuLeft(Math.max(0, Math.min(buttonBox.left - stripBox.left, stripBox.width - 280)));
    openTriggerRef.current = button;
    setOpenPath([node]);
  };

  return (
    <section className="bookmark-strip" data-testid="bookmark-strip" ref={stripRef}>
      <h2 aria-label={S.bookmarks.lead} title={S.bookmarks.lead}><span aria-hidden="true">⭐</span></h2>
      <div className="bookmark-chips" data-testid="bookmark-chips">
        {nodes.length ? (
          nodes.map((node) =>
            node.url ? (
              <button
                key={node.id}
                type="button"
                className="bookmark-chip bookmark-direct"
                data-testid={`bookmark-direct-${node.id}`}
                data-bookmark-id={node.id}
                title={node.title || node.url}
                onClick={() => onOpen(node.url!)}
              >
                <Favicon url={node.url} rule={getRule(node.url)} />
                <span>{node.title || node.url}</span>
              </button>
            ) : (
              <button
                key={node.id}
                type="button"
                className="bookmark-chip bookmark-folder"
                data-testid={`bookmark-folder-${node.id}`}
                data-bookmark-id={node.id}
                title={S.bookmarks.folderHint(node.title, node.children?.length ?? 0)}
                aria-expanded={openPath[0]?.id === node.id}
                aria-controls={openPath[0]?.id === node.id ? "bookmark-dropdown" : undefined}
                onClick={(event) => toggleFolder(node, event.currentTarget)}
              >
                <span>{node.title}</span>
                <span className="bookmark-caret" aria-hidden="true">▾</span>
              </button>
            )
          )
        ) : (
          <p>{S.bookmarks.empty}</p>
        )}
      </div>

      {currentFolder && (
        <div
          className="bookmark-dropdown"
          id="bookmark-dropdown"
          data-testid="bookmark-dropdown"
          role="region"
          aria-label={currentFolder.title}
          ref={dropdownRef}
          style={{ left: menuLeft }}
        >
          {openPath.length > 1 && (
            <button
              type="button"
              className="bookmark-dropdown-back"
              data-testid="bookmark-back"
              onClick={() => {
                focusDropdownRef.current = true;
                setOpenPath((current) => current.slice(0, -1));
              }}
            >
              <span aria-hidden="true">‹</span>
              <span>{S.bookmarks.back}</span>
            </button>
          )}
          {(currentFolder.children ?? []).map((node) =>
            node.url ? (
              <button
                key={node.id}
                type="button"
                className="bookmark-dropdown-link"
                data-testid={`bookmark-item-link-${node.id}`}
                onClick={() => {
                  setOpenPath([]);
                  onOpen(node.url!);
                }}
              >
                <span>{node.title || node.url}</span>
              </button>
            ) : (
              <button
                key={node.id}
                type="button"
                data-testid={`bookmark-item-folder-${node.id}`}
                onClick={() => {
                  focusDropdownRef.current = true;
                  setOpenPath((current) => [...current, node]);
                }}
              >
                <span className="bookmark-dropdown-folder" aria-hidden="true">▸</span>
                <span>{node.title}</span>
              </button>
            )
          )}
          {(currentFolder.children?.length ?? 0) === 0 && <p>{S.bookmarks.empty}</p>}
        </div>
      )}
    </section>
  );
}

function BookmarkResult({
  node,
  onOpen,
  getRule
}: {
  node: chrome.bookmarks.BookmarkTreeNode;
  onOpen: (url: string) => void;
  getRule: (url: string) => ServiceRule | null;
}) {
  const url = node.url!;
  return (
    <button
      type="button"
      className="bookmark-result"
      data-testid={`bookmark-search-${node.id}`}
      data-bookmark-id={node.id}
      title={`${node.title || url}\n${url}`}
      onClick={() => onOpen(url)}
    >
      <span className="bookmark-result-mark" aria-hidden="true">⭐</span>
      <Favicon url={url} rule={getRule(url)} />
      <span className="bookmark-result-copy">{node.title || url}</span>
    </button>
  );
}

interface HubIndexDisplayMatch extends HubIndexMatch {
  url: string;
}

function HubIndexResult({
  match,
  onOpen
}: {
  match: HubIndexDisplayMatch;
  onOpen: (url: string) => void;
}) {
  const { row, url } = match;
  const tags = row.g.slice(0, 3);
  const remainingTags = row.g.length - tags.length;
  const metadata = [row.c, ...tags, remainingTags > 0 ? S.hubIndex.moreTags(remainingTags) : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className="bookmark-result hub-index-result"
      data-testid={`hub-index-${row.i}`}
      data-hub-index-id={row.i}
      data-category={row.c}
      title={`${row.t}\n${row.d}\n${url}`}
      onClick={() => onOpen(url)}
    >
      <HtmlTypeIcon />
      <span className="hub-index-copy">
        <span className="hub-index-title">{row.t}</span>
        <span className="hub-index-meta">{metadata}</span>
      </span>
    </button>
  );
}

function AppRow({
  entry,
  band,
  serviceRule,
  controlsReady,
  onOpen,
  onLater,
  onPin,
  onClose
}: {
  entry: HubEntry;
  band: Band;
  serviceRule: ServiceRule | null;
  controlsReady: boolean;
  onOpen: (entry: HubEntry, band: Band) => void;
  onLater: (entry: HubEntry, band: Band) => void;
  onPin: (entry: HubEntry) => void;
  onClose: (entry: HubEntry, band: Band) => void;
}) {
  const openLabel = band === "open" ? S.action.switchTo : S.action.openNew;
  const extension = rowExtension(entry);
  const laterLabel = band === "later" ? S.action.laterUndo : S.action.later;
  const pinLabel = entry.pinned ? S.action.unpin : S.action.pin;
  return (
    <article
      className="hub-row"
      data-testid={`row-${band}-${entry.id}`}
      data-entry-id={entry.id}
      data-kind={entry.kind}
      data-service-id={serviceRule?.id ?? "other"}
      role="button"
      tabIndex={0}
      aria-label={`${openLabel}: ${entry.title}`}
      onClick={() => onOpen(entry, band)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const rows = [...document.querySelectorAll<HTMLElement>(".hub-row")];
          const index = rows.indexOf(event.currentTarget);
          const target = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
          if (target) {
            event.preventDefault();
            target.focus();
          }
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry, band);
        }
      }}
    >
      <Favicon url={entry.url} rule={serviceRule} kind={entry.kind} />
      <span className="row-body">
        <span className="row-title">{entry.title || fileName(entry.path)}</span>
        {extension && <span className="row-ext">{extension}</span>}
      </span>
      {controlsReady && <span className="row-actions">
        <button
          type="button"
          data-testid={`later-${entry.id}`}
          title={laterLabel}
          aria-label={laterLabel}
          onClick={(event) => {
            event.stopPropagation();
            onLater(entry, band);
          }}
        >
          🕐
        </button>
        <button
          type="button"
          className={`pin-action${entry.pinned ? " is-active" : ""}`}
          data-testid={`pin-${entry.id}`}
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={entry.pinned}
          onClick={(event) => {
            event.stopPropagation();
            onPin(entry);
          }}
        >
          📌
        </button>
        <button
          type="button"
          data-testid={`remove-${entry.id}`}
          title={S.action.remove}
          aria-label={S.action.remove}
          onClick={(event) => {
            event.stopPropagation();
            onClose(entry, band);
          }}
        >
          ×
        </button>
      </span>}
    </article>
  );
}

interface HubGroup {
  key: string;
  name: string;
  kind: Kind;
  entries: HubEntry[];
}

function ledgerColumnCount(width = window.innerWidth): number {
  if (width <= 1050) return 2;
  if (width <= 1400) return 3;
  return 4;
}

function splitGroupColumns(groups: HubGroup[], columnCount: number, isCollapsed: (group: HubGroup) => boolean): HubGroup[][] {
  if (!groups.length) return [];
  const count = Math.min(columnCount, groups.length);
  const weights = groups.map((group) => 36 + (isCollapsed(group) ? 0 : group.entries.length * 24));
  const columns: HubGroup[][] = [];
  let index = 0;
  let remainingWeight = weights.reduce((sum, weight) => sum + weight, 0);
  for (let column = 0; column < count; column += 1) {
    if (column === count - 1) {
      columns.push(groups.slice(index));
      break;
    }
    const target = remainingWeight / (count - column);
    const start = index;
    let weight = 0;
    while (index < groups.length - (count - column - 1)) {
      const nextWeight = weights[index];
      if (index > start && Math.abs(target - weight) <= Math.abs(target - weight - nextWeight)) break;
      weight += nextWeight;
      index += 1;
    }
    columns.push(groups.slice(start, index));
    remainingWeight -= weight;
  }
  return columns;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [index, setIndex] = useState<NewTabIndexEntry[]>([]);
  const [openTabs, setOpenTabs] = useState<HubEntry[]>([]);
  const [fullEntries, setFullEntries] = useState<NewTabIndexEntry[] | null>(null);
  const [bookmarkNodes, setBookmarkNodes] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [serviceRules, setServiceRules] = useState<ServiceRulesStore | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [layout, setLayout] = useState<LayoutState>(readLayoutState);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [tabstripBusy, setTabstripBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [hubIndexState, setHubIndexState] = useState<HubIndexState | null>(null);
  const [ledgerPaths, setLedgerPaths] = useState<string[]>([]);
  const [columnCount, setColumnCount] = useState(ledgerColumnCount);
  const [controlsReady, setControlsReady] = useState(false);
  const fullLoadRef = useRef<Promise<NewTabIndexEntry[]> | null>(null);
  const hubIndexLoadRef = useRef<Promise<HubIndexState> | null>(null);
  const previewCardRef = useRef<HTMLElement>(null);
  const previewTimerRef = useRef<{ id: number; entryId: string } | null>(null);
  const previewEntriesRef = useRef<HubEntry[]>([]);

  const clearPreviewTimer = useCallback((entryId?: string) => {
    if (previewTimerRef.current == null) return;
    if (entryId && previewTimerRef.current.entryId !== entryId) return;
    window.clearTimeout(previewTimerRef.current.id);
    previewTimerRef.current = null;
  }, []);

  const showPreview = useCallback((entry: HubEntry, serviceRule: ServiceRule | null, target: HTMLElement) => {
    clearPreviewTimer();
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const preferredLeft = rect.right + PREVIEW_GAP + PREVIEW_WIDTH <= window.innerWidth - PREVIEW_EDGE
      ? rect.right + PREVIEW_GAP
      : rect.left - PREVIEW_GAP - PREVIEW_WIDTH;
    const left = Math.min(
      Math.max(PREVIEW_EDGE, preferredLeft),
      Math.max(PREVIEW_EDGE, window.innerWidth - PREVIEW_WIDTH - PREVIEW_EDGE)
    );
    setPreview({ entry, serviceRule, target, anchorTop: rect.top, left, top: Math.max(PREVIEW_EDGE, rect.top) });
    if (entry.kind === "html") {
      void import("./preview")
        .then(({ getHtmlPreview }) => getHtmlPreview(entry.id, entry.url))
        .then((html) => {
          setPreview((current) => current?.entry.id === entry.id ? { ...current, html } : current);
        });
    }
  }, [clearPreviewTimer]);

  const schedulePreview = useCallback((entry: HubEntry, serviceRule: ServiceRule | null, target: HTMLElement) => {
    clearPreviewTimer();
    if (entry.kind === "html") void import("./preview");
    const id = window.setTimeout(() => {
      previewTimerRef.current = null;
      if (!target.isConnected || !target.matches(":hover")) return;
      showPreview(entry, serviceRule, target);
    }, PREVIEW_HOVER_DELAY_MS);
    previewTimerRef.current = { id, entryId: entry.id };
  }, [clearPreviewTimer, showPreview]);

  const hidePreview = useCallback((entryId: string, keepVisible: boolean) => {
    clearPreviewTimer(entryId);
    if (keepVisible) return;
    setPreview((current) => current?.entry.id === entryId ? null : current);
  }, [clearPreviewTimer]);

  useLayoutEffect(() => {
    if (!preview || !previewCardRef.current) return;
    const height = previewCardRef.current.getBoundingClientRect().height;
    const maxTop = Math.max(PREVIEW_EDGE, window.innerHeight - height - PREVIEW_EDGE);
    const top = Math.min(Math.max(PREVIEW_EDGE, preview.anchorTop), maxTop);
    if (top === preview.top) return;
    setPreview((current) => current?.entry.id === preview.entry.id ? { ...current, top } : current);
  }, [preview]);

  const previewEntryId = preview?.entry.id;
  const previewTarget = preview?.target;
  useEffect(() => {
    if (!previewEntryId || !previewTarget) return;
    const hide = () => setPreview((current) => current?.entry.id === previewEntryId ? null : current);
    const hideIfDetached = () => {
      if (!previewTarget.isConnected) hide();
    };
    const observer = new MutationObserver(hideIfDetached);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [previewEntryId, previewTarget]);

  useEffect(() => () => clearPreviewTimer(), [clearPreviewTimer]);

  useEffect(() => {
    const id = window.setTimeout(() => setControlsReady(true), 500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const update = () => setColumnCount((current) => {
      const next = ledgerColumnCount();
      return current === next ? current : next;
    });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const loadIndex = useCallback(async (fallbackEntries?: ReportEntry[]) => {
    let next = await getNewTabIndex();
    if (!next) {
      const entries = fallbackEntries ?? await getLedgerEntriesOnly();
      next = buildNewTabIndex(entries);
      await chrome.storage.local.set({ [NEW_TAB_INDEX_KEY]: next });
    }
    setIndex(next);
  }, []);

  const loadFullEntries = useCallback(async (): Promise<NewTabIndexEntry[]> => {
    if (fullLoadRef.current) return fullLoadRef.current;
    fullLoadRef.current = getLedgerEntriesOnly()
      .then((entries) => {
        setLedgerPaths(entries.map((entry) => entry.path));
        return entries.filter((entry) => !entry.archived).map(compact);
      })
      .then((entries) => {
        setFullEntries(entries);
        return entries;
      })
      .finally(() => {
        fullLoadRef.current = null;
      });
    return fullLoadRef.current;
  }, []);

  const ensureHubIndex = useCallback(async (): Promise<HubIndexState> => {
    if (hubIndexState?.api && hubIndexState.snapshot && hubIndexState.api.isHubIndexSnapshotFresh(hubIndexState.snapshot)) {
      return hubIndexState;
    }
    if (hubIndexState && (!hubIndexState.api || !hubIndexState.snapshot)) return hubIndexState;
    if (hubIndexLoadRef.current) return hubIndexLoadRef.current;
    const request = import("./hubindex")
      .then(async (api): Promise<HubIndexState> => ({ api, snapshot: await api.loadHubIndex() }))
      .catch((): HubIndexState => ({ api: null, snapshot: null }))
      .then((state) => {
        setHubIndexState(state);
        return state;
      })
      .finally(() => {
        hubIndexLoadRef.current = null;
      });
    hubIndexLoadRef.current = request;
    return request;
  }, [hubIndexState]);

  const readBookmarks = useCallback(async () => {
    const tree = await chrome.bookmarks.getTree();
    return bookmarkBarChildren(tree);
  }, []);
  const loadBookmarks = useCallback(async () => setBookmarkNodes(await readBookmarks()), [readBookmarks]);

  const readTabs = useCallback(async (currentSettings: Settings, rules: ServiceRule[]) => {
    const tabs = await chrome.tabs.query({});
    return (await Promise.all(tabs.map(async (tab): Promise<HubEntry | null> => {
      const norm = normalizeTarget(tab.url, currentSettings);
      if (!norm || tab.id == null) return null;
      const id = await entryIdFromKey(norm.key);
      return {
        id,
        url: norm.url,
        path: norm.path,
        key: norm.key,
        title: tab.title || fileName(norm.path),
        group: inferGroup(norm.path, currentSettings.groupRules),
        lastSeenAt: tab.lastAccessed ?? Date.now(),
        visitCount: 0,
        pinned: false,
        archived: false,
        kind: norm.kind,
        service: inferService(norm.url, norm.kind, rules),
        later: false,
        laterAt: null,
        tabId: tab.id,
        windowId: tab.windowId,
        chromePinned: tab.pinned
      };
    }))).filter((entry): entry is HubEntry => entry !== null);
  }, []);
  const loadTabs = useCallback(
    async (currentSettings: Settings, rules: ServiceRule[]) => setOpenTabs(await readTabs(currentSettings, rules)),
    [readTabs]
  );

  useEffect(() => {
    document.title = S.documentTitle;
    let cancelled = false;
    void (async () => {
      const bookmarksPromise = readBookmarks();
      const bootstrap = await getNewTabBootstrap();
      const needsMigration = bootstrap.schemaVersion !== 3 || !bootstrap.serviceRules;
      const schemaPromise = needsMigration ? ensureSchemaV3() : Promise.resolve();
      const currentRules: ServiceRulesStore = bootstrap.serviceRules ?? await schemaPromise.then(() => getServiceRules());
      await Promise.all([
        schemaPromise,
        bootstrap.index ? Promise.resolve() : schemaPromise.then(() => loadIndex())
      ]);
      if (bootstrap.schemaVersion !== 3) await loadIndex();
      if (cancelled) return;
      const [initialTabs, initialBookmarks] = await Promise.all([
        readTabs(bootstrap.settings, currentRules.rules),
        bookmarksPromise
      ]);
      if (cancelled) return;
      setSettings(bootstrap.settings);
      setServiceRules(currentRules);
      if (bootstrap.index) setIndex(bootstrap.index);
      setOpenTabs(initialTabs);
      setBookmarkNodes(initialBookmarks);
      await new Promise<void>((resolve) => window.setTimeout(resolve, LEDGER_MAINTENANCE_DELAY_MS));
      if (cancelled) return;
      const entries = await getLedgerEntriesOnly();
      const promotedRules = await promoteServiceRules(entries);
      if (!cancelled && promotedRules.rules.length !== currentRules.rules.length) setServiceRules(promotedRules);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadIndex, readBookmarks, readTabs]);

  useEffect(() => {
    if (!settings) return;
    const storageHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[NEW_TAB_INDEX_KEY]) {
        setFullEntries(null);
        void loadIndex();
      }
      if (area === "local" && changes[SERVICE_RULES_KEY]?.newValue) {
        setServiceRules(changes[SERVICE_RULES_KEY].newValue as ServiceRulesStore);
      }
    };
    const tabHandler = () => {
      if (serviceRules) void loadTabs(settings, serviceRules.rules);
    };
    chrome.storage.onChanged.addListener(storageHandler);
    chrome.tabs.onCreated.addListener(tabHandler);
    chrome.tabs.onRemoved.addListener(tabHandler);
    chrome.tabs.onUpdated.addListener(tabHandler);
    return () => {
      chrome.storage.onChanged.removeListener(storageHandler);
      chrome.tabs.onCreated.removeListener(tabHandler);
      chrome.tabs.onRemoved.removeListener(tabHandler);
      chrome.tabs.onUpdated.removeListener(tabHandler);
    };
  }, [loadIndex, loadTabs, serviceRules, settings]);

  useEffect(() => {
    const refreshBookmarks = () => void loadBookmarks();
    chrome.bookmarks.onCreated.addListener(refreshBookmarks);
    chrome.bookmarks.onChanged.addListener(refreshBookmarks);
    chrome.bookmarks.onRemoved.addListener(refreshBookmarks);
    chrome.bookmarks.onMoved.addListener(refreshBookmarks);
    return () => {
      chrome.bookmarks.onCreated.removeListener(refreshBookmarks);
      chrome.bookmarks.onChanged.removeListener(refreshBookmarks);
      chrome.bookmarks.onRemoved.removeListener(refreshBookmarks);
      chrome.bookmarks.onMoved.removeListener(refreshBookmarks);
    };
  }, [loadBookmarks]);

  useEffect(() => {
    if (!query.trim() || fullEntries) return;
    void loadFullEntries();
  }, [fullEntries, loadFullEntries, query]);

  useEffect(() => {
    if (!query.trim()) return;
    void ensureHubIndex();
  }, [ensureHubIndex, query]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  const merged = useMemo(() => {
    const base = query.trim() && fullEntries ? fullEntries : index;
    const byKey = new Map<string, HubEntry>(base.map((entry) => [entry.key, entry]));
    for (const tab of openTabs) {
      const stored = byKey.get(tab.key);
      byKey.set(
        tab.key,
        stored
          ? {
              ...stored,
              url: tab.url,
              title: tab.title || stored.title,
              tabId: tab.tabId,
              windowId: tab.windowId,
              chromePinned: tab.chromePinned
            }
          : tab
      );
    }
    const needle = query.trim().toLowerCase().normalize("NFC");
    return [...byKey.values()].filter((entry) => !needle || searchText(entry).includes(needle));
  }, [fullEntries, index, openTabs, query]);

  const bookmarkEntries = useMemo(() => flattenBookmarks(bookmarkNodes), [bookmarkNodes]);
  const bookmarkMatches = useMemo(() => {
    const needle = query.trim().toLowerCase().normalize("NFC");
    return needle ? bookmarkEntries.filter((node) => bookmarkSearchText(node).includes(needle)) : [];
  }, [bookmarkEntries, query]);

  const openKeys = useMemo(() => new Set(openTabs.map((entry) => entry.key)), [openTabs]);
  const visibleByBand = useCallback(
    (entry: HubEntry, band: Band) => {
      if (band === "open") return entry.tabId != null;
      if (band === "later") return entry.later;
      if (entry.later || openKeys.has(entry.key)) return false;
      if (query.trim()) return true;
      return entry.pinned || Date.now() - entry.lastSeenAt < SILENT_AFTER_MS;
    },
    [openKeys, query]
  );

  const visibleEntries = useMemo(
    () => merged.filter((entry) => BANDS.some((band) => visibleByBand(entry, band))),
    [merged, visibleByBand]
  );
  previewEntriesRef.current = visibleEntries;

  const kindCounts = useMemo(() => {
    const counts = { all: visibleEntries.length, web: 0, html: 0, pdf: 0 };
    for (const entry of visibleEntries) counts[entry.kind] += 1;
    return counts;
  }, [visibleEntries]);

  const fallbackServiceRule = useMemo(
    () => serviceRules?.rules.find((rule) => rule.id === "other") ?? null,
    [serviceRules]
  );
  const getRuleForUrl = useCallback(
    (url: string) => matchServiceRule(url, serviceRules?.rules ?? []) ?? fallbackServiceRule,
    [fallbackServiceRule, serviceRules]
  );
  const getRuleForEntry = useCallback(
    (entry: HubEntry) => entry.kind === "web" ? getRuleForUrl(entry.url) : fallbackServiceRule,
    [fallbackServiceRule, getRuleForUrl]
  );
  const getPreviewRule = useCallback(
    (entry: HubEntry) => /^https?:\/\//i.test(entry.url) ? getRuleForUrl(entry.url) : getRuleForEntry(entry),
    [getRuleForEntry, getRuleForUrl]
  );
  const previewRow = useCallback((target: EventTarget | null) => {
    return target instanceof Element ? target.closest<HTMLElement>(".hub-row[data-entry-id]") : null;
  }, []);
  const previewEntryForRow = useCallback((row: HTMLElement) => {
    const entryId = row.dataset.entryId;
    return entryId ? previewEntriesRef.current.find((entry) => entry.id === entryId) ?? null : null;
  }, []);
  const handlePreviewMouseOver = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const row = previewRow(event.target);
    if (!row || (event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) return;
    const entry = previewEntryForRow(row);
    if (entry) schedulePreview(entry, getPreviewRule(entry), row);
  }, [getPreviewRule, previewEntryForRow, previewRow, schedulePreview]);
  const handlePreviewMouseOut = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const row = previewRow(event.target);
    if (!row || (event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) return;
    hidePreview(row.dataset.entryId ?? "", row.contains(document.activeElement));
  }, [hidePreview, previewRow]);
  const handlePreviewFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const row = previewRow(event.target);
    if (!row || (event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) return;
    const entry = previewEntryForRow(row);
    if (entry) showPreview(entry, getPreviewRule(entry), row);
  }, [getPreviewRule, previewEntryForRow, previewRow, showPreview]);
  const handlePreviewBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const row = previewRow(event.target);
    if (!row || (event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) return;
    hidePreview(row.dataset.entryId ?? "", row.matches(":hover"));
  }, [hidePreview, previewRow]);

  const kindFilteredEntries = useMemo(
    () =>
      layout.kind === "all"
        ? visibleEntries
        : visibleEntries.filter((entry) => entry.kind === layout.kind),
    [layout.kind, visibleEntries]
  );

  const serviceChips = useMemo(() => {
    if (!serviceRules) return [];
    const counts = new Map<string, number>();
    for (const entry of kindFilteredEntries) {
      if (entry.kind !== "web") continue;
      const id = getRuleForEntry(entry)?.id ?? "other";
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const order = new Map(serviceRules.rules.map((rule, index) => [rule.id, index]));
    return serviceRules.rules
      .filter((rule) => (counts.get(rule.id) ?? 0) > 0)
      .map((rule) => ({ rule, count: counts.get(rule.id) ?? 0 }))
      .sort((left, right) => right.count - left.count || (order.get(left.rule.id) ?? 0) - (order.get(right.rule.id) ?? 0));
  }, [getRuleForEntry, kindFilteredEntries, serviceRules]);

  const serviceFilteredEntries = useMemo(() => {
    const selected = new Set(layout.selectedServices);
    if (!selected.size || layout.kind === "html" || layout.kind === "pdf") return kindFilteredEntries;
    return kindFilteredEntries.filter(
      (entry) => entry.kind === "web" && selected.has(getRuleForEntry(entry)?.id ?? "other")
    );
  }, [getRuleForEntry, kindFilteredEntries, layout.kind, layout.selectedServices]);

  const hubIndexMatches = useMemo<HubIndexDisplayMatch[]>(() => {
    const api = hubIndexState?.api;
    const snapshot = hubIndexState?.snapshot;
    if (!query.trim() || !fullEntries || !api || !snapshot) return [];
    const ledgerIdentities = new Set(
      [...ledgerPaths, ...openTabs.map((entry) => entry.path)]
        .map((path) => api.hubIndexIdentityFromPath(path))
        .filter((identity): identity is string => Boolean(identity))
    );
    return api.searchHubIndex(snapshot.rows, query)
      .filter((match) => {
        const identity = api.hubIndexIdentityFromPath(match.row.p);
        return !identity || !ledgerIdentities.has(identity);
      })
      .map((match) => ({ ...match, url: api.hubIndexRowUrl(match.row, snapshot.sourceUrl) }))
      .filter((match): match is HubIndexDisplayMatch => typeof match.url === "string");
  }, [fullEntries, hubIndexState, ledgerPaths, openTabs, query]);

  const kindServiceHubMatches = useMemo(() => {
    if ((layout.kind !== "all" && layout.kind !== "html") || (layout.kind === "all" && layout.selectedServices.length > 0)) return [];
    return hubIndexMatches;
  }, [hubIndexMatches, layout.kind, layout.selectedServices.length]);

  const categoryChips = useMemo(() => {
    if (!query.trim() && layout.selectedCategories.length === 0) return [];
    const counts = new Map<string, number>();
    if (layout.kind !== "web") {
      for (const entry of serviceFilteredEntries) {
        if (entry.kind === "web") continue;
        const category = entry.group.trim().normalize("NFC");
        if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
      }
      for (const match of kindServiceHubMatches) {
        const category = match.row.c;
        if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
      }
      for (const category of layout.selectedCategories) {
        if (!counts.has(category)) counts.set(category, 0);
      }
    }
    return [...counts]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
  }, [kindServiceHubMatches, layout.kind, layout.selectedCategories, query, serviceFilteredEntries]);

  const filteredEntries = useMemo(() => {
    if (layout.kind === "web" || layout.selectedCategories.length === 0) return serviceFilteredEntries;
    const selected = new Set(layout.selectedCategories);
    return serviceFilteredEntries.filter((entry) => selected.has(entry.group.trim().normalize("NFC")));
  }, [layout.kind, layout.selectedCategories, serviceFilteredEntries]);

  const filteredHubIndexMatches = useMemo(() => {
    if (layout.selectedCategories.length === 0) return kindServiceHubMatches;
    const selected = new Set(layout.selectedCategories);
    return kindServiceHubMatches.filter((match) => selected.has(match.row.c));
  }, [kindServiceHubMatches, layout.selectedCategories]);

  const visibleHubIndexMatches = filteredHubIndexMatches.slice(0, 40);
  const remainingHubIndexMatches = filteredHubIndexMatches.length - visibleHubIndexMatches.length;

  const rowsByBand = useMemo(
    () => ({
      open: filteredEntries.filter((entry) => visibleByBand(entry, "open")),
      recent: filteredEntries.filter((entry) => visibleByBand(entry, "recent")),
      later: filteredEntries.filter((entry) => visibleByBand(entry, "later"))
    }),
    [filteredEntries, visibleByBand]
  );

  const ensureStored = useCallback(
    async (entry: HubEntry): Promise<ReportEntry> => {
      const existing = await getEntry(entry.id);
      if (existing) return existing;
      if (!settings) throw new Error("settings unavailable");
      const now = Date.now();
      const created: ReportEntry = {
        ...entry,
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: Math.max(1, entry.visitCount),
        pinned: false,
        archived: false,
        missing: false,
        missingCheckedAt: now,
        source: "live",
        later: false,
        laterAt: null
      };
      await putEntry(created);
      return created;
    },
    [settings]
  );

  const openEntry = useCallback(async (entry: HubEntry, band: Band) => {
    if (band === "open" && entry.tabId != null && entry.windowId != null) {
      await chrome.tabs.update(entry.tabId, { active: true });
      await chrome.windows.update(entry.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url: entry.url });
    if (entry.later) await patchEntry(entry.id, { later: false, laterAt: null });
  }, []);

  const moveLater = useCallback(
    async (entry: HubEntry, band: Band) => {
      const ts = Date.now();
      if (band === "recent") {
        await patchEntry(entry.id, { later: true, laterAt: ts });
        return;
      }
      if (band === "later") {
        await patchEntry(entry.id, {
          later: false,
          laterAt: null,
          lastSeenAt: ts,
          visitCount: Math.max(2, entry.visitCount)
        });
        return;
      }
      if (entry.tabId == null) return;
      await ensureStored(entry);
      await patchEntry(entry.id, { later: true, laterAt: ts });
      const snapshot: UndoSnapshot = { urls: [entry.url], label: S.band.later, ts };
      await chrome.storage.local.set({ [UNDO_KEY]: snapshot });
      await chrome.tabs.remove(entry.tabId);
      setToast({ text: S.toast.closedOne(entry.title), undo: { entry, ts } });
    },
    [ensureStored]
  );

  const togglePinned = useCallback(
    async (entry: HubEntry) => {
      await ensureStored(entry);
      await patchEntry(entry.id, { pinned: !entry.pinned });
    },
    [ensureStored]
  );

  const removeEntry = useCallback(async (entry: HubEntry) => {
    await removeEntries([entry.id]);
    setToast({ text: S.toast.removedOne(entry.title) });
  }, []);

  const closeEntry = useCallback(async (entry: HubEntry, band: Band) => {
    if (band !== "open") {
      await removeEntry(entry);
      return;
    }
    const targets = openTabs.filter((tab) => tab.key === entry.key && tab.tabId != null);
    if (!targets.length) return;
    const ts = Date.now();
    const snapshot: UndoSnapshot = { urls: targets.map((tab) => tab.url), label: entry.title, ts };
    await chrome.storage.local.set({ [UNDO_KEY]: snapshot });
    await chrome.tabs.remove(targets.map((tab) => tab.tabId!));
    setToast({ text: S.group.closedToast(entry.title, targets.length) });
  }, [openTabs, removeEntry]);

  const handleRowOpen = useCallback((entry: HubEntry, band: Band) => {
    hidePreview(entry.id, false);
    void openEntry(entry, band);
  }, [hidePreview, openEntry]);

  const handleRowLater = useCallback((entry: HubEntry, band: Band) => {
    hidePreview(entry.id, false);
    void moveLater(entry, band);
  }, [hidePreview, moveLater]);

  const handleRowPin = useCallback((entry: HubEntry) => {
    hidePreview(entry.id, false);
    void togglePinned(entry);
  }, [hidePreview, togglePinned]);

  const handleRowClose = useCallback((entry: HubEntry, band: Band) => {
    hidePreview(entry.id, false);
    void closeEntry(entry, band);
  }, [closeEntry, hidePreview]);

  const undoLater = useCallback(async () => {
    if (!toast?.undo) return;
    const { entry, ts } = toast.undo;
    await chrome.tabs.create({ url: entry.url });
    await patchEntry(entry.id, { later: false, laterAt: null });
    const got = await chrome.storage.local.get(UNDO_KEY);
    const current = got[UNDO_KEY] as UndoSnapshot | undefined;
    if (current?.ts === ts) await chrome.storage.local.remove(UNDO_KEY);
    setToast(null);
  }, [toast]);

  const onSearchKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      const text = query.trim();
      if (!text) return;
      let hasMatch = merged.length > 0 || bookmarkMatches.length > 0;
      if (!fullEntries) {
        const needle = text.toLowerCase().normalize("NFC");
        const full = await loadFullEntries();
        hasMatch = hasMatch || [...full, ...openTabs].some((entry) => searchText(entry).includes(needle));
      }
      const currentHubIndex = await ensureHubIndex();
      if (currentHubIndex.api && currentHubIndex.snapshot) {
        hasMatch = hasMatch || currentHubIndex.api.searchHubIndex(currentHubIndex.snapshot.rows, text).length > 0;
      }
      if (!hasMatch) {
        await chrome.search.query({ text, disposition: "CURRENT_TAB" });
      }
    },
    [bookmarkMatches.length, ensureHubIndex, fullEntries, loadFullEntries, merged.length, openTabs, query]
  );

  const selectKind = useCallback((kind: KindFilter) => {
    setLayout((current) => ({ ...current, kind }));
  }, []);

  const toggleService = useCallback((id: string) => {
    setLayout((current) => {
      const selected = new Set(current.selectedServices);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...current, selectedServices: [...selected] };
    });
  }, []);

  const toggleCategory = useCallback((category: string) => {
    setLayout((current) => {
      const selected = new Set(current.selectedCategories);
      if (selected.has(category)) selected.delete(category);
      else selected.add(category);
      return { ...current, selectedCategories: [...selected] };
    });
  }, []);

  const toggleBand = useCallback((band: CollapsibleBand) => {
    setLayout((current) => {
      const collapsed = new Set(current.collapsedBands);
      if (collapsed.has(band)) collapsed.delete(band);
      else collapsed.add(band);
      return { ...current, collapsedBands: COLLAPSIBLE_BANDS.filter((item) => collapsed.has(item)) };
    });
  }, []);

  const openBookmark = useCallback(async (url: string) => {
    await chrome.tabs.create({ url, active: true });
  }, []);

  const openHubIndexEntry = useCallback(async (url: string) => {
    await chrome.tabs.create({ url, active: true });
  }, []);

  const runTabstripAction = useCallback(async (action: "collapse-hub-tabs" | "expand-hub-tabs") => {
    setTabstripBusy(true);
    try {
      const hubTab = await chrome.tabs.getCurrent();
      if (hubTab?.id == null) throw new Error("Hub tab is unavailable");
      const result = (await chrome.runtime.sendMessage({
        type: action,
        windowId: hubTab.windowId,
        hubTabId: hubTab.id,
        kindScope: "all"
      })) as {
        changed: number;
        skipped: { reason: string; count: number }[];
        failed: { tabId: number; reason: string }[];
      } | {
        ok: false;
        error?: string;
      };
      if ("ok" in result) throw new Error(result.error ?? action);
      const count = result.changed;
      setToast({
        text:
          action === "collapse-hub-tabs"
            ? count > 0
              ? S.tabstrip.collapsedToast(count)
              : S.tabstrip.nothingToCollapse
            : S.tabstrip.expandedToast(count)
      });
    } catch (error) {
      console.error("Tab strip action failed", error);
    } finally {
      setTabstripBusy(false);
    }
  }, []);

  const pinned = merged.filter((entry) => entry.pinned || entry.chromePinned);
  const ledgerCount = (query.trim() && fullEntries ? fullEntries : index).length;

  const groupRows = useCallback((rows: HubEntry[]): HubGroup[] => {
    const staged = new Map<string, HubGroup>();
    for (const entry of rows) {
      let key: string;
      let name: string;
      if (entry.kind === "web") {
        const rule = getRuleForEntry(entry);
        key = `web:service:${rule?.id ?? "other"}`;
        name = rule?.label ?? S.service.other;
      } else {
        name = entry.group === FALLBACK_GROUP ? S.group.misc : entry.group;
        key = `${entry.kind}:${name}`;
      }
      const group = staged.get(key);
      if (group) group.entries.push(entry);
      else staged.set(key, { key, name, kind: entry.kind, entries: [entry] });
    }

    return [...staged.values()].flatMap((group) => {
      if (group.kind !== "web") return [group];

      const hostCounts = new Map<string, number>();
      for (const entry of group.entries) {
        const host = serviceHostname(entry.url);
        if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
      }
      const splitHosts = new Set(
        [...hostCounts].filter(([, count]) => count >= 3).map(([host]) => host)
      );
      if (!splitHosts.size) return [group];

      const hostGroups = new Map<string, HubGroup>();
      const serviceEntries: HubEntry[] = [];
      for (const entry of group.entries) {
        const host = serviceHostname(entry.url);
        if (!host || !splitHosts.has(host)) {
          serviceEntries.push(entry);
          continue;
        }
        const key = `${group.key}:host:${host}`;
        const hostGroup = hostGroups.get(key);
        if (hostGroup) hostGroup.entries.push(entry);
        else hostGroups.set(key, { key, name: host, kind: entry.kind, entries: [entry] });
      }

      const groups = [...hostGroups.values()];
      if (serviceEntries.length) groups.push({ ...group, entries: serviceEntries });
      return groups;
    });
  }, [getRuleForEntry]);

  const groupsByBand = useMemo(
    () => ({
      open: groupRows(rowsByBand.open),
      recent: groupRows(rowsByBand.recent),
      later: groupRows(rowsByBand.later)
    }),
    [groupRows, rowsByBand]
  );

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }, []);

  const closeGroup = useCallback(async (group: HubGroup) => {
    const keys = new Set(group.entries.map((entry) => entry.key));
    const targets = openTabs.filter((entry) => keys.has(entry.key) && entry.tabId != null);
    if (!targets.length) return;
    const ts = Date.now();
    const snapshot: UndoSnapshot = { urls: targets.map((entry) => entry.url), label: group.name, ts };
    await chrome.storage.local.set({ [UNDO_KEY]: snapshot });
    await chrome.tabs.remove(targets.map((entry) => entry.tabId!));
    setToast({ text: S.group.closedToast(group.name, targets.length) });
  }, [openTabs]);

  const renderLedgerBand = (band: Band) => {
    const rows = rowsByBand[band];
    const groups = groupsByBand[band];
    const collapsed = layout.collapsedBands.includes(band);
    const groupColumns = splitGroupColumns(
      groups,
      columnCount,
      (group) => collapsedGroups.includes(`${band}:${group.key}`)
    );
    return (
      <section
        className="band"
        key={band}
        data-testid={`band-${band}`}
        data-collapsed={collapsed ? "true" : "false"}
      >
        <h3>
          <button
            type="button"
            data-testid={`band-toggle-${band}`}
            title={collapsed ? S.band.expand : S.band.collapse}
            aria-expanded={!collapsed}
            onClick={() => toggleBand(band)}
          >
            <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
            <span>{S.band[band]}</span>
            <span className="band-count" data-testid={`band-count-${band}`}>{rows.length}</span>
            <span className="band-line" aria-hidden="true" />
          </button>
        </h3>
        {!collapsed && rows.length > 0 && (
          <div
            className="band-rows ledger-band-rows"
            data-testid={`band-rows-${band}`}
            style={{ gridTemplateColumns: `repeat(${groupColumns.length}, minmax(0, 1fr))` }}
          >
            {groupColumns.map((column, columnIndex) => (
              <div className="ledger-band-column" key={`${band}:column:${columnIndex}`}>
                {column.map((group) => {
                  const collapseKey = `${band}:${group.key}`;
                  const groupCollapsed = collapsedGroups.includes(collapseKey);
                  return (
                    <section className="hub-group" data-group-key={group.key} key={collapseKey}>
                  <div className="group-header">
                    <span className={`group-dot group-dot-${group.kind}`} aria-hidden="true" />
                    <span className="group-title">{group.name}</span>
                    <span className="group-count">{group.entries.length}</span>
                    {controlsReady && <span className="group-actions">
                      <button
                        type="button"
                        className="group-collapse-action"
                        data-testid={`group-toggle-${collapseKey}`}
                        title={groupCollapsed ? S.group.expand : S.group.collapse}
                        aria-label={groupCollapsed ? S.group.expand : S.group.collapse}
                        aria-expanded={!groupCollapsed}
                        onClick={() => toggleGroup(collapseKey)}
                      >
                        {groupCollapsed ? "▸" : "▾"}
                      </button>
                      {band === "open" && (
                        <button
                          type="button"
                          className="group-close-action"
                          data-testid={`group-close-${collapseKey}`}
                          title={S.group.closeAll}
                          aria-label={S.group.closeAll}
                          onClick={() => void closeGroup(group)}
                        >
                          ×
                        </button>
                      )}
                    </span>}
                  </div>
                  {!groupCollapsed && group.entries.map((entry) => (
                    <AppRow
                      key={`${band}-${entry.id}`}
                      entry={entry}
                      band={band}
                      serviceRule={getRuleForEntry(entry)}
                      controlsReady={controlsReady}
                      onOpen={handleRowOpen}
                      onLater={handleRowLater}
                      onPin={handleRowPin}
                      onClose={handleRowClose}
                    />
                  ))}
                    </section>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const previewShapeParts: string[] = [];
  const previewShape = preview?.html?.shape;
  if (previewShape?.headings) previewShapeParts.push(S.preview.shapeHeadings(previewShape.headings));
  if (previewShape?.tables) previewShapeParts.push(S.preview.shapeTables(previewShape.tables, previewShape.maxTableRows));
  if (previewShape && (previewShape.ok || previewShape.warn || previewShape.ng)) {
    previewShapeParts.push(S.preview.shapeChips(previewShape.ok, previewShape.warn, previewShape.ng));
  }
  if (previewShape?.figures) previewShapeParts.push(S.preview.shapeFigures(previewShape.figures));

  const previewDays = preview ? Math.max(0, Math.floor((Date.now() - preview.entry.lastSeenAt) / (24 * 60 * 60 * 1000))) : 0;
  const previewStatuses = preview
    ? [
        S.preview.ago(previewDays),
        S.preview.visits(preview.entry.visitCount),
        preview.entry.pinned || preview.entry.chromePinned ? `📌 ${S.preview.pinned}` : null,
        preview.entry.later ? `🕐 ${S.preview.later}` : null
      ].filter((value): value is string => value !== null)
    : [];
  const previewIsRemote = preview ? /^https?:\/\//i.test(preview.entry.url) : false;

  return (
    <main
      className="hub-shell"
      data-testid="hub-shell"
      data-ready={settings && serviceRules ? "true" : "false"}
      onMouseOver={handlePreviewMouseOver}
      onMouseOut={handlePreviewMouseOut}
      onFocus={handlePreviewFocus}
      onBlur={handlePreviewBlur}
    >
      <header className="hub-header">
        <div className="hub-top">
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              autoFocus
              data-testid="hub-search"
              value={query}
              placeholder={S.search.placeholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => void onSearchKeyDown(event)}
            />
            {query && (
              <button
                type="button"
                title={S.search.clear}
                aria-label={S.search.clear}
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </label>
          <div className="kind-tabs" data-testid="kind-tabs" role="tablist" aria-label={S.tabs.label}>
            {KIND_FILTERS.map((kind) => {
              const label = S.kind[kind];
              const count = kindCounts[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className={`kind-tab kind-tab-${kind}`}
                  data-testid={`kind-tab-${kind}`}
                  role="tab"
                  aria-selected={layout.kind === kind}
                  title={kind === "all" ? S.tabs.allHint(count) : S.tabs.hint(label, count)}
                  onClick={() => selectKind(kind)}
                >
                  <span>{label}</span>
                  <span className="kind-count">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="tabstrip-actions">
            <button
              type="button"
              data-testid="tabstrip-collapse"
              title={S.tabstrip.collapseHint}
              disabled={tabstripBusy}
              onClick={() => void runTabstripAction("collapse-hub-tabs")}
            >
              {S.tabstrip.collapse}
            </button>
            <button
              type="button"
              data-testid="tabstrip-expand"
              title={S.tabstrip.expandHint}
              disabled={tabstripBusy}
              onClick={() => void runTabstripAction("expand-hub-tabs")}
            >
              {S.tabstrip.expand}
            </button>
          </div>
        </div>
        {query.trim() && hubIndexState && merged.length === 0 && bookmarkMatches.length === 0 && hubIndexMatches.length === 0 && (
          <p className="search-hint">{S.search.fallbackHint}</p>
        )}
        {(layout.kind === "all" || layout.kind === "web") && serviceChips.length > 0 && (
          <div className="service-chips" data-testid="service-chips">
            {serviceChips.map(({ rule, count }) => {
              const selected = layout.selectedServices.includes(rule.id);
              return (
                <button
                  key={rule.id}
                  type="button"
                  className="service-chip"
                  data-testid={`service-chip-${rule.id}`}
                  data-service-id={rule.id}
                  data-count={count}
                  aria-pressed={selected}
                  onClick={() => toggleService(rule.id)}
                >
                  <span className="service-dot" style={ruleColorStyle(rule)} aria-hidden="true" />
                  <span>{rule.label}</span>
                  <span className="service-count">{count}</span>
                </button>
              );
            })}
          </div>
        )}
        {(query.trim() || layout.selectedCategories.length > 0) && layout.kind !== "web" && categoryChips.length > 0 && (
          <div className="service-chips category-chips" data-testid="category-chips" aria-label={S.category.label}>
            <span className="category-chips-label">{S.category.label}</span>
            {categoryChips.map(({ category, count }) => {
              const selected = layout.selectedCategories.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  className="service-chip category-chip"
                  data-testid={`category-chip-${category}`}
                  data-category={category}
                  data-count={count}
                  aria-pressed={selected}
                  onClick={() => toggleCategory(category)}
                >
                  <span>{category}</span>
                  <span className="service-count">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {(bookmarkNodes.length > 0 || pinned.length > 0) && (
        <div className="shortcut-strip" data-testid="shortcut-strip">
          {bookmarkNodes.length > 0 && (
            <BookmarkStrip nodes={bookmarkNodes} onOpen={(url) => void openBookmark(url)} getRule={getRuleForUrl} />
          )}
          {pinned.length > 0 && (
            <section className="pinned-strip" data-testid="pinned-strip">
              <h1 aria-label={S.pinned.heading} title={S.pinned.heading}><span aria-hidden="true">📌</span></h1>
              <div className="pinned-list">
                {pinned.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    data-pinned-entry-id={entry.id}
                    onClick={() => void openEntry(entry, entry.tabId != null ? "open" : "recent")}
                  >
                    <Favicon url={entry.url} rule={getRuleForEntry(entry)} kind={entry.kind} />
                    <span>{entry.title}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {index.length === 0 && openTabs.length === 0 && !query.trim() ? (
        <section className="first-run">
          <span aria-hidden="true">⌁</span>
          <h2>{S.firstRun.heading}</h2>
          <p>{S.firstRun.body}</p>
        </section>
      ) : (
        <section className="hub-list" data-testid="hub-list">
          <div className="band-list">
            {(["open", "recent"] as Band[]).map(renderLedgerBand)}
            {query.trim() && bookmarkMatches.length > 0 && (
              <section
                className="band bookmark-search-band"
                data-testid="band-bookmarks"
                data-collapsed={layout.collapsedBands.includes("bookmarks") ? "true" : "false"}
              >
                <h3>
                  <button
                    type="button"
                    data-testid="band-toggle-bookmarks"
                    title={layout.collapsedBands.includes("bookmarks") ? S.band.expand : S.band.collapse}
                    aria-expanded={!layout.collapsedBands.includes("bookmarks")}
                    onClick={() => toggleBand("bookmarks")}
                  >
                    <span aria-hidden="true">{layout.collapsedBands.includes("bookmarks") ? "▸" : "▾"}</span>
                     <span><span aria-hidden="true">⭐</span> {S.bookmarks.band}</span>
                     <span className="band-count" data-testid="band-count-bookmarks">{bookmarkMatches.length}</span>
                     <span className="band-line" aria-hidden="true" />
                  </button>
                </h3>
                {!layout.collapsedBands.includes("bookmarks") && (
                  <div className="band-rows" data-testid="band-rows-bookmarks">
                    {bookmarkMatches.map((node) => (
                      <BookmarkResult key={node.id} node={node} onOpen={(url) => void openBookmark(url)} getRule={getRuleForUrl} />
                    ))}
                  </div>
                )}
              </section>
            )}
            {query.trim() && filteredHubIndexMatches.length > 0 && (
              <section
                className="band hub-index-band"
                data-testid="band-hub-index"
                data-collapsed={layout.collapsedBands.includes("hubIndex") ? "true" : "false"}
              >
                <h3>
                  <button
                    type="button"
                    data-testid="band-toggle-hub-index"
                    title={layout.collapsedBands.includes("hubIndex") ? S.band.expand : S.band.collapse}
                    aria-expanded={!layout.collapsedBands.includes("hubIndex")}
                    onClick={() => toggleBand("hubIndex")}
                  >
                    <span aria-hidden="true">{layout.collapsedBands.includes("hubIndex") ? "▸" : "▾"}</span>
                    <span><span aria-hidden="true">📚</span> {S.hubIndex.band}</span>
                    <span className="band-count" data-testid="band-count-hub-index">{filteredHubIndexMatches.length}</span>
                    <span className="band-line" aria-hidden="true" />
                  </button>
                </h3>
                {!layout.collapsedBands.includes("hubIndex") && (
                  <div className="band-rows" data-testid="band-rows-hub-index">
                    {visibleHubIndexMatches.map((match) => (
                      <HubIndexResult key={match.row.i} match={match} onOpen={(url) => void openHubIndexEntry(url)} />
                    ))}
                    {remainingHubIndexMatches > 0 && (
                      <p className="hub-index-more" data-testid="hub-index-more">{S.hubIndex.more(remainingHubIndexMatches)}</p>
                    )}
                  </div>
                )}
              </section>
            )}
            {renderLedgerBand("later")}
            {filteredEntries.length === 0 && bookmarkMatches.length === 0 && filteredHubIndexMatches.length === 0 && (
              <p className="empty-list" data-testid="empty-filtered">
                {S.empty.filtered(S.kind[layout.kind])}
              </p>
            )}
          </div>
        </section>
      )}

      <footer>
        <span>{S.footer.counts(openTabs.length, ledgerCount)}</span>
        <button
          type="button"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") })}
        >
          {S.footer.settings}
        </button>
      </footer>

      {preview && (
        <aside
          ref={previewCardRef}
          className="preview-card"
          data-testid="preview-card"
          data-preview-entry-id={preview.entry.id}
          role="tooltip"
          style={{ left: preview.left, top: preview.top }}
        >
          <h2 data-testid="preview-title">{preview.entry.title || fileName(preview.entry.path)}</h2>
          <div className="preview-meta preview-source" data-testid="preview-source">
            {previewIsRemote ? (
              <>
                <span className="preview-badge">
                  <span className="preview-badge-dot" style={ruleColorStyle(preview.serviceRule)} aria-hidden="true" />
                  {preview.serviceRule?.label ?? S.service.other}
                </span>
                <span>{serviceHostname(preview.entry.url) ?? preview.entry.path}</span>
              </>
            ) : (
              <>
                <span className="preview-badge">{preview.entry.group}</span>
                <span>{parentDir(preview.entry.path)}</span>
              </>
            )}
          </div>
          <div className="preview-meta" data-testid="preview-activity">{previewStatuses.join(" · ")}</div>
          {preview.entry.kind === "html" && preview.html?.excerpt && (
            <p className="preview-excerpt" data-testid="preview-excerpt">{preview.html.excerpt}</p>
          )}
          {preview.entry.kind === "html" && previewShapeParts.length > 0 && (
            <div className="preview-shape" data-testid="preview-shape">{previewShapeParts.join(" · ")}</div>
          )}
        </aside>
      )}

      {toast && (
        <aside className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => void undoLater()}>{S.toast.undo}</button>}
        </aside>
      )}
    </main>
  );
}
