import type {
  ExportFile,
  Meta,
  NewTabIndexEntry,
  ReportEntry,
  ServiceRulesStore,
  Settings,
  TabSet
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import {
  autoServiceColor,
  autoServiceId,
  autoServiceLabel,
  entryIdFromKey,
  fileName,
  inferGroup,
  inferService,
  matchServiceRule,
  normalizeTarget,
  SEED_SERVICE_RULES,
  serviceHostname
} from "./url";

const ENTRY_PREFIX = "entry:";
const SETTINGS_KEY = "settings";
const META_KEY = "meta";
export const SERVICE_RULES_KEY = "serviceRules";
/** Above this, oldest archived non-pinned entries are pruned. */
const ENTRY_CAP = 10000;

interface LegacyMeta {
  schemaVersion: 1 | 2;
  backfillDoneAt: number | null;
}

type StoredMeta = Meta | LegacyMeta;

export function entryStorageKey(id: string): string {
  return ENTRY_PREFIX + id;
}

export function isEntryStorageKey(k: string): boolean {
  return k.startsWith(ENTRY_PREFIX);
}

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = got[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function getMeta(): Promise<StoredMeta> {
  const got = await chrome.storage.local.get(META_KEY);
  return (got[META_KEY] as StoredMeta | undefined) ?? {
    schemaVersion: 1,
    backfillDoneAt: null
  };
}

export async function patchMeta(patch: Partial<Meta>): Promise<void> {
  const meta = await getMeta();
  await chrome.storage.local.set({
    [META_KEY]: { ...meta, schemaVersion: 3, ...patch }
  });
}

let migrationPromise: Promise<void> | null = null;

/** Upgrade legacy entries and initialize the storage-backed service rule seed. */
export function ensureSchemaV3(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateSchemaV3().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

async function migrateSchemaV3(): Promise<void> {
  const metaGot = await chrome.storage.local.get([META_KEY, SERVICE_RULES_KEY]);
  const meta = (metaGot[META_KEY] as StoredMeta | undefined) ?? {
    schemaVersion: 1,
    backfillDoneAt: null
  };
  const hasStoredRules = Object.prototype.hasOwnProperty.call(metaGot, SERVICE_RULES_KEY);
  const serviceRules = hasStoredRules
    ? (metaGot[SERVICE_RULES_KEY] as ServiceRulesStore)
    : structuredClone(SEED_SERVICE_RULES);
  if (meta.schemaVersion === 3 && hasStoredRules) return;

  const all = await chrome.storage.local.get(null);
  const migrated: ReportEntry[] = [];
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!isEntryStorageKey(key)) continue;
    const raw = value as Partial<ReportEntry>;
    const later = raw.later === true;
    const kind =
      raw.kind === "web" || raw.kind === "pdf" || raw.kind === "html"
        ? raw.kind
        : "html";
    const entry = {
      ...raw,
      kind,
      service: inferService(raw.url ?? "", kind, serviceRules.rules),
      later,
      laterAt: later && typeof raw.laterAt === "number" ? raw.laterAt : null
    } as ReportEntry;
    migrated.push(entry);
    record[key] = entry;
  }
  record[PANEL_INDEX_KEY] = trimPanelIndex(migrated);
  record[NEW_TAB_INDEX_KEY] = trimNewTabIndex(migrated);
  record[META_KEY] = { schemaVersion: 3, backfillDoneAt: meta.backfillDoneAt } satisfies Meta;
  if (!hasStoredRules) record[SERVICE_RULES_KEY] = serviceRules;
  await chrome.storage.local.set(record);
}

export async function getServiceRules(): Promise<ServiceRulesStore> {
  const got = await chrome.storage.local.get(SERVICE_RULES_KEY);
  if (Object.prototype.hasOwnProperty.call(got, SERVICE_RULES_KEY)) {
    return got[SERVICE_RULES_KEY] as ServiceRulesStore;
  }
  const seed = structuredClone(SEED_SERVICE_RULES);
  await chrome.storage.local.set({ [SERVICE_RULES_KEY]: seed });
  return seed;
}

/** Promote currently-unmatched hosts once per hub opening. Existing rules are never replaced. */
export async function promoteServiceRules(entries: ReportEntry[]): Promise<ServiceRulesStore> {
  const current = await getServiceRules();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "web") continue;
    if (matchServiceRule(entry.url, current.rules)?.id !== "other") continue;
    const host = serviceHostname(entry.url);
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  const rules = [...current.rules];
  let changed = false;
  for (const [host, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 5 || matchServiceRule(`https://${host}/`, rules)?.id !== "other") continue;
    const rule = {
      id: autoServiceId(host),
      label: autoServiceLabel(host),
      match: { host: [host] },
      color: autoServiceColor(host, rules),
      origin: "auto" as const,
      hits: 0
    };
    const fallbackIndex = rules.findIndex((item) => item.id === "other");
    if (fallbackIndex >= 0) rules.splice(fallbackIndex, 0, rule);
    else rules.push(rule);
    changed = true;
  }
  if (!changed) return current;
  const next = { ...current, rules };
  await chrome.storage.local.set({ [SERVICE_RULES_KEY]: next });
  return next;
}

