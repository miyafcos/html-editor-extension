import type { Settings, UndoSnapshot } from "./types";
import type { NormalizedFile } from "./url";
import { isTargetFile, normalizeFileUrl } from "./url";
import type { HubGroupRegistry, HubKind, OperationResult } from "./tabpolicy";
import {
  addChanged,
  addFailure,
  addSkip,
  emptyResult,
  hubGroupTitle,
  planGroupAssignment,
  reconcileRegistry
} from "./tabpolicy";
import { loadRegistry, markOrganized, saveRegistry } from "./tabgroups";

/** storage.local key for the やりなおし (undo) snapshot of the last close op. */
export const UNDO_KEY = "undo:lastClosed";
export const discardKey = (tabId: number) => `tabdiscard:${tabId}`;

const QUICK_EDIT_TIMEOUT_MS = 300;

async function isQuickEditEnabled(tabId: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.tabs
        .sendMessage(tabId, { type: "quick-edit:status" })
        .catch(() => ({ editing: false })),
      new Promise<{ editing: false }>((resolve) => {
        timer = setTimeout(() => resolve({ editing: false }), QUICK_EDIT_TIMEOUT_MS);
      })
    ]);
    return response?.editing === true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasDiscardGuard(tab: chrome.tabs.Tab): boolean {
  return Boolean(tab.active || tab.discarded || tab.pinned || tab.audible);
}

async function discardTarget(
  target: ReportTab,
  isStillEligible: (tab: chrome.tabs.Tab) => boolean
): Promise<boolean> {
  const tabId = target.tab.id;
  if (tabId == null) return false;
  try {
    let tab = await chrome.tabs.get(tabId);
    if (hasDiscardGuard(tab) || !isStillEligible(tab)) return false;
    if (await isQuickEditEnabled(tabId)) return false;
    // The user can activate/pin the tab, or audio can start, during the content-script probe.
    tab = await chrome.tabs.get(tabId);
    if (hasDiscardGuard(tab) || !isStillEligible(tab)) return false;
    await chrome.storage.session.set({ [discardKey(tabId)]: target.norm.key });
    try {
      const discarded = (await chrome.tabs.discard(tabId)) as chrome.tabs.Tab | undefined;
      if (!discarded?.discarded) {
        await chrome.storage.session.remove(discardKey(tabId));
        return false;
      }
      return true;
    } catch (error) {
      await chrome.storage.session.remove(discardKey(tabId));
      console.warn("Failed to discard report tab", tabId, error);
      return false;
    }
  } catch {
    return false;
  }
}

async function discardTargets(
  targets: ReportTab[],
  isStillEligible: (tab: chrome.tabs.Tab) => boolean = () => true
): Promise<number> {
  const results = await Promise.all(targets.map((target) => discardTarget(target, isStillEligible)));
  return results.filter(Boolean).length;
}

async function saveUndoSnapshot(urls: string[], label: string): Promise<void> {
  if (!urls.length) return;
  const snapshot: UndoSnapshot = { urls, label, ts: Date.now() };
  await chrome.storage.local.set({ [UNDO_KEY]: snapshot });
}

export async function getUndoSnapshot(): Promise<UndoSnapshot | null> {
  const got = await chrome.storage.local.get(UNDO_KEY);
  return (got[UNDO_KEY] as UndoSnapshot | undefined) ?? null;
}

/** Reopen the tabs recorded by the last close operation. Returns the count, or null when nothing to undo. */
export async function undoLastClose(settings: Settings): Promise<number | null> {
  const snapshot = await getUndoSnapshot();
  if (!snapshot || !snapshot.urls.length) return null;
  // reopen FIRST, drop the snapshot only on success — deleting it up front
  // makes a failed reopen unrecoverable (code-review [4])
  await openEntries(snapshot.urls, settings);
  await chrome.storage.local.remove(UNDO_KEY);
  return snapshot.urls.length;
}

export interface ReportTab {
  tab: chrome.tabs.Tab;
  norm: NormalizedFile;
}

