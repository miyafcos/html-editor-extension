export interface HubIndexRow {
  i: string;
  t: string;
  d: string;
  c: string;
  g: string[];
  m: string;
  p: string;
}

export interface HubIndexSnapshot {
  sourceUrl: string;
  rows: HubIndexRow[];
  fetchedAt: number;
}

export interface HubIndexMatch {
  row: HubIndexRow;
  score: number;
}

type HubIndexCache = HubIndexSnapshot;

interface HubIndexSettings {
  sourceUrl?: unknown;
}

export const HUB_INDEX_CACHE_KEY = "hubIndex";
export const HUB_INDEX_SETTINGS_KEY = "hubIndex:settings";
export const DEFAULT_HUB_INDEX_URL = "file:///C:/Users/miyaz/AppData/Local/AIHtmlHubMirror/mobile/search.json";
const HUB_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ROWS = 10_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_TAGS = 50;
const pendingLoads = new Map<string, Promise<HubIndexSnapshot>>();
const sessionSnapshots = new Map<string, HubIndexSnapshot>();

function normalizedText(value: string): string {
  return value.trim().toLowerCase().normalize("NFC");
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

function safeRelativeHtmlPath(path: string, id: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const file = segments.at(-1) ?? "";
  return new RegExp(`__${id}\\.html?$`, "i").test(file);
}

function projectRow(value: unknown): HubIndexRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<Record<keyof HubIndexRow, unknown>>;
  if (typeof row.i !== "string" || !/^[0-9a-f]{12}$/i.test(row.i)) return null;
  if (!validText(row.t) || !validText(row.d) || !validText(row.c) || !validText(row.m) || !validText(row.p)) return null;
  if (!row.t.trim() || !row.c.trim() || !row.m.trim() || !Number.isFinite(Date.parse(row.m))) return null;
  if (!Array.isArray(row.g) || row.g.length > MAX_TAGS || !row.g.every(validText)) return null;
  if (!safeRelativeHtmlPath(row.p, row.i)) return null;
  return {
    i: row.i.toLowerCase(),
    t: row.t,
    d: row.d,
    c: row.c.trim().normalize("NFC"),
    g: row.g.map((tag) => tag.trim().normalize("NFC")).filter(Boolean),
    m: row.m,
    p: row.p.replaceAll("\\", "/")
  };
}

function projectRows(value: unknown): HubIndexRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const rows: HubIndexRow[] = [];
  for (const valueRow of value) {
    const row = projectRow(valueRow);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function allowedFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.host) return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (!/^\/[a-z]:\//i.test(decodedPath) || /^\/g:/i.test(decodedPath) || decodedPath.includes("\\")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function readSourceUrl(settings: unknown): string | null {
  const configured = settings && typeof settings === "object"
    ? (settings as HubIndexSettings).sourceUrl
    : undefined;
  const candidate = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_HUB_INDEX_URL;
  return allowedFileUrl(candidate);
}

export function isHubIndexSnapshotFresh(snapshot: HubIndexSnapshot, now = Date.now()): boolean {
  return Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt <= now && now - snapshot.fetchedAt < HUB_INDEX_TTL_MS;
}

function readCache(value: unknown, sourceUrl: string, now: number): HubIndexSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const cache = value as Partial<HubIndexCache>;
  if (cache.sourceUrl !== sourceUrl || typeof cache.fetchedAt !== "number" || !Number.isFinite(cache.fetchedAt)) return null;
  if (!isHubIndexSnapshotFresh(cache as HubIndexSnapshot, now)) return null;
  const rows = projectRows(cache.rows);
  return rows ? { sourceUrl, rows, fetchedAt: cache.fetchedAt } : null;
}

async function fetchHubIndex(sourceUrl: string): Promise<HubIndexSnapshot> {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Hub index fetch failed: ${response.status}`);
    const rows = projectRows(await response.json());
    if (!rows) throw new Error("Hub index has an invalid shape");
    const snapshot: HubIndexSnapshot = { sourceUrl, rows, fetchedAt: Date.now() };
    const cache: HubIndexCache = snapshot;
    try {
      await chrome.storage.local.set({ [HUB_INDEX_CACHE_KEY]: cache });
    } catch {
      // The live result remains usable when caching is unavailable.
    }
    return snapshot;
  } catch {
    return { sourceUrl, rows: [], fetchedAt: Date.now() };
  }
}

export async function loadHubIndex(): Promise<HubIndexSnapshot | null> {
  try {
    const stored = await chrome.storage.local.get([HUB_INDEX_SETTINGS_KEY, HUB_INDEX_CACHE_KEY]);
    const sourceUrl = readSourceUrl(stored[HUB_INDEX_SETTINGS_KEY]);
    if (!sourceUrl) return null;
    const remembered = sessionSnapshots.get(sourceUrl);
    if (remembered && isHubIndexSnapshotFresh(remembered)) return remembered;
    sessionSnapshots.delete(sourceUrl);
    const cached = readCache(stored[HUB_INDEX_CACHE_KEY], sourceUrl, Date.now());
    if (cached) {
      sessionSnapshots.set(sourceUrl, cached);
      return cached;
    }
    const pending = pendingLoads.get(sourceUrl);
    if (pending) return pending;
    const request = fetchHubIndex(sourceUrl)
      .then((snapshot) => {
        sessionSnapshots.set(sourceUrl, snapshot);
        return snapshot;
      })
      .finally(() => pendingLoads.delete(sourceUrl));
    pendingLoads.set(sourceUrl, request);
    return request;
  } catch {
    return null;
  }
}

export function searchHubIndex(rows: HubIndexRow[], query: string): HubIndexMatch[] {
  const needle = normalizedText(query);
  if (!needle) return [];
  const matches: HubIndexMatch[] = [];
  for (const row of rows) {
    let score = 0;
    if (normalizedText(row.t).includes(needle)) score = 4;
    else if (row.g.some((tag) => normalizedText(tag).includes(needle))) score = 3;
    else if (normalizedText(row.d).includes(needle)) score = 2;
    else if (normalizedText(row.c).includes(needle)) score = 1;
    if (score) matches.push({ row, score });
  }
  return matches.sort((left, right) => right.score - left.score);
}

export function hubIndexRowUrl(row: HubIndexRow, sourceUrl: string): string | null {
  const safeSource = allowedFileUrl(sourceUrl);
  if (!safeSource || !safeRelativeHtmlPath(row.p, row.i)) return null;
  try {
    const root = new URL("../", safeSource);
    const relative = row.p.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const target = new URL(relative, root);
    if (!allowedFileUrl(target.href) || !target.href.startsWith(root.href)) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function hubIndexIdentityFromPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path).replaceAll("\\", "/");
    const file = decoded.split("/").at(-1)?.toLowerCase().normalize("NFC") ?? "";
    const match = file.match(/__([0-9a-f]{12})\.html?$/i);
    return match ? `${file}|${match[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}
