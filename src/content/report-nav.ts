/**
 * Floating ☀ nav button injected into every file:// HTML page.
 *
 * One tap opens a small hierarchical menu: today's Claude Ops daily dashboard,
 * the Hub library, and the most recent reports of the same group as the
 * current page (read straight from chrome.storage.local entries). Actions are
 * routed through the report-hub service worker (focus-or-open reuses an
 * existing tab instead of piling up duplicates).
 */
import type { ReportEntry } from "../reporthub/types";
import { isEntryStorageKey } from "../reporthub/repo";

// per-page key: Chrome shares one localStorage across all file:// pages, so a
// fixed key would hide the button everywhere (code-review [7])
const HIDE_KEY = `reportnav:hidden:${location.pathname.toLowerCase()}`;
const HOST_ID = "he-report-nav";

function currentKey(): string {
  try {
    return decodeURIComponent(location.pathname)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .normalize("NFC")
      .toLowerCase();
  } catch {
    return location.pathname.toLowerCase();
  }
}

async function sameGroupRecent(limit = 5): Promise<ReportEntry[]> {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => isEntryStorageKey(k))
    .map(([, v]) => v as ReportEntry);
  const me = currentKey();
  const self = entries.find((e) => e.key === me);
  if (!self) return [];
  return entries
    .filter((e) => e.group === self.group && e.key !== me && !e.archived && e.missing !== true)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit);
}

function isHtmlFilePage(): boolean {
  if (location.protocol !== "file:") return false;
  return /\.html?$/i.test(location.pathname);
}

function inject(): void {
  if (!isHtmlFilePage()) return;
  if (document.getElementById(HOST_ID)) return;
  try {
    if (localStorage.getItem(HIDE_KEY) === "1") return;
  } catch {
    /* storage may be unavailable; still show the button */
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
<style>
:host { all: initial; }
* { box-sizing: border-box; font-family: "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif; }
.fab { width: 40px; height: 40px; border-radius: 50%; border: 1px solid #d8dde3;
  background: #fff; color: #b45309; font-size: 19px; cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,.18); opacity: .75; transition: opacity .15s; }
.fab:hover { opacity: 1; }
.menu { position: absolute; right: 0; bottom: 48px; min-width: 230px; max-width: 300px;
  background: #fff; border: 1px solid #d8dde3; border-radius: 10px;
  box-shadow: 0 6px 22px rgba(0,0,0,.2); padding: 6px; display: none; }
.menu.open { display: block; }
.item { display: block; width: 100%; text-align: left; border: none; background: none;
  padding: 8px 10px; font-size: 13px; color: #1f2328; cursor: pointer; border-radius: 7px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item:hover { background: #eef2ff; }
.sub { padding-left: 24px; font-size: 12px; color: #454c54; }
.label { padding: 8px 10px 2px; font-size: 11px; color: #8b949e; }
.sep { border-top: 1px solid #eceff2; margin: 4px 0; }
.hide { color: #8b949e; font-size: 11px; }
</style>
<div class="menu" id="menu"></div>
<button class="fab" id="fab" title="レポートナビ (デイリー / Hub / 同グループ)">☀</button>`;

  const fab = shadow.getElementById("fab") as HTMLButtonElement;
  const menu = shadow.getElementById("menu") as HTMLDivElement;

  const addItem = (label: string, cls: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.className = `item ${cls}`.trim();
    btn.textContent = label;
    btn.addEventListener("click", () => {
      menu.classList.remove("open");
      onClick();
    });
    menu.appendChild(btn);
    return btn;
  };

  const buildMenu = async () => {
    menu.innerHTML = "";
    addItem("☀ 今日のデイリー", "", () => {
      void chrome.runtime.sendMessage({ type: "focus-or-open" });
    });
    addItem("📚 レポート一覧 (Hub)", "", () => {
      void chrome.runtime.sendMessage({ type: "open-hub-dashboard" });
    });
    const siblings = await sameGroupRecent();
    if (siblings.length) {
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = `🗂 同じグループの最近 (${siblings[0].group})`;
      menu.appendChild(label);
      for (const e of siblings) {
        addItem(e.title || e.path.split("/").pop() || e.path, "sub", () => {
          void chrome.runtime.sendMessage({ type: "focus-or-open", url: e.url });
        });
      }
    }
    const sep = document.createElement("div");
    sep.className = "sep";
    menu.appendChild(sep);
    addItem("× このページでは隠す", "hide", () => {
      try {
        localStorage.setItem(HIDE_KEY, "1");
      } catch {
        /* ignore */
      }
      host.remove();
    });
  };

  fab.addEventListener("click", () => {
    if (menu.classList.contains("open")) {
      menu.classList.remove("open");
      return;
    }
    void buildMenu().then(() => menu.classList.add("open"));
  });

  document.documentElement.appendChild(host);
}

inject();