export async function listReportTabs(
  settings: Settings,
  allWindows = false
): Promise<ReportTab[]> {
  const query: chrome.tabs.QueryInfo = { url: "file:///*" };
  if (!allWindows) query.lastFocusedWindow = true;
  const tabs = await chrome.tabs.query(query);
  const out: ReportTab[] = [];
  for (const tab of tabs) {
    const norm = normalizeFileUrl(tab.url);
    if (norm && isTargetFile(norm, settings)) out.push({ tab, norm });
  }
  return out;
}

/**
 * Gather report tabs of the focused window into the configured tab group.
 * With collapse=true the group is folded to a single chip ("ぐっとまとめる").
 */
export async function organizeTabs(settings: Settings, collapse = false): Promise<number> {
  const targets = (await listReportTabs(settings)).filter(
    (t) => !t.tab.pinned && t.tab.id != null
  );
  if (!targets.length) return 0;
  const windowId = targets[0].tab.windowId;
  const tabIds = targets.filter((t) => t.tab.windowId === windowId).map((t) => t.tab.id!);
  await groupTabIds(tabIds, windowId, settings, collapse);
  if (collapse) await discardTargets(targets.filter((t) => tabIds.includes(t.tab.id!)));
  return tabIds.length;
}

/** Group explicit tab ids — freshly created tabs are not yet found by
 *  tabs.query({url}) until their navigation commits, so callers that just
 *  created tabs must pass the ids instead of re-querying. */
async function groupTabIds(
  tabIds: number[],
  windowId: number,
  settings: Settings,
  collapse: boolean
): Promise<void> {
  await groupTabIdsByLabel(
    tabIds,
    windowId,
    settings.tabGroupTitle,
    settings.tabGroupColor,
    collapse
  );
}

async function groupTabIdsByLabel(
  tabIds: number[],
  windowId: number,
  title: string,
  color: chrome.tabGroups.ColorEnum,
  collapse: boolean
): Promise<void> {
  if (!tabIds.length) return;
  const existing = await chrome.tabGroups.query({ windowId, title });
  let groupId: number;
  if (existing.length) {
    groupId = existing[0].id;
    await chrome.tabs.group({ tabIds, groupId });
    await chrome.tabGroups.update(groupId, { title, color });
  } else {
    groupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId }
    });
    await chrome.tabGroups.update(groupId, {
      title,
      color
    });
  }
  if (collapse) await collapseGroup(groupId, windowId);
}

const HUB_GROUPS: Record<
  HubKind,
  { color: chrome.tabGroups.ColorEnum }
> = {
  web: { color: "blue" },
  html: { color: "green" },
  pdf: { color: "red" }
};

/** Group every supported tab in the hub's window by kind and collapse each group. */
export async function collapseHubTabs(
  _settings: Settings,
  windowId: number,
  hubTabId: number,
  kindScope: HubKind | "all" = "all"
): Promise<OperationResult> {
  const result = emptyResult();
  const liveGroups = await chrome.tabGroups.query({ windowId });
  const liveGroupsById = new Map(liveGroups.map((group) => [group.id, group]));
  const reconciled = reconcileRegistry(await loadRegistry(windowId), liveGroups);
  let registry: HubGroupRegistry = reconciled.registry;
  if (reconciled.dropped.length) await saveRegistry(windowId, registry);

  const tabs = await chrome.tabs.query({ windowId });
  const plan = planGroupAssignment(
    tabs.flatMap((tab) =>
      tab.id == null || !tab.url ? [] : [{ id: tab.id, url: tab.url, pinned: tab.pinned, groupId: tab.groupId }]
    ),
    { hubTabId, registry, kindScope }
  );
  for (const skipped of plan.skipped) addSkip(result, skipped.reason);

  for (const kind of Object.keys(HUB_GROUPS) as HubKind[]) {
    const tabIds = plan.assign[kind];
    let groupId = registry.groups[kind];
    if (!tabIds.length && groupId == null) continue;
    try {
      const wasCollapsed = groupId == null ? false : liveGroupsById.get(groupId)?.collapsed === true;
      if (groupId == null) {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: hubGroupTitle(kind), color: HUB_GROUPS[kind].color });
        registry = { ...registry, groups: { ...registry.groups, [kind]: groupId } };
        await saveRegistry(windowId, registry);
      } else if (tabIds.length) {
        await chrome.tabs.group({ tabIds, groupId });
        await chrome.tabGroups.update(groupId, { color: HUB_GROUPS[kind].color });
      }
      const collapseReason = await collapseGroup(groupId, windowId);
      if (collapseReason) addSkip(result, collapseReason);
      else if (tabIds.length || !wasCollapsed) {
        addChanged(result, tabIds.length || tabs.filter((tab) => tab.groupId === groupId).length);
        await markOrganized(windowId, kind, Date.now());
      }
    } catch (error) {
      for (const tabId of tabIds) addFailure(result, tabId, String(error));
    }
  }
  return result;
}

