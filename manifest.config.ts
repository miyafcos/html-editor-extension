import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "HTML Hub — 編集 + レポート管理",
  short_name: "HTML Hub",
  version: pkg.version,
  description: pkg.description,
  icons: {
    "16": "public/icons/icon-16.png",
    "32": "public/icons/icon-32.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png"
  },
  action: {
    default_title: "HTML Editor を開く"
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module"
  },
  side_panel: {
    default_path: "src/sidepanel/sidepanel.html"
  },
  chrome_url_overrides: {
    newtab: "src/newtab/index.html"
  },
  content_scripts: [
    {
      // 2026-07-14 perf: was <all_urls> — no reason to load the editor script
      // into every website; file pages and *.html(.htm) URLs cover real usage.
      // Trailing * keeps query-string URLs (page.html?x=1) matched — match
      // patterns compare against path+query (code-review [6])
      js: ["src/content/quick-edit.ts"],
      matches: ["file:///*", "*://*/*.html*", "*://*/*.htm*"],
      run_at: "document_idle"
    }
  ],
  permissions: [
    "storage",
    "activeTab",
    "sidePanel",
    "downloads",
    "scripting",
    "tabs",
    "tabGroups",
    "history",
    "webNavigation",
    "alarms",
    "search",
    "favicon"
  ],
  host_permissions: ["<all_urls>"],
  web_accessible_resources: [
    {
      resources: ["src/editor/editor.html"],
      matches: ["<all_urls>"]
    }
  ],
  commands: {
    "organize-collapse": {
      suggested_key: { default: "Ctrl+Shift+9" },
      description: "レポートタブを集約して畳む (ぐっとまとめる)"
    },
    "toggle-collapse": {
      suggested_key: { default: "Ctrl+Shift+8" },
      description: "レポートグループの畳み/展開を切り替え"
    }
  }
});
