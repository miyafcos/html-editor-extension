import { initReportHub } from "./reporthub-sw";

initReportHub();

async function openEditorForTab(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.id) return false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        html: "<!DOCTYPE html>\n" + document.documentElement.outerHTML,
        title: document.title || "",
        url: location.href
      })
    });
    if (!result) return false;
    let suggestedName = "page.html";
    try {
      const u = new URL(result.url);
      const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
      if (last) suggestedName = last;
    } catch {
      /* keep default */
    }
    await chrome.storage.session.set({
      pendingHtml: result.html,
      pendingName: suggestedName,
      pendingUrl: result.url,
      pendingTitle: result.title,
      pendingAt: Date.now()
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
    return true;
  } catch (e) {
    console.warn("openEditorForTab failed", e);
    return false;
  }
}

async function injectUpdateBanners() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["file:///*", "*://*/*.html", "*://*/*.htm"]
    });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const w = window as unknown as Record<string, unknown>;
            if (w.__HE_UPDATE_BANNER__) return;
            w.__HE_UPDATE_BANNER__ = true;
            const host = document.createElement("div");
            host.id = "he-update-banner";
            host.style.cssText =
              "position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:auto;";
            const shadow = host.attachShadow({ mode: "closed" });
            shadow.innerHTML =
              '<style>:host{all:initial;}.banner{background:#fbbf24;color:#78350f;padding:10px 16px;' +
              'display:flex;align-items:center;justify-content:center;gap:12px;' +
              'font-family:"Segoe UI","Yu Gothic UI","Meiryo",sans-serif;font-size:13px;' +
              'box-shadow:0 2px 8px rgba(0,0,0,0.15);}button{background:#78350f;color:#fff;border:none;' +
              'padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit;}' +
              'button:hover{background:#451a03;}.close{background:transparent;color:#78350f;border:1px solid #78350f;}' +
              '</style><div class="banner"><span>🔄 HTML Editor 拡張が更新されました。F5 でこのページをリロードしてください。</span>' +
              '<button data-act="reload">F5 リロード</button>' +
              '<button class="close" data-act="close">×</button></div>';
            shadow.addEventListener("click", (e) => {
              const t = e.target as HTMLElement;
              const act = t.dataset?.act;
              if (act === "reload") location.reload();
              if (act === "close") host.remove();
            });
            document.documentElement.appendChild(host);
          }
        });
      } catch {
        /* chrome:// 等は失敗、握り潰し */
      }
    }
  } catch (e) {
    console.warn("injectUpdateBanners failed", e);
  }
}

// 2026-07-14 ユーザー報告「サイドバーが開かないことが結構ある」: 旧設計はHTMLページで
// quick-edit トグルを先に試す分岐があり、その await 中に user gesture が失効して
// sidePanel.open が落ちることがあった。アイコンは常にサイドパネル固定 (Chrome の
// ネイティブ挙動に委譲・gesture 問題が構造的に消える)。その場編集はパネルの
// ✏️編集タブ「このタブをその場で編集」から。
function applyPanelBehavior(): void {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("setPanelBehavior failed", e));
}

applyPanelBehavior();

chrome.runtime.onInstalled.addListener((details) => {
  applyPanelBehavior();
  if (details.reason === "update") {
    void injectUpdateBanners();
  }
});

interface DownloadMessage {
  type: "download-html";
  url: string;
  filename: string;
}

interface ClaudeOpsDecisionMessage {
  type: "claudeops-decision";
  qid: string;
  action: string;
  note: string;
  ts: string;
}

const CLAUDEOPS_QID_RE = /^q-\d{8}-\d{6}-[0-9a-f]{4}$/;
const CLAUDEOPS_ACTIONS = new Set(["done", "dismissed", "note"]);
// Native messaging host (C:/Users/miyaz/claude-ops/bin/decisions_host.py) —
// writes the decision file directly, no chrome.downloads involved
const CLAUDEOPS_NATIVE_HOST = "com.claude_ops.decisions";