/** Expand the kind groups managed by the new-tab hub. Returns their tab count. */
export async function expandHubTabs(
  windowId: number,
  kindScope: HubKind | "all" = "all"
): Promise<OperationResult> {
  const result = emptyResult();
  const liveGroups = await chrome.tabGroups.query({ windowId });
  const reconciled = reconcileRegistry(await loadRegistry(windowId), liveGroups);
  if (reconciled.dropped.length) await saveRegistry(windowId, reconciled.registry);
  const groupsById = new Map(liveGroups.map((group) => [group.id, group]));
  const tabs = await chrome.tabs.query({ windowId });
  for (const kind of Object.keys(HUB_GROUPS) as HubKind[]) {
    if (kindScope !== "all" && kind !== kindScope) {
      if (reconciled.registry.groups[kind] != null) addSkip(result, "out-of-scope");
      continue;
    }
    const groupId = reconciled.registry.groups[kind];
    if (groupId == null) continue;
    const group = groupsById.get(groupId);
    if (!group) continue;
    const tabCount = tabs.filter((tab) => tab.groupId === groupId).length;
    if (!group.collapsed) {
      addSkip(result, "already-expanded", tabCount);
      continue;
    }
    try {
      await chrome.tabGroups.update(groupId, { collapsed: false });
      addChanged(result, tabCount);
    } catch (error) {
      addFailure(result, groupId, String(error));
    }
  }
  return result;
}

/** Collapse a group only when the active tab is outside it. */
async function collapseGroup(groupId: number, windowId: number): Promise<string | null> {
  const activeTabs = await chrome.tabs.query({ windowId, active: true });
  if (activeTabs.some((tab) => tab.groupId === groupId)) return "active-tab-inside";
  try {
    await chrome.tabGroups.update(groupId, { collapsed: true });
    return null;
  } catch {
    return "collapse-failed";
  }
}

/** Toggle the report group folded/unfolded. Returns the new collapsed state, or null if no group. */
export async function toggleCollapse(settings: Settings): Promise<boolean | null> {
  const win = await chrome.windows.getLastFocused();
  const groups = await chrome.tabGroups.query({
    windowId: win.id,
    title: settings.tabGroupTitle
  });
  if (!groups.length) return null;
  const next = !groups[0].collapsed;
  if (next) {
    const targets = (await listReportTabs(settings)).filter(
      (target) => target.tab.groupId === groups[0].id
    );
    await collapseGroup(groups[0].id, win.id!);
    await discardTargets(targets);
  }
  else {
    await chrome.tabGroups.update(groups[0].id, { collapsed: false });
  }
  return next;
}

/** Discard every safe report tab across all windows. */
export async function discardReportTabs(settings: Settings): Promise<number> {
  return discardTargets(await listReportTabs(settings, true));
}

/** Discard safe report tabs whose last access is older than the configured threshold. */
export async function discardIdleReportTabs(
  settings: Settings,
  now = Date.now()
): Promise<number> {
  if (settings.autoDiscardMinutes <= 0) return 0;
  const cutoff = now - settings.autoDiscardMinutes * 60_000;
  const targets = (await listReportTabs(settings, true)).filter(
    (target) => target.tab.lastAccessed != null && target.tab.lastAccessed <= cutoff
  );
  return discardTargets(
    targets,
    (tab) => tab.lastAccessed != null && tab.lastAccessed <= cutoff
  );
}

