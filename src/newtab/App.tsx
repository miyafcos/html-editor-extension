import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  NEW_TAB_INDEX_KEY,
  SERVICE_RULES_KEY,
  ensureSchemaV3,
  getAllEntries,
  getEntry,
  getNewTabIndex,
  getSettings,
  patchEntry,
  putEntry,
  promoteServiceRules,
  rebuildNewTabIndex,
  removeEntries
} from "../reporthub/repo";
import { UNDO_KEY } from "../reporthub/tabops";
import {
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
import { getHtmlPreview, type HtmlPreviewData } from "./preview";
import { S } from "./strings";

type Kind = ReportEntry["kind"];
type KindFilter = "all" | Kind;
type Band = "open" | "recent" | "later";
type CollapsibleBand = Band | "bookmarks";

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

const KINDS: Kind[] = ["web", "html", "pdf"];
const KIND_FILTERS: KindFilter[] = ["all", ...KINDS];
const BANDS: Band[] = ["open", "recent", "later"];
const COLLAPSIBLE_BANDS: CollapsibleBand[] = ["open", "recent", "bookmarks", "later"];
const SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LAYOUT_STORAGE_KEY = "tabhub:layout";
const PREVIEW_WIDTH = 340;
const PREVIEW_GAP = 10;
const PREVIEW_EDGE = 8;
const PREVIEW_HOVER_DELAY_MS = 200;

interface LayoutState {
  kind: KindFilter;
  collapsedBands: CollapsibleBand[];
  selectedServices: string[];
}

function readLayoutState(): LayoutState {
  const fallback: LayoutState = { kind: "all", collapsedBands: [], selectedServices: [] };
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
    return { kind: stored.kind as KindFilter, collapsedBands: [...new Set(collapsedBands)], selectedServices };
  } catch {
    return fallback;
  }
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

function ruleColorStyle(rule: ServiceRule | null): React.CSSProperties {
  return { backgroundColor: `var(${rule?.color ?? "--svc-other"})` };
}

function Favicon({ url, rule }: { url: string; rule: ServiceRule | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (url.startsWith("file:") || failed) {
    return <span className="favicon favicon-fallback" style={ruleColorStyle(rule)} aria-hidden="true" />;
  }
  return <img className="favicon" src={faviconUrl(url)} alt="" onError={() => setFailed(true)} />;
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

function AppRow({
  entry,
  band,
  serviceRule,
  onOpen,
  onLater,
  onClose
}: {
  entry: HubEntry;
  band: Band;
  serviceRule: ServiceRule | null;
  onOpen: (entry: HubEntry, band: Band) => void;
  onLater: (entry: HubEntry) => void;
  onClose: (entry: HubEntry, band: Band) => void;
}) {
  const openLabel = band === "open" ? S.action.switchTo : S.action.openNew;
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
      <Favicon url={entry.url} rule={serviceRule} />
      <span className="row-copy">{entry.title || fileName(entry.path)}</span>
      <span className="row-actions">
        {band === "open" && (
          <button
            type="button"
            data-testid={`later-${entry.id}`}
            title={S.action.later}
            aria-label={S.action.later}
            onClick={(event) => {
              event.stopPropagation();
              onLater(entry);
            }}
          >
            🕐
          </button>
        )}
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
      </span>
    </article>
  );
}

interface HubGroup {
  key: string;
  name: string;
  kind: Kind;
  entries: HubEntry[];
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
  const fullLoadRef = useRef<Promise<NewTabIndexEntry[]> | null>(null);
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
      void getHtmlPreview(entry.id, entry.url).then((html) => {
        setPreview((current) => current?.entry.id === entry.id ? { ...current, html } : current);
      });
    }
  }, [clearPreviewTimer]);

  const schedulePreview = useCallback((entry: HubEntry, serviceRule: ServiceRule | null, target: HTMLElement) => {
    clearPreviewTimer();
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

  const loadIndex = useCallback(async () => {
    const next = (await getNewTabIndex()) ?? (await rebuildNewTabIndex());
    setIndex(next);
  }, []);

  const loadFullEntries = useCallback(async (): Promise<NewTabIndexEntry[]> => {
    if (fullLoadRef.current) return fullLoadRef.current;
    fullLoadRef.current = getAllEntries()
      .then((entries) => entries.filter((entry) => !entry.archived).map(compact))
      .then((entries) => {
        setFullEntries(entries);
        return entries;
      })
      .finally(() => {
        fullLoadRef.current = null;
      });
    return fullLoadRef.current;
  }, []);

  const loadBookmarks = useCallback(async () => {
    const tree = await chrome.bookmarks.getTree();
    setBookmarkNodes(bookmarkBarChildren(tree));
  }, []);

  const loadTabs = useCallback(async (currentSettings: Settings, rules: ServiceRule[]) => {
    const tabs = await chrome.tabs.query({});
    const next: HubEntry[] = [];
    for (const tab of tabs) {
      const norm = normalizeTarget(tab.url, currentSettings);
      if (!norm || tab.id == null) continue;
      const id = await entryIdFromKey(norm.key);
      next.push({
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
      });
    }
    setOpenTabs(next);
  }, []);

  useEffect(() => {
    document.title = S.documentTitle;
    void (async () => {
      await ensureSchemaV3();
      const [currentSettings, entries] = await Promise.all([getSettings(), getAllEntries()]);
      const currentRules = await promoteServiceRules(entries);
      setSettings(currentSettings);
      setServiceRules(currentRules);
      await Promise.all([loadIndex(), loadTabs(currentSettings, currentRules.rules), loadBookmarks()]);
    })();
  }, [loadBookmarks, loadIndex, loadTabs]);

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
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  const merged = useMemo(() => {
    const base = query.trim() && fullEntries ? fullEntries : index;
    const byKey = new Map<string, HubEntry>(base.map((entry) => [entry.key, { ...entry }]));
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

  const kindCounts = useMemo(
    () => ({
      all: visibleEntries.length,
      web: visibleEntries.filter((entry) => entry.kind === "web").length,
      html: visibleEntries.filter((entry) => entry.kind === "html").length,
      pdf: visibleEntries.filter((entry) => entry.kind === "pdf").length
    }),
    [visibleEntries]
  );

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

  const filteredEntries = useMemo(() => {
    const selected = new Set(layout.selectedServices);
    if (!selected.size || layout.kind === "html" || layout.kind === "pdf") return kindFilteredEntries;
    return kindFilteredEntries.filter(
      (entry) => entry.kind === "web" && selected.has(getRuleForEntry(entry)?.id ?? "other")
    );
  }, [getRuleForEntry, kindFilteredEntries, layout.kind, layout.selectedServices]);

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
    async (entry: HubEntry) => {
      if (entry.tabId == null) return;
      await ensureStored(entry);
      const ts = Date.now();
      await patchEntry(entry.id, { later: true, laterAt: ts });
      const snapshot: UndoSnapshot = { urls: [entry.url], label: S.band.later, ts };
      await chrome.storage.local.set({ [UNDO_KEY]: snapshot });
      await chrome.tabs.remove(entry.tabId);
      setToast({ text: S.toast.closedOne(entry.title), undo: { entry, ts } });
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
      if (!hasMatch) {
        await chrome.search.query({ text, disposition: "CURRENT_TAB" });
      }
    },
    [bookmarkMatches.length, fullEntries, loadFullEntries, merged.length, openTabs, query]
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

  const runTabstripAction = useCallback(async (action: "collapse-hub-tabs" | "expand-hub-tabs") => {
    setTabstripBusy(true);
    try {
      const response = (await chrome.runtime.sendMessage({ type: action })) as {
        ok: boolean;
        count?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(response.error ?? action);
      const count = response.count ?? 0;
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
    const groups = groupRows(rows);
    const collapsed = layout.collapsedBands.includes(band);
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
          <div className="band-rows" data-testid={`band-rows-${band}`}>
            {groups.map((group) => {
              const collapseKey = `${band}:${group.key}`;
              const groupCollapsed = collapsedGroups.includes(collapseKey);
              return (
                <section className="hub-group" data-group-key={group.key} key={collapseKey}>
                  <div className="group-header">
                    <span className={`group-dot group-dot-${group.kind}`} aria-hidden="true" />
                    <span className="group-title">{group.name}</span>
                    <span className="group-count">{group.entries.length}</span>
                    <span className="group-actions">
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
                    </span>
                  </div>
                  {!groupCollapsed && group.entries.map((entry) => (
                    <AppRow
                      key={`${band}-${entry.id}`}
                      entry={entry}
                      band={band}
                      serviceRule={getRuleForEntry(entry)}
                      onOpen={(item, itemBand) => {
                        hidePreview(item.id, false);
                        void openEntry(item, itemBand);
                      }}
                      onLater={(item) => {
                        hidePreview(item.id, false);
                        void moveLater(item);
                      }}
                      onClose={(item, itemBand) => {
                        hidePreview(item.id, false);
                        void closeEntry(item, itemBand);
                      }}
                    />
                  ))}
                </section>
              );
            })}
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
        {query.trim() && merged.length === 0 && bookmarkMatches.length === 0 && (
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
      </header>

      <section className="pinned-strip" data-testid="pinned-strip">
        <h1 aria-label={S.pinned.heading} title={S.pinned.heading}><span aria-hidden="true">📌</span></h1>
        <div className="pinned-list">
          {pinned.length ? (
            pinned.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-pinned-entry-id={entry.id}
                onClick={() => void openEntry(entry, entry.tabId != null ? "open" : "recent")}
              >
                <Favicon url={entry.url} rule={getRuleForEntry(entry)} />
                <span>{entry.title}</span>
              </button>
            ))
          ) : (
            <p>{S.pinned.empty}</p>
          )}
        </div>
      </section>

      <BookmarkStrip nodes={bookmarkNodes} onOpen={(url) => void openBookmark(url)} getRule={getRuleForUrl} />

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
            {renderLedgerBand("later")}
            {filteredEntries.length === 0 && bookmarkMatches.length === 0 && (
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