export async function getAllEntries(): Promise<ReportEntry[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => isEntryStorageKey(k))
    .map(([, v]) => v as ReportEntry);
}

export async function getEntry(id: string): Promise<ReportEntry | null> {
  const k = entryStorageKey(id);
  const got = await chrome.storage.local.get(k);
  return (got[k] as ReportEntry | undefined) ?? null;
}

let ledgerWriteChain: Promise<unknown> = Promise.resolve();

function serializeLedgerWrite(task: () => Promise<void>): Promise<void> {
  const next = ledgerWriteChain.then(task, task);
  ledgerWriteChain = next.catch(() => undefined);
  return next;
}

export function putEntry(e: ReportEntry): Promise<void> {
  return serializeLedgerWrite(async () => {
    const [panel, newTab] = await Promise.all([getPanelIndex(), getNewTabIndex()]);
    let all: ReportEntry[] | null = null;
    if (panel === null || newTab === null) all = await getAllEntries();
    const panelBase = panel ?? all ?? [];
    const newTabBase = newTab ?? (all ?? []).map(toNewTabIndexEntry);
    await chrome.storage.local.set({
      [entryStorageKey(e.id)]: e,
      [PANEL_INDEX_KEY]: trimPanelIndex([...panelBase, e]),
      [NEW_TAB_INDEX_KEY]: trimNewTabIndex([...newTabBase, toNewTabIndexEntry(e)])
    });
  });
}

export function putEntries(list: ReportEntry[]): Promise<void> {
  if (!list.length) return Promise.resolve();
  return serializeLedgerWrite(async () => {
    const byId = new Map((await getAllEntries()).map((entry) => [entry.id, entry]));
    for (const entry of list) byId.set(entry.id, entry);
    const merged = [...byId.values()];
    const record: Record<string, unknown> = {
      [PANEL_INDEX_KEY]: trimPanelIndex(merged),
      [NEW_TAB_INDEX_KEY]: trimNewTabIndex(merged.map(toNewTabIndexEntry))
    };
    for (const entry of list) record[entryStorageKey(entry.id)] = entry;
    await chrome.storage.local.set(record);
  });
}

export async function patchEntry(
  id: string,
  patch: Partial<ReportEntry>
): Promise<ReportEntry | null> {
  const cur = await getEntry(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await putEntry(next);
  return next;
}

export async function patchEntryByKey(
  key: string,
  patch: Partial<ReportEntry>
): Promise<ReportEntry | null> {
  return patchEntry(await entryIdFromKey(key), patch);
}

export function removeEntries(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  return serializeLedgerWrite(async () => {
    const [panel, newTab] = await Promise.all([getPanelIndex(), getNewTabIndex()]);
    const gone = new Set(ids);
    await chrome.storage.local.remove(ids.map(entryStorageKey));
    const record: Record<string, unknown> = {};
    if (panel) record[PANEL_INDEX_KEY] = panel.filter((entry) => !gone.has(entry.id));
    if (newTab) record[NEW_TAB_INDEX_KEY] = newTab.filter((entry) => !gone.has(entry.id));
    if (Object.keys(record).length) await chrome.storage.local.set(record);
  });
}

// -------------------- panel index (2026-07-14 perf) --------------------
// The side panel must open instantly. Reading every entry (storage.get(null))
// scales with the history backfill (thousands of entries, MBs) and made the
// panel feel heavy, so a small standing index (pinned ∪ recent 60) is kept up
// to date on every write and the panel reads exactly one key. The full
// enumeration remains for the library page, export, and panel search.
const PANEL_INDEX_KEY = "index:panel";
const PANEL_RECENT_CAP = 60;

function trimPanelIndex(list: ReportEntry[]): ReportEntry[] {
  const byId = new Map<string, ReportEntry>();
  for (const e of list) byId.set(e.id, e);
  const alive = [...byId.values()].filter((e) => !e.archived);
  const pinned = alive.filter((e) => e.pinned);
  const recent = alive
    .filter((e) => !e.pinned)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, PANEL_RECENT_CAP);
  return [...pinned, ...recent];
}