/** Close duplicate tabs per normalized key, keeping the active or most recent one. */
export async function closeDuplicateTabs(settings: Settings): Promise<number> {
  const targets = await listReportTabs(settings);
  const byKey = new Map<string, ReportTab[]>();
  for (const t of targets) {
    const list = byKey.get(t.norm.key) ?? [];
    list.push(t);
    byKey.set(t.norm.key, list);
  }
  const toClose: number[] = [];
  const closedUrls: string[] = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const keep =
      list.find((t) => t.tab.active) ??
      [...list].sort(
        (a, b) => (b.tab.lastAccessed ?? b.tab.id ?? 0) - (a.tab.lastAccessed ?? a.tab.id ?? 0)
      )[0];
    for (const t of list) {
      if (t !== keep && t.tab.id != null) {
        toClose.push(t.tab.id);
        closedUrls.push(t.norm.url);
      }
    }
  }
  if (toClose.length) {
    await saveUndoSnapshot(closedUrls, "かぶり閉じる");
    await chrome.tabs.remove(toClose);
  }
  return toClose.length;
}

export async function closeReportTabs(settings: Settings): Promise<number> {
  const targets = await listReportTabs(settings);
  const ids = targets.map((t) => t.tab.id).filter((id): id is number => id != null);
  if (ids.length) {
    await saveUndoSnapshot(targets.map((t) => t.norm.url), "全部とじる");
    await chrome.tabs.remove(ids);
  }
  return ids.length;
}

/** Open URLs as background tabs, then gather them (plus already-open report tabs)
 *  into the report group. Groups by created tab ids to avoid the commit race. */
export async function openEntries(urls: string[], settings: Settings): Promise<number> {
  const created: chrome.tabs.Tab[] = [];
  for (const url of urls) {
    created.push(await chrome.tabs.create({ url, active: false }));
  }
  const createdIds = created
    .map((t) => t.id)
    .filter((id): id is number => id != null);
  const windowId = created[0]?.windowId;
  if (windowId != null && createdIds.length) {
    const existing = (await listReportTabs(settings))
      .filter((t) => !t.tab.pinned && t.tab.id != null && t.tab.windowId === windowId)
      .map((t) => t.tab.id!);
    await groupTabIds([...new Set([...existing, ...createdIds])], windowId, settings, false);
  }
  return urls.length;
}

/** Save the currently open report tabs (focused window) as a named set. */
export async function saveCurrentTabSet(name: string, settings: Settings) {
  const targets = await listReportTabs(settings);
  if (!targets.length) return null;
  const { putTabSet } = await import("./repo");
  const set = {
    id: crypto.randomUUID().slice(0, 8),
    name: name.trim() || `セット ${targets.length}件`,
    urls: targets.map((t) => t.norm.url),
    paths: targets.map((t) => t.norm.path),
    createdAt: Date.now()
  };
  await putTabSet(set);
  return set;
}

/** Open a saved set: skips already-open files, then gathers everything into the group. */
export async function openTabSet(id: string, settings: Settings): Promise<number> {
  const { getTabSet } = await import("./repo");
  const set = await getTabSet(id);
  if (!set) return 0;
  const open = new Set((await listReportTabs(settings, true)).map((t) => t.norm.key));
  const toOpen = set.urls.filter((u) => {
    const norm = normalizeFileUrl(u);
    return norm && !open.has(norm.key);
  });
  if (toOpen.length) await openEntries(toOpen, settings);
  else await organizeTabs(settings);
  return set.urls.length;
}

/** Focus an already-open tab for the entry, or open a new one. */
export async function focusOrOpen(
  url: string,
  key: string,
  settings: Settings
): Promise<void> {
  const targets = await listReportTabs(settings, true);
  const found = targets.find((t) => t.norm.key === key);
  if (found?.tab.id != null) {
    // A minimized window ignores { focused: true } — restore it first, or the
    // click appears to do nothing (2026-07-14 デイリーボタン無反応の実害).
    try {
      const win = await chrome.windows.get(found.tab.windowId);
      if (win.state === "minimized") {
        await chrome.windows.update(found.tab.windowId, { state: "normal" });
      }
    } catch {
      /* window may be gone; tabs.update below will throw and surface it */
    }
    await chrome.tabs.update(found.tab.id, { active: true });
    await chrome.windows.update(found.tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
