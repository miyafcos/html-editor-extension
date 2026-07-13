import type { ExportFile, Meta, ReportEntry, Settings, TabSet } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { entryIdFromKey, fileName, inferGroup } from "./url";

const ENTRY_PREFIX = "entry:";
const SETTINGS_KEY = "settings";
const META_KEY = "meta";
/** Above this, oldest archived non-pinned entries are pruned. */
const ENTRY_CAP = 10000;

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

export async function getMeta(): Promise<Meta> {
  const got = await chrome.storage.local.get(META_KEY);
  return (got[META_KEY] as Meta | undefined) ?? { schemaVersion: 1, backfillDoneAt: null };
}

export async function patchMeta(patch: Partial<Meta>): Promise<void> {
  const meta = await getMeta();
  await chrome.storage.local.set({ [META_KEY]: { ...meta, ...patch } });
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

export async function putEntry(e: ReportEntry): Promise<void> {
  await chrome.storage.local.set({ [entryStorageKey(e.id)]: e });
}

export async function putEntries(list: ReportEntry[]): Promise<void> {
  if (!list.length) return;
  const record: Record<string, ReportEntry> = {};
  for (const e of list) record[entryStorageKey(e.id)] = e;
  await chrome.storage.local.set(record);
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

export async function removeEntries(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await chrome.storage.local.remove(ids.map(entryStorageKey));
}

export interface VisitInput {
  url: string;
  path: string;
  key: string;
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
  const id = await entryIdFromKey(v.key);
  const cur = await getEntry(id);
  if (cur) {
    const next: ReportEntry = {
      ...cur,
      url: v.url || cur.url,
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
    source: v.source
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
  let merged = 0;
  for (const raw of file.entries) {
    if (!raw?.key || !raw?.path) continue;
    const id = await entryIdFromKey(raw.key);
    const cur = await getEntry(id);
    if (!cur) {
      await putEntry({ ...raw, id, group: inferGroup(raw.path, settings.groupRules) });
    } else {
      await putEntry({
        ...cur,
        title: raw.lastSeenAt > cur.lastSeenAt && raw.title ? raw.title : cur.title,
        firstSeenAt: Math.min(cur.firstSeenAt, raw.firstSeenAt),
        lastSeenAt: Math.max(cur.lastSeenAt, raw.lastSeenAt),
        visitCount: Math.max(cur.visitCount, raw.visitCount),
        pinned: cur.pinned || raw.pinned
      });
    }
    merged++;
  }
  return merged;
}
