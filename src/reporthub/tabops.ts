import type { Settings, UndoSnapshot } from "./types";
import type { NormalizedFile } from "./url";
import { isTargetFile, normalizeFileUrl } from "./url";

/** storage.local key for the やりなおし (undo) snapshot of the last close op. */
export const UNDO_KEY = "undo:lastClosed";

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
  await chrome.storage.local.remove(UNDO_KEY);
  await openEntries(snapshot.urls, settings);
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
  if (!tabIds.length) return;
  const existing = await chrome.tabGroups.query({ windowId, title: settings.tabGroupTitle });
  let groupId: number;
  if (existing.length) {
    groupId = existing[0].id;
    await chrome.tabs.group({ tabIds, groupId });
    await chrome.tabGroups.update(groupId, { color: settings.tabGroupColor });
  } else {
    groupId = await chrome.tabs.group({
      tabIds,
      createProperties: { windowId }
    });
    await chrome.tabGroups.update(groupId, {
      title: settings.tabGroupTitle,
      color: settings.tabGroupColor
    });
  }
  if (collapse) await collapseGroup(groupId, windowId);
}

/** Collapse a group; if every unpinned tab is inside it Chrome refuses, so park on a new tab first. */
async function collapseGroup(groupId: number, windowId: number): Promise<void> {
  try {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  } catch {
    await chrome.tabs.create({ windowId, active: true });
    await chrome.tabGroups.update(groupId, { collapsed: true });
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
  if (next) await collapseGroup(groups[0].id, win.id!);
  else await chrome.tabGroups.update(groups[0].id, { collapsed: false });
  return next;
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
