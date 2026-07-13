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
  listReportTabs,
  openEntries,
  openTabSet,
  organizeTabs,
  saveCurrentTabSet,
  toggleCollapse
} from "../reporthub/tabops";
import { isTargetFile, normalizeFileUrl } from "../reporthub/url";

const RH_TYPES = new Set<Msg["type"]>([
  "organize-tabs",
  "toggle-collapse",
  "close-duplicate-tabs",
  "close-report-tabs",
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

export function initReportHub(): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  void updateBadge();

  // Backfill once; the null check (not reason==="install") also covers the case
  // where Report Hub arrives via an *update* to the existing HTML Editor install.
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
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
    void chrome.storage.session.remove([visitKey(tabId), reloadKey(tabId), failKey(tabId)]);
    void updateBadge();
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
    const sess = await chrome.storage.session.get([
      visitKey(tabId),
      reloadKey(tabId),
      failKey(tabId)
    ]);
    if (sess[failKey(tabId)] === norm.key) {
      await chrome.storage.session.remove([failKey(tabId), reloadKey(tabId)]);
      return;
    }
    const lastKey = sess[visitKey(tabId)] as string | undefined;
    const reloaded = Boolean(sess[reloadKey(tabId)]);
    const countVisit = lastKey !== norm.key || reloaded;
    await chrome.storage.session.set({ [visitKey(tabId)]: norm.key });
    await chrome.storage.session.remove(reloadKey(tabId));
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
