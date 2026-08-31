import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NEW_TAB_INDEX_KEY,
  ensureSchemaV2,
  getAllEntries,
  getEntry,
  getNewTabIndex,
  getSettings,
  patchEntry,
  putEntry,
  rebuildNewTabIndex,
  removeEntries
} from "../reporthub/repo";
import { UNDO_KEY } from "../reporthub/tabops";
import {
  FALLBACK_GROUP,
  type NewTabIndexEntry,
  type ReportEntry,
  type Settings,
  type UndoSnapshot
} from "../reporthub/types";
import { entryIdFromKey, fileName, inferGroup, normalizeTarget, parentDir } from "../reporthub/url";
import { S } from "./strings";

type Kind = ReportEntry["kind"];
type KindFilter = "all" | Kind;
type Band = "open" | "recent" | "later";
type CollapsibleBand = Band | "bookmarks";

interface HubEntry extends NewTabIndexEntry {
  tabId?: number;
  windowId?: number;
  chromePinned?: boolean;
  faviconUrl?: string;
}

interface ToastState {
  text: string;
  undo?: { entry: HubEntry; ts: number };
}

const KINDS: Kind[] = ["web", "html", "pdf"];
const KIND_FILTERS: KindFilter[] = ["all", ...KINDS];
const BANDS: Band[] = ["open", "recent", "later"];
const COLLAPSIBLE_BANDS: CollapsibleBand[] = ["open", "recent", "bookmarks", "later"];
const SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LAYOUT_STORAGE_KEY = "tabhub:layout";

interface LayoutState {
  kind: KindFilter;
  collapsedBands: CollapsibleBand[];
}

function readLayoutState(): LayoutState {
  const fallback: LayoutState = { kind: "all", collapsedBands: [] };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null") as Partial<LayoutState> | null;
    if (!stored || !KIND_FILTERS.includes(stored.kind as KindFilter)) return fallback;
    const collapsedBands = Array.isArray(stored.collapsedBands)
      ? stored.collapsedBands.filter((band): band is CollapsibleBand =>
          COLLAPSIBLE_BANDS.includes(band as CollapsibleBand)
        )
      : [];
    return { kind: stored.kind as KindFilter, collapsedBands: [...new Set(collapsedBands)] };
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
    later,
    laterAt
  };
}

function searchText(entry: HubEntry): string {
  return `${entry.title}\n${entry.group}\n${entry.path}\n${entry.key}`
    .toLowerCase()
    .normalize("NFC");
}

function locationLabel(entry: HubEntry): string {
  if (entry.url.startsWith("file:")) return parentDir(entry.path);
  try {
    return new URL(entry.url).host;
  } catch {
    return entry.path;
  }
}

function kindIcon(kind: Kind): string {
  if (kind === "html") return "🧾";
  if (kind === "pdf") return "📑";
  return "📄";
}

