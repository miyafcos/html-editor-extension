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

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn("setPanelBehavior failed", e));
  if (details.reason === "update") {
    void injectUpdateBanners();
  }
});

function looksLikeHtmlPage(url: string | undefined): boolean {
  if (!url) return false;
  const stripped = url.split(/[?#]/)[0] ?? "";
  if (/^file:\/\//i.test(url)) {
    return /\.html?$/i.test(stripped);
  }
  if (/^https?:\/\//i.test(url)) {
    return /\.html?$/i.test(stripped);
  }
  return false;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && looksLikeHtmlPage(tab.url)) {
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, {
        type: "quick-edit:toggle"
      })) as { ok: boolean; editing?: boolean } | undefined;
      if (res?.ok) return;
    } catch (e) {
      console.warn("quick-edit toggle failed", e);
    }
  }
  if (tab.windowId !== undefined) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch (e) {
      console.warn("sidePanel.open failed", e);
    }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/editor/editor.html") });
});

interface DownloadMessage {
  type: "download-html";
  url: string;
  filename: string;
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
  | EditCurrentTabMessage;

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
});
