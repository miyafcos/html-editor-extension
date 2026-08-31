export interface PreviewShape {
  headings: number;
  tables: number;
  maxTableRows: number;
  ok: number;
  warn: number;
  ng: number;
  figures: number;
}

export interface HtmlPreviewData {
  excerpt?: string;
  shape?: PreviewShape;
}

interface CachedHtmlPreview extends HtmlPreviewData {
  fetchedAt: number;
  lastSeenAt: number;
}

const CACHE_PREFIX = "excerpt:";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 300;
const FETCH_TIMEOUT_MS = 1500;
const EXCLUDED_SELECTOR = "script, style, nav, header, footer, aside";
const pendingPreviews = new Map<string, Promise<HtmlPreviewData>>();
let cacheMutationQueue = Promise.resolve();

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shorten(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
}

function isExcluded(element: Element): boolean {
  return element.closest(EXCLUDED_SELECTOR) !== null;
}

function readableText(element: Element): string {
  if (isExcluded(element)) return "";
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && !isExcluded(parent)) parts.push(node.textContent ?? "");
    node = walker.nextNode();
  }
  return normalizeText(parts.join(" "));
}

function firstReadable(elements: Iterable<Element>, minimumLength = 1): string {
  for (const element of elements) {
    const text = readableText(element);
    if (text.length >= minimumLength) return text;
  }
  return "";
}

function extractExcerpt(document: Document): string | undefined {
  const callout = firstReadable(document.querySelectorAll(".callout"));
  if (callout) return shorten(callout);

  const firstHeading = [...document.querySelectorAll("h1, h2")].find((element) => !isExcluded(element));
  const afterHeading = firstHeading?.nextElementSibling;
  if (afterHeading?.matches("p")) {
    const text = readableText(afterHeading);
    if (text.length >= 80) return shorten(text);
  }

  const paragraph = firstReadable(document.querySelectorAll("p"), 80);
  if (paragraph) return shorten(paragraph);

  const title = document.head?.querySelector("title") ?? null;
  const titleText = title ? readableText(title) : "";
  return titleText ? shorten(titleText) : undefined;
}

function extractShape(document: Document): PreviewShape | undefined {
  const tables = [...document.querySelectorAll("table")];
  const shape: PreviewShape = {
    headings: document.querySelectorAll("h2").length,
    tables: tables.length,
    maxTableRows: tables.reduce((maximum, table) => Math.max(maximum, table.querySelectorAll("tr").length), 0),
    ok: document.querySelectorAll(".chip.ok").length,
    warn: document.querySelectorAll(".chip.warn").length,
    ng: document.querySelectorAll(".chip.ng").length,
    figures: document.querySelectorAll("img, svg").length
  };
  return shape.headings || shape.tables || shape.ok || shape.warn || shape.ng || shape.figures ? shape : undefined;
}

export function parseHtmlPreview(source: string): HtmlPreviewData {
  const document = new DOMParser().parseFromString(source, "text/html");
  return { excerpt: extractExcerpt(document), shape: extractShape(document) };
}

function isCachedPreview(value: unknown): value is CachedHtmlPreview {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedHtmlPreview>;
  const shape = candidate.shape;
  const validShape = shape === undefined || (
    typeof shape === "object" &&
    [shape.headings, shape.tables, shape.maxTableRows, shape.ok, shape.warn, shape.ng, shape.figures]
      .every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0)
  );
  return (candidate.excerpt === undefined || typeof candidate.excerpt === "string") &&
    validShape &&
    typeof candidate.fetchedAt === "number" &&
    Number.isFinite(candidate.fetchedAt) &&
    typeof candidate.lastSeenAt === "number" &&
    Number.isFinite(candidate.lastSeenAt);
}

async function readCachedPreview(key: string, now: number): Promise<CachedHtmlPreview | null> {
  try {
    const stored = (await chrome.storage.local.get(key))[key];
    if (!isCachedPreview(stored)) return null;
    if (now - stored.fetchedAt > CACHE_TTL_MS) {
      await enqueueCacheMutation(() => chrome.storage.local.remove(key));
      return null;
    }
    const touched = { ...stored, lastSeenAt: now };
    await enqueueCacheMutation(() => chrome.storage.local.set({ [key]: touched }));
    return touched;
  } catch {
    return null;
  }
}

async function pruneCache(): Promise<void> {
  try {
    const now = Date.now();
    const stored = await chrome.storage.local.get(null);
    const excerptEntries = Object.entries(stored).filter(([key]) => key.startsWith(CACHE_PREFIX));
    const invalid = excerptEntries.filter(([, value]) => !isCachedPreview(value)).map(([key]) => key);
    const records = excerptEntries
      .filter(([, value]) => isCachedPreview(value))
      .map(([key, value]) => ({ key, value }));
    const expired = records.filter(({ value }) => now - value.fetchedAt > CACHE_TTL_MS).map(({ key }) => key);
    const current = records
      .filter(({ key }) => !expired.includes(key))
      .sort((left, right) => left.value.lastSeenAt - right.value.lastSeenAt);
    const overflow = current.slice(0, Math.max(0, current.length - CACHE_LIMIT)).map(({ key }) => key);
    const remove = [...invalid, ...expired, ...overflow];
    if (remove.length) await chrome.storage.local.remove(remove);
  } catch {
    // Preview cache maintenance is best-effort and must never break the card.
  }
}

function enqueueCacheMutation(task: () => Promise<void>): Promise<void> {
  const operation = cacheMutationQueue.then(task, task);
  cacheMutationQueue = operation.catch(() => undefined);
  return operation;
}

function storeAndPruneCache(key: string, record: CachedHtmlPreview): Promise<void> {
  return enqueueCacheMutation(async () => {
    await chrome.storage.local.set({ [key]: record });
    await pruneCache();
  });
}

function isLocalHtmlUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && /\.html?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  let timeoutId = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      controller.abort();
      reject(new DOMException("Preview fetch timed out", "TimeoutError"));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetch(url, { signal: controller.signal }), timeout]);
    if (!response.ok) throw new Error(`Preview fetch failed: ${response.status}`);
    return await response.text();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadHtmlPreview(entryId: string, url: string): Promise<HtmlPreviewData> {
  const key = `${CACHE_PREFIX}${entryId}`;
  const now = Date.now();
  const cached = await readCachedPreview(key, now);
  if (cached) return { excerpt: cached.excerpt, shape: cached.shape };

  try {
    const parsed = parseHtmlPreview(await fetchWithTimeout(url));
    const record: CachedHtmlPreview = { ...parsed, fetchedAt: now, lastSeenAt: now };
    try {
      await storeAndPruneCache(key, record);
    } catch {
      // A storage failure does not make the fetched preview unusable.
    }
    return parsed;
  } catch {
    return {};
  }
}

export function getHtmlPreview(entryId: string, url: string): Promise<HtmlPreviewData> {
  if (!isLocalHtmlUrl(url)) return Promise.resolve({});
  const pending = pendingPreviews.get(entryId);
  if (pending) return pending;
  const request = loadHtmlPreview(entryId, url).finally(() => pendingPreviews.delete(entryId));
  pendingPreviews.set(entryId, request);
  return request;
}
