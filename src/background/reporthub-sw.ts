/**
 * Report Hub service-worker module: catalogs file:// HTML report visits and
 * serves tab-organization commands. Registered from service-worker.ts via
 * initReportHub(). Keeps its message router strictly scoped to RH_TYPES so it
 * never races the editor's own onMessage responses.
 */
import type { Msg, MsgResponse } from "../reporthub/messages";
import {
  enforceEntryCap,
  getMeta,
  getSettings,
  patchEntryByKey,
  patchMeta,
  upsertVisit
} from "../reporthub/repo";
import {
  closeDuplicateTabs,
  closeReportTabs,
  discardIdleReportTabs,
  discardKey,
  discardReportTabs,
  focusOrOpen,
  listReportTabs,
  openEntries,
  openTabSet,
  organizeTabs,
  saveCurrentTabSet,
  toggleCollapse,
  undoLastClose
} from "../reporthub/tabops";
import { isTargetFile, normalizeFileUrl } from "../reporthub/url";

const RH_TYPES = new Set<Msg["type"]>([
  "organize-tabs",
  "toggle-collapse",
  "close-duplicate-tabs",
  "close-report-tabs",
  "discard-report-tabs",
  "undo-close",
  "focus-or-open",
  "open-hub-dashboard",
  "open-entries",
  "save-tabset",
  "open-tabset",
  "run-backfill"
]);

const visitKey = (tabId: number) => `tabvisit:${tabId}`;
const reloadKey = (tabId: number) => `reload:${tabId}`;
/** Set by onErrorOccurred; the error page still fires onUpdated(complete) with the
 *  original file URL, which must not be recorded as a successful visit. */
const failKey = (tabId: number) => `navfail:${tabId}`;
const AUTO_DISCARD_ALARM = "reporthub:auto-discard";
const AUTO_DISCARD_PERIOD_MINUTES = 5;
const replacementMigrations = new Map<number, Promise<void>>();

async function ensureAutoDiscardAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(AUTO_DISCARD_ALARM);
  if (existing?.periodInMinutes === AUTO_DISCARD_PERIOD_MINUTES) return;
  await chrome.alarms.create(AUTO_DISCARD_ALARM, {
    periodInMinutes: AUTO_DISCARD_PERIOD_MINUTES
  });
}

async function migrateTabSessionKeys(addedTabId: number, removedTabId: number): Promise<void> {
  const oldKeys = [
    visitKey(removedTabId),
    reloadKey(removedTabId),
    failKey(removedTabId),
    discardKey(removedTabId)
  ];
  const newKeys = [
    visitKey(addedTabId),
    reloadKey(addedTabId),
    failKey(addedTabId),
    discardKey(addedTabId)
  ];
  const stored = await chrome.storage.session.get(oldKeys);
  const moved: Record<string, unknown> = {};
  oldKeys.forEach((key, index) => {
    if (Object.prototype.hasOwnProperty.call(stored, key)) moved[newKeys[index]] = stored[key];
  });
  if (Object.keys(moved).length) await chrome.storage.session.set(moved);
  await chrome.storage.session.remove(oldKeys);
}