function faviconUrl(url: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
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
  onOpen
}: {
  nodes: chrome.bookmarks.BookmarkTreeNode[];
  onOpen: (url: string) => void;
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
      <h2><span aria-hidden="true">⭐</span> {S.bookmarks.lead}</h2>
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

function BookmarkResult({ node, onOpen }: { node: chrome.bookmarks.BookmarkTreeNode; onOpen: (url: string) => void }) {
  const url = node.url!;
  return (
    <button
      type="button"
      className="bookmark-result"
      data-testid={`bookmark-search-${node.id}`}
      data-bookmark-id={node.id}
      onClick={() => onOpen(url)}
    >
      <span className="bookmark-result-mark" aria-hidden="true">⭐</span>
      <span className="bookmark-result-copy">
        <strong>{node.title || url}</strong>
        <small>{url}</small>
      </span>
    </button>
  );
}

function AppRow({
  entry,
  band,
  onOpen,
  onLater,
  onPin,
  onRemove,
  showKindIcon
}: {
  entry: HubEntry;
  band: Band;
  onOpen: (entry: HubEntry, band: Band) => void;
  onLater: (entry: HubEntry) => void;
  onPin: (entry: HubEntry) => void;
  onRemove: (entry: HubEntry) => void;
  showKindIcon: boolean;
}) {
  const isPinned = entry.pinned || entry.chromePinned;
  const openLabel = band === "open" ? S.action.switchTo : S.action.openNew;
  const location = locationLabel(entry);
  const secondary = entry.group === FALLBACK_GROUP ? location : `${entry.group} · ${location}`;
  return (
    <article
      className={`hub-row${showKindIcon ? " show-kind-icon" : ""}`}
      data-testid={`row-${band}-${entry.id}`}
      data-entry-id={entry.id}
      data-kind={entry.kind}
      role="button"
      tabIndex={0}
      title={openLabel}
      aria-label={`${openLabel}: ${entry.title}`}
      onClick={() => onOpen(entry, band)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry, band);
        }
      }}
    >
      <span className={`kind-mark kind-mark-${entry.kind}`} aria-hidden="true" />
      {showKindIcon && <span className="kind-icon" aria-hidden="true">{kindIcon(entry.kind)}</span>}
      <img
        className="favicon"
        src={entry.faviconUrl || faviconUrl(entry.url)}
        alt=""
        onError={(event) => {
          event.currentTarget.hidden = true;
        }}
      />
      <span className="row-copy">
        <strong>{entry.title || fileName(entry.path)}</strong>
        <small>{secondary}</small>
      </span>
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
          data-testid={`pin-${entry.id}`}
          className={isPinned ? "is-active" : undefined}
          title={isPinned ? S.action.unpin : S.action.pin}
          aria-label={isPinned ? S.action.unpin : S.action.pin}
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
            onRemove(entry);
          }}
        >
          ×
        </button>
      </span>
    </article>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [index, setIndex] = useState<NewTabIndexEntry[]>([]);
  const [openTabs, setOpenTabs] = useState<HubEntry[]>([]);
  const [fullEntries, setFullEntries] = useState<NewTabIndexEntry[] | null>(null);
  const [bookmarkNodes, setBookmarkNodes] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [layout, setLayout] = useState<LayoutState>(readLayoutState);
  const [tabstripBusy, setTabstripBusy] = useState(false);
  const fullLoadRef = useRef<Promise<NewTabIndexEntry[]> | null>(null);

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

  const loadTabs = useCallback(async (currentSettings: Settings) => {
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
        later: false,
        laterAt: null,
        tabId: tab.id,
        windowId: tab.windowId,
        chromePinned: tab.pinned,
        faviconUrl: tab.favIconUrl
      });
    }
    setOpenTabs(next);
  }, []);

  useEffect(() => {
    document.title = S.documentTitle;
    void (async () => {
      await ensureSchemaV2();
      const currentSettings = await getSettings();
      setSettings(currentSettings);
      await Promise.all([loadIndex(), loadTabs(currentSettings), loadBookmarks()]);
    })();
  }, [loadBookmarks, loadIndex, loadTabs]);

  useEffect(() => {
    if (!settings) return;
    const storageHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[NEW_TAB_INDEX_KEY]) {
        setFullEntries(null);
        void loadIndex();
      }
    };
    const tabHandler = () => void loadTabs(settings);
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
  }, [loadIndex, loadTabs, settings]);

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
              chromePinned: tab.chromePinned,
              faviconUrl: tab.faviconUrl
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

  const kindCounts = useMemo(
    () => ({
      all: visibleEntries.length,
      web: visibleEntries.filter((entry) => entry.kind === "web").length,
      html: visibleEntries.filter((entry) => entry.kind === "html").length,
      pdf: visibleEntries.filter((entry) => entry.kind === "pdf").length
    }),
    [visibleEntries]
  );

  const filteredEntries = useMemo(
    () =>
      layout.kind === "all"
        ? visibleEntries
        : visibleEntries.filter((entry) => entry.kind === layout.kind),
    [layout.kind, visibleEntries]
  );

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

  const togglePin = useCallback(
    async (entry: HubEntry) => {
      const stored = await ensureStored(entry);
      if (entry.chromePinned && entry.tabId != null) {
        await chrome.tabs.update(entry.tabId, { pinned: false });
        if (stored.pinned) await patchEntry(entry.id, { pinned: false });
      } else {
        await patchEntry(entry.id, { pinned: !stored.pinned });
      }
    },
    [ensureStored]
  );

  const removeEntry = useCallback(async (entry: HubEntry) => {
    await removeEntries([entry.id]);
    setToast({ text: S.toast.removedOne(entry.title) });
  }, []);

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
  const renderLedgerBand = (band: Band) => {
    const rows = rowsByBand[band];
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
          </button>
        </h3>
        {!collapsed && rows.length > 0 && (
          <div className="band-rows" data-testid={`band-rows-${band}`}>
            {rows.map((entry) => (
              <AppRow
                key={`${band}-${entry.id}`}
                entry={entry}
                band={band}
                showKindIcon={layout.kind === "all"}
                onOpen={(item, itemBand) => void openEntry(item, itemBand)}
                onLater={(item) => void moveLater(item)}
                onPin={(item) => void togglePin(item)}
                onRemove={(item) => void removeEntry(item)}
              />
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <main className="hub-shell" data-testid="hub-shell" data-ready={settings ? "true" : "false"}>
      <header className="hub-header">
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
        {query.trim() && merged.length === 0 && bookmarkMatches.length === 0 && (
          <p className="search-hint">{S.search.fallbackHint}</p>
        )}
      </header>

      <section className="pinned-strip" data-testid="pinned-strip">
        <h1><span aria-hidden="true">📌</span> {S.pinned.heading}</h1>
        <div className="pinned-list">
          {pinned.length ? (
            pinned.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-entry-id={entry.id}
                onClick={() => void openEntry(entry, entry.tabId != null ? "open" : "recent")}
              >
                <img src={entry.faviconUrl || faviconUrl(entry.url)} alt="" />
                <span>{entry.title}</span>
              </button>
            ))
          ) : (
            <p>{S.pinned.empty}</p>
          )}
        </div>
      </section>

      <BookmarkStrip nodes={bookmarkNodes} onOpen={(url) => void openBookmark(url)} />

      {index.length === 0 && openTabs.length === 0 && !query.trim() ? (
        <section className="first-run">
          <span aria-hidden="true">⌁</span>
          <h2>{S.firstRun.heading}</h2>
          <p>{S.firstRun.body}</p>
        </section>
      ) : (
        <section className="hub-list" data-testid="hub-list">
          <div className="list-toolbar">
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
                    {kind !== "all" && <span aria-hidden="true">{kindIcon(kind)}</span>}
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
                  </button>
                </h3>
                {!layout.collapsedBands.includes("bookmarks") && (
                  <div className="band-rows" data-testid="band-rows-bookmarks">
                    {bookmarkMatches.map((node) => (
                      <BookmarkResult key={node.id} node={node} onOpen={(url) => void openBookmark(url)} />
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

      {toast && (
        <aside className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => void undoLater()}>{S.toast.undo}</button>}
        </aside>
      )}
    </main>
  );
}
