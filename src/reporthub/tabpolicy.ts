/** A URL-derived category, not a classification of the resource's actual content. */
export type HubKind = "web" | "html" | "pdf";

/**
 * Chrome's value for a tab that does not belong to a tab group.
 * Kept locally so this pure module does not reference the chrome API at runtime.
 */
export const TAB_GROUP_ID_NONE = -1;

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_eid", "_ga"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function parseSupportedUrl(rawUrl: string | null | undefined): URL | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return classifyParsedUrl(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function classifyParsedUrl(parsed: URL): HubKind | null {
  if (parsed.protocol === "file:") {
    if (/\.html?$/i.test(parsed.pathname)) return "html";
    return /\.pdf$/i.test(parsed.pathname) ? "pdf" : null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return /\.pdf$/i.test(parsed.pathname) ? "pdf" : "web";
}

/**
 * Classifies from the URL spelling only; it does not inspect the resource's actual content type.
 */
export function classifyKind(rawUrl: string | null | undefined): HubKind | null {
  if (!rawUrl) return null;
  try {
    return classifyParsedUrl(new URL(rawUrl));
  } catch {
    return null;
  }
}

/** Returns the URL parser's canonical href without additional normalization. */
export function duplicateStrictKey(rawUrl: string): string | null {
  return parseSupportedUrl(rawUrl)?.href ?? null;
}