export function initReportHub(): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  void updateBadge();
  void ensureAutoDiscardAlarm();

  // Backfill once; the null check (not reason==="install") also covers the case
  // where Report Hub arrives via an *update* to the existing HTML Editor install.
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
      await ensureAutoDiscardAlarm();
      const meta = await getMeta();
      if (meta.backfillDoneAt == null) {
        await backfillFromHistory();
        await patchMeta({ backfillDoneAt: Date.now() });
      }
    })();
  });

  chrome.commands.onCommand.addListener((command) => {
    void (async () => {
      const settings = await getSettings();
      if (command === "organize-collapse") await organizeTabs(settings, true);
      else if (command === "toggle-collapse") await toggleCollapse(settings);
    })();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void handleTabUpdated(tabId, changeInfo, tab);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove([
      visitKey(tabId),
      reloadKey(tabId),
      failKey(tabId),
      discardKey(tabId)
    ]);
    void updateBadge();
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const migration = migrateTabSessionKeys(addedTabId, removedTabId).finally(() => {
      if (replacementMigrations.get(addedTabId) === migration) {
        replacementMigrations.delete(addedTabId);
      }
    });
    replacementMigrations.set(addedTabId, migration);
    void migration;
    void updateBadge();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTO_DISCARD_ALARM) return;
    void (async () => {
      const settings = await getSettings();
      if (settings.autoDiscardMinutes > 0) await discardIdleReportTabs(settings);
    })();
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    if (!details.url.startsWith("file:")) return;
    if (details.transitionType === "reload") {
      void chrome.storage.session.set({ [reloadKey(details.tabId)]: true });
    }
  });

  chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId !== 0) return;
    const norm = normalizeFileUrl(details.url);
    if (!norm) return;
    if (!details.error.includes("FILE_NOT_FOUND")) return;
    void chrome.storage.session.set({ [failKey(details.tabId)]: norm.key });
    void patchEntryByKey(norm.key, { missing: true, missingCheckedAt: Date.now() });
  });

  chrome.runtime.onMessage.addListener(
    (msg: Msg, sender, sendResponse: (r: MsgResponse) => void) => {
      if (sender.id !== chrome.runtime.id) return;
      if (!msg || typeof msg !== "object" || !RH_TYPES.has(msg.type)) return;
      void (async () => {
        try {
          const settings = await getSettings();
          switch (msg.type) {
            case "organize-tabs":
              sendResponse({ ok: true, count: await organizeTabs(settings, msg.collapse) });
              break;
            case "toggle-collapse": {
              const state = await toggleCollapse(settings);
              sendResponse({ ok: state !== null, count: state === true ? 1 : 0 });
              break;
            }
            case "save-tabset": {
              const set = await saveCurrentTabSet(msg.name, settings);
              sendResponse({ ok: set !== null, count: set?.urls.length ?? 0 });
              break;
            }
            case "open-tabset":
              sendResponse({ ok: true, count: await openTabSet(msg.id, settings) });
              break;
            case "close-duplicate-tabs":
              sendResponse({ ok: true, count: await closeDuplicateTabs(settings) });
              break;
            case "close-report-tabs":
              sendResponse({ ok: true, count: await closeReportTabs(settings) });
              break;
            case "discard-report-tabs":
              sendResponse({ ok: true, count: await discardReportTabs(settings) });
              break;
            case "undo-close": {
              const restored = await undoLastClose(settings);
              sendResponse({ ok: restored !== null, count: restored ?? 0 });
              break;
            }
            case "focus-or-open": {
              const url = msg.url || settings.dailyDashboardUrl;
              const norm = normalizeFileUrl(url);
              try {
                await focusOrOpen(url, norm?.key ?? url.toLowerCase(), settings);
              } catch (e) {
                // whatever went wrong with focusing, the user asked for the
                // page — a fresh tab is always deliverable
                console.warn("focusOrOpen failed; opening new tab", e);
                await chrome.tabs.create({ url });
              }
              sendResponse({ ok: true, count: 1 });
              break;
            }
            case "open-hub-dashboard":
              await chrome.tabs.create({
                url: chrome.runtime.getURL("src/dashboard/dashboard.html")
              });
              sendResponse({ ok: true, count: 1 });
              break;
            case "open-entries":
              sendResponse({ ok: true, count: await openEntries(msg.urls, settings) });
              break;
            case "run-backfill": {
              const count = await backfillFromHistory();
              await patchMeta({ backfillDoneAt: Date.now() });
              sendResponse({ ok: true, count });
              break;
            }
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
  );
}

/** Toolbar badge = number of open report tabs (all windows). */
async function updateBadge(): Promise<void> {
  try {
    const settings = await getSettings();
    const count = (await listReportTabs(settings, true)).length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  } catch {
    // ignore (e.g. during shutdown)
  }
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab
): Promise<void> {
  if (changeInfo.status === "complete" || changeInfo.url) void updateBadge();
  const norm = normalizeFileUrl(tab.url);
  if (!norm) return;
  const settings = await getSettings();
  if (!isTargetFile(norm, settings)) return;

  if (changeInfo.status === "complete") {
    await replacementMigrations.get(tabId);
    const sess = await chrome.storage.session.get([
      visitKey(tabId),
      reloadKey(tabId),
      failKey(tabId),
      discardKey(tabId)
    ]);
    if (sess[failKey(tabId)] === norm.key) {
      await chrome.storage.session.remove([failKey(tabId), reloadKey(tabId)]);
      return;
    }
    const lastKey = sess[visitKey(tabId)] as string | undefined;
    const reloaded = Boolean(sess[reloadKey(tabId)]);
    const resumedFromDiscard = sess[discardKey(tabId)] === norm.key;
    const countVisit = !resumedFromDiscard && (lastKey !== norm.key || reloaded);
    await chrome.storage.session.set({ [visitKey(tabId)]: norm.key });
    await chrome.storage.session.remove([reloadKey(tabId), discardKey(tabId)]);
    await upsertVisit(
      {
        url: norm.url,
        path: norm.path,
        key: norm.key,
        title: tab.title,
        at: Date.now(),
        source: "live",
        countVisit
      },
      settings
    );
    await enforceEntryCap();
  } else if (changeInfo.title) {
    await patchEntryByKey(norm.key, { title: changeInfo.title });
  }
}

async function backfillFromHistory(): Promise<number> {
  const settings = await getSettings();
  const items = await chrome.history.search({
    text: "",
    startTime: 0,
    maxResults: 100000
  });
  let imported = 0;
  for (const item of items) {
    const norm = normalizeFileUrl(item.url);
    if (!norm || !isTargetFile(norm, settings)) continue;
    const lastVisit = item.lastVisitTime ?? Date.now();
    let firstSeenAt = lastVisit;
    try {
      const visits = await chrome.history.getVisits({ url: item.url! });
      const times = visits.map((v) => v.visitTime).filter((t): t is number => t != null);
      if (times.length) firstSeenAt = Math.min(...times);
    } catch {
      // keep lastVisitTime
    }
    await upsertVisit(
      {
        url: norm.url,
        path: norm.path,
        key: norm.key,
        title: item.title,
        at: lastVisit,
        source: "backfill",
        countVisit: false,
        firstSeenAt,
        visitCount: item.visitCount ?? 1
      },
      settings
    );
    imported++;
  }
  await enforceEntryCap();
  return imported;
}