export async function getPanelIndex(): Promise<ReportEntry[] | null> {
  const got = await chrome.storage.local.get(PANEL_INDEX_KEY);
  const list = got[PANEL_INDEX_KEY] as ReportEntry[] | undefined;
  return Array.isArray(list) ? list : null;
}

// Serialize index writes within this JS context (code-review [8]): several
// report tabs finishing at once fire concurrent upsertVisit calls whose
// read-modify-writes would drop each other's entry. Cross-context races
// (panel pin vs SW visit) remain possible but self-heal on the next write.
let indexWriteChain: Promise<unknown> = Promise.resolve();

export function updatePanelIndex(entry: ReportEntry): Promise<void> {
  const task = async () => {
    const cur = await getPanelIndex();
    if (cur === null) {
      await rebuildPanelIndex();
      return;
    }
    await chrome.storage.local.set({ [PANEL_INDEX_KEY]: trimPanelIndex([...cur, entry]) });
  };
  const next = indexWriteChain.then(task, task);
  indexWriteChain = next.catch(() => undefined);
  return next;
}

/** Full rebuild from all entries — used as migration (missing index) and after bulk writes. */
export async function rebuildPanelIndex(): Promise<ReportEntry[]> {
  const list = trimPanelIndex(await getAllEntries());
  await chrome.storage.local.set({ [PANEL_INDEX_KEY]: list });
  return list;
}

// -------------------- new-tab index --------------------

export const NEW_TAB_INDEX_KEY = "index:newtab";