function decodedParamName(pair: string): string {
  const equalsIndex = pair.indexOf("=");
  const encodedName = (equalsIndex < 0 ? pair : pair.slice(0, equalsIndex)).replace(/\+/g, " ");
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

/**
 * Returns a URL key that differs from the strict key only by omitting tracking parameters.
 * Remaining query components retain their original order and spelling from URL.href.
 */
export function duplicateLooseKey(rawUrl: string): string | null {
  const parsed = parseSupportedUrl(rawUrl);
  if (!parsed) return null;

  const strict = parsed.href;
  const fragmentIndex = strict.indexOf("#");
  const beforeFragment = fragmentIndex < 0 ? strict : strict.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : strict.slice(fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  if (queryIndex < 0) return strict;

  const base = beforeFragment.slice(0, queryIndex);
  const query = beforeFragment.slice(queryIndex + 1);
  const retained = query.split("&").filter((pair) => !isTrackingParam(decodedParamName(pair)));
  return `${base}${retained.length ? `?${retained.join("&")}` : ""}${fragment}`;
}

export type CloseProtection =
  | "active"
  | "pinned"
  | "audible"
  | "navigating"
  | "hub-tab"
  | "foreign-group"
  | "editing"
  | "editing-unknown";

export interface CloseCandidateTab {
  id: number;
  url: string;
  pendingUrl?: string;
  active: boolean;
  pinned: boolean;
  audible?: boolean;
  windowId: number;
  groupId: number;
  lastAccessed?: number;
}

export function closeProtectionReason(
  tab: CloseCandidateTab,
  ctx: { hubTabId: number; ownedGroupIds: ReadonlySet<number>; editing: "yes" | "no" | "unknown" }
): CloseProtection | null {
  if (tab.active) return "active";
  if (tab.pinned) return "pinned";
  if (tab.audible) return "audible";
  if (tab.pendingUrl) return "navigating";
  if (tab.id === ctx.hubTabId) return "hub-tab";
  if (tab.groupId !== TAB_GROUP_ID_NONE && !ctx.ownedGroupIds.has(tab.groupId)) return "foreign-group";
  if (ctx.editing === "yes") return "editing";
  if (ctx.editing === "unknown") return "editing-unknown";
  return null;
}

export interface DuplicateGroup {
  key: string;
  kind: HubKind;
  match: "strict" | "loose";
  keep: CloseCandidateTab;
  close: CloseCandidateTab[];
  protectedTabs: { tab: CloseCandidateTab; reason: CloseProtection }[];
}

interface KeyedCandidate {
  tab: CloseCandidateTab;
  kind: HubKind;
  strictKey: string;
  looseKey: string;
}

interface DuplicatePlanContext {
  hubTabId: number;
  ownedGroupIds: ReadonlySet<number>;
  editingByTabId: ReadonlyMap<number, "yes" | "no" | "unknown">;
  kindScope: HubKind | "all";
}

function compareKeepOrder(a: CloseCandidateTab, b: CloseCandidateTab): number {
  const accessDifference = (b.lastAccessed ?? Number.NEGATIVE_INFINITY) - (a.lastAccessed ?? Number.NEGATIVE_INFINITY);
  return accessDifference || a.id - b.id;
}

function createDuplicateGroup(
  candidates: readonly KeyedCandidate[],
  key: string,
  kind: HubKind,
  match: "strict" | "loose",
  ctx: DuplicatePlanContext
): DuplicateGroup {
  const protectedTabs = candidates.flatMap(({ tab }) => {
    const reason = closeProtectionReason(tab, {
      hubTabId: ctx.hubTabId,
      ownedGroupIds: ctx.ownedGroupIds,
      editing: ctx.editingByTabId.get(tab.id) ?? "unknown"
    });
    return reason ? [{ tab, reason }] : [];
  });
  const protectedIds = new Set(protectedTabs.map(({ tab }) => tab.id));
  const keepPool = protectedTabs.length ? protectedTabs.map(({ tab }) => tab) : candidates.map(({ tab }) => tab);
  const keep = [...keepPool].sort(compareKeepOrder)[0];

  return {
    key,
    kind,
    match,
    keep,
    close: candidates
      .map(({ tab }) => tab)
      .filter((tab) => !protectedIds.has(tab.id) && tab.id !== keep.id),
    protectedTabs
  };
}

function groupByKey(
  candidates: readonly KeyedCandidate[],
  keyOf: (candidate: KeyedCandidate) => string
): Map<string, KeyedCandidate[]> {
  const groups = new Map<string, KeyedCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${keyOf(candidate)}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  return groups;
}

/**
 * Builds a deterministic close plan without calling Chrome APIs.
 * Loose groups exist only when tracking removal joins two or more distinct strict keys.
 */
export function planDuplicateClose(
  tabs: readonly CloseCandidateTab[],
  ctx: DuplicatePlanContext
): DuplicateGroup[] {
  const candidates: KeyedCandidate[] = [];
  for (const tab of tabs) {
    const kind = classifyKind(tab.url);
    if (!kind || (ctx.kindScope !== "all" && kind !== ctx.kindScope)) continue;
    const strictKey = duplicateStrictKey(tab.url);
    const looseKey = duplicateLooseKey(tab.url);
    if (!strictKey || !looseKey) continue;
    candidates.push({ tab, kind, strictKey, looseKey });
  }

  const strictGroups = groupByKey(candidates, (candidate) => candidate.strictKey);
  const looseGroups = groupByKey(candidates, (candidate) => candidate.looseKey);
  const result: DuplicateGroup[] = [];

  for (const group of strictGroups.values()) {
    if (group.length >= 2) {
      result.push(createDuplicateGroup(group, group[0].strictKey, group[0].kind, "strict", ctx));
    }
  }
  for (const group of looseGroups.values()) {
    if (new Set(group.map((candidate) => candidate.strictKey)).size >= 2) {
      result.push(createDuplicateGroup(group, group[0].looseKey, group[0].kind, "loose", ctx));
    }
  }
  return result;
}

export interface OperationResult {
  changed: number;
  skipped: { reason: string; count: number }[];
  failed: { tabId: number; reason: string }[];
}

export function emptyResult(): OperationResult {
  return { changed: 0, skipped: [], failed: [] };
}

export function addChanged(result: OperationResult, count = 1): void {
  result.changed += count;
}

export function addSkip(result: OperationResult, reason: string, count = 1): void {
  const existing = result.skipped.find((item) => item.reason === reason);
  if (existing) existing.count += count;
  else result.skipped.push({ reason, count });
}

export function addFailure(result: OperationResult, tabId: number, reason: string): void {
  result.failed.push({ tabId, reason });
}