/** UTF-8 safe base64 for a data: URL (no Blob URLs in MV3 service workers). */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function waitForDownloadEnd(id: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }
    function onChanged(delta: chrome.downloads.DownloadDelta) {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") done();
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

/**
 * Persist a dashboard decision as a JSON file under
 * Downloads/claude-ops-decisions/. The Claude Ops watcher polls that folder
 * (15 min cycle), applies the decision to its queue, then deletes the file.
 *
 * Primary path (2026-07-14 ユーザー報告「JSONがダウンロードされる設計はやめて・
 * 反映だけされればいい」): a native messaging host writes the file directly —
 * no chrome.downloads, nothing in the download UI at all. If the host is not
 * registered (registry key absent), we fall back to a suppressed download
 * (UI disabled during the write + history entry erased afterwards).
 */
async function saveClaudeOpsDecision(message: ClaudeOpsDecisionMessage): Promise<void> {
  const payload = {
    qid: message.qid,
    action: message.action,
    note: message.note,
    ts: message.ts,
    via: "html-hub-extension"
  };
  try {
    const res = (await chrome.runtime.sendNativeMessage(CLAUDEOPS_NATIVE_HOST, payload)) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (res?.ok) return;
    throw new Error(res?.error ?? "native host rejected the decision");
  } catch (e) {
    console.warn("claudeops native host unavailable — silent download fallback", e);
  }
  const body = JSON.stringify(payload);
  try {
    await chrome.downloads.setUiOptions({ enabled: false });
  } catch {
    /* downloads.ui unavailable — fall through, worst case the shelf blips */
  }
  try {
    const id = await chrome.downloads.download({
      url: `data:application/json;base64,${toBase64Utf8(body)}`,
      filename: `claude-ops-decisions/decision-${message.qid}-${Date.now()}.json`,
      saveAs: false,
      conflictAction: "uniquify"
    });
    await waitForDownloadEnd(id);
    await chrome.downloads.erase({ id });
  } finally {
    try {
      await chrome.downloads.setUiOptions({ enabled: true });
    } catch {
      /* ignore */
    }
  }
}

interface OpenEditorMessage {
  type: "open-editor-tab";
}

interface ToggleQuickEditMessage {
  type: "toggle-quick-edit";
}

interface EditCurrentTabMessage {
  type: "edit-current-tab";
}

type IncomingMessage =
  | DownloadMessage
  | OpenEditorMessage
  | ToggleQuickEditMessage
  | EditCurrentTabMessage
  | ClaudeOpsDecisionMessage;

chrome.runtime.onMessage.addListener((message: IncomingMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message.type === "open-editor-tab") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("src/editor/editor.html") })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message.type === "edit-current-tab") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendResponse({ ok: false, error: "アクティブタブが見つかりません" });
        return;
      }
      if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
        sendResponse({ ok: false, error: "このページは編集できません" });
        return;
      }
      const ok = await openEditorForTab(tab);
      sendResponse({ ok, error: ok ? undefined : "取得に失敗しました" });
    })();
    return true;
  }

  if (message.type === "toggle-quick-edit") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "アクティブタブが見つかりません" });
        return;
      }
      if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
        sendResponse({ ok: false, error: "このページは編集モードにできません" });
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "quick-edit:toggle" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === "download-html") {
    chrome.downloads
      .download({ url: message.url, filename: message.filename, saveAs: true })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message.type === "claudeops-decision") {
    if (!CLAUDEOPS_QID_RE.test(message.qid) || !CLAUDEOPS_ACTIONS.has(message.action)) {
      sendResponse({ ok: false, error: "invalid decision payload" });
      return;
    }
    // Respond immediately: downloads.download can take seconds on SW cold
    // start, and the dashboard's optimistic UI waits on this ack. The decision
    // file is fire-and-forget; the watcher-rendered queue state is the truth
    // and a failed write resurfaces the card after the optimistic TTL.
    sendResponse({ ok: true });
    saveClaudeOpsDecision(message).catch((e) => console.warn("claudeops decision save failed", e));
    return;
  }
});