function toNewTabIndexEntry(entry: ReportEntry): NewTabIndexEntry {
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

function trimNewTabIndex(list: NewTabIndexEntry[]): NewTabIndexEntry[] {
  const byId = new Map<string, NewTabIndexEntry>();
  for (const entry of list) byId.set(entry.id, entry);
  return [...byId.values()]
    .filter(
      (entry) => !entry.archived && (entry.visitCount >= 2 || entry.pinned || entry.later)
    )
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function getNewTabIndex(): Promise<NewTabIndexEntry[] | null> {
  const got = await chrome.storage.local.get(NEW_TAB_INDEX_KEY);
  const list = got[NEW_TAB_INDEX_KEY] as NewTabIndexEntry[] | undefined;
  return Array.isArray(list) ? list : null;
}

export async function rebuildNewTabIndex(): Promise<NewTabIndexEntry[]> {
  const list = trimNewTabIndex((await getAllEntries()).map(toNewTabIndexEntry));
  await chrome.storage.local.set({ [NEW_TAB_INDEX_KEY]: list });
  return list;
}

export interface VisitInput {
  url: string;
  path: string;
  key: string;
  kind?: ReportEntry["kind"];
  service?: ReportEntry["service"];
  title?: string;
  at: number;
  source: ReportEntry["source"];
  /** live only: increment visitCount by 1 */
  countVisit: boolean;
  /** backfill/import: known first visit time */
  firstSeenAt?: number;
  /** backfill: absolute count, merged via max() */
  visitCount?: number;
}

export async function upsertVisit(v: VisitInput, settings: Settings): Promise<ReportEntry> {
  const kind = v.kind ?? normalizeTarget(v.url, settings)?.kind ?? "html";
  const service = v.service ?? inferService(v.url, kind, (await getServiceRules()).rules);
  const id = await entryIdFromKey(v.key);
  const cur = await getEntry(id);
  if (cur) {
    const next: ReportEntry = {
      ...cur,
      url: v.url || cur.url,
      path: v.path,
      key: v.key,
      kind,
      service,
      title: v.title && v.title.trim() ? v.title : cur.title,
      firstSeenAt: Math.min(cur.firstSeenAt, v.firstSeenAt ?? v.at),
      lastSeenAt: Math.max(cur.lastSeenAt, v.at),
      visitCount:
        v.visitCount != null
          ? Math.max(cur.visitCount, v.visitCount)
          : cur.visitCount + (v.countVisit ? 1 : 0)
    };
    if (v.source === "live") {
      next.missing = false;
      next.missingCheckedAt = v.at;
    }
    await putEntry(next);
    return next;
  }
  const entry: ReportEntry = {
    id,
    url: v.url,
    path: v.path,
    key: v.key,
    title: v.title && v.title.trim() ? v.title : fileName(v.path),
    group: inferGroup(v.path, settings.groupRules),
    firstSeenAt: v.firstSeenAt ?? v.at,
    lastSeenAt: v.at,
    visitCount: v.visitCount ?? (v.countVisit ? 1 : 0),
    pinned: false,
    archived: false,
    missing: v.source === "live" ? false : null,
    missingCheckedAt: v.source === "live" ? v.at : null,
    source: v.source,
    kind,
    service,
    later: false,
    laterAt: null
  };
  await putEntry(entry);
  return entry;
}

export async function recomputeGroups(settings: Settings): Promise<number> {
  const entries = await getAllEntries();
  const changed = entries
    .map((e) => ({ e, group: inferGroup(e.path, settings.groupRules) }))
    .filter(({ e, group }) => e.group !== group)
    .map(({ e, group }) => ({ ...e, group }));
  await putEntries(changed);
  return changed.length;
}

export async function enforceEntryCap(): Promise<number> {
  const entries = await getAllEntries();
  if (entries.length <= ENTRY_CAP) return 0;
  const candidates = entries
    .filter((e) => e.archived && !e.pinned)
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    .slice(0, entries.length - ENTRY_CAP);
  await removeEntries(candidates.map((e) => e.id));
  return candidates.length;
}

// -------------------- tab sets --------------------

const TABSET_PREFIX = "tabset:";

export function isTabSetStorageKey(k: string): boolean {
  return k.startsWith(TABSET_PREFIX);
}

export async function listTabSets(): Promise<TabSet[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => isTabSetStorageKey(k))
    .map(([, v]) => v as TabSet)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getTabSet(id: string): Promise<TabSet | null> {
  const k = TABSET_PREFIX + id;
  const got = await chrome.storage.local.get(k);
  return (got[k] as TabSet | undefined) ?? null;
}

export async function putTabSet(set: TabSet): Promise<void> {
  await chrome.storage.local.set({ [TABSET_PREFIX + set.id]: set });
}

export async function removeTabSet(id: string): Promise<void> {
  await chrome.storage.local.remove(TABSET_PREFIX + id);
}

export async function exportData(): Promise<ExportFile> {
  const [settings, entries] = await Promise.all([getSettings(), getAllEntries()]);
  return { schemaVersion: 1, exportedAt: Date.now(), settings, entries };
}

export async function importData(
  file: ExportFile,
  opts: { includeSettings: boolean }
): Promise<number> {
  if (file.schemaVersion !== 1 || !Array.isArray(file.entries)) {
    throw new Error("未対応のファイル形式です");
  }
  if (opts.includeSettings && file.settings) {
    await saveSettings({ ...DEFAULT_SETTINGS, ...file.settings });
  }
  const settings = await getSettings();
  const serviceRules = await getServiceRules();
  let merged = 0;
  for (const raw of file.entries) {
    if (!raw?.key || !raw?.path) continue;
    const id = await entryIdFromKey(raw.key);
    const cur = await getEntry(id);
    const imported: ReportEntry = {
      ...raw,
      id,
      kind:
        raw.kind === "web" || raw.kind === "pdf" || raw.kind === "html"
          ? raw.kind
          : "html",
      service: inferService(
        raw.url,
        raw.kind === "web" || raw.kind === "pdf" || raw.kind === "html" ? raw.kind : "html",
        serviceRules.rules
      ),
      later: raw.later === true,
      laterAt: raw.later === true && typeof raw.laterAt === "number" ? raw.laterAt : null,
      group: inferGroup(raw.path, settings.groupRules)
    };
    if (!cur) {
      await putEntry(imported);
    } else {
      await putEntry({
        ...cur,
        title: raw.lastSeenAt > cur.lastSeenAt && raw.title ? raw.title : cur.title,
        firstSeenAt: Math.min(cur.firstSeenAt, raw.firstSeenAt),
        lastSeenAt: Math.max(cur.lastSeenAt, raw.lastSeenAt),
        visitCount: Math.max(cur.visitCount, raw.visitCount),
        pinned: cur.pinned || raw.pinned,
        later: cur.later || imported.later,
        laterAt: cur.later ? cur.laterAt : imported.laterAt
      });
    }
    merged++;
  }
  return merged;
}
