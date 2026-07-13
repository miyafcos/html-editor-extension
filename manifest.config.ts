import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "HTML Editor (WYSIWYG)",
  short_name: "HTML Editor",
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
  content_scripts: [
    {
      js: ["src/content/quick-edit.ts"],
      matches: ["<all_urls>"],
      run_at: "document_idle"
    }
  ],
  permissions: ["storage", "activeTab", "sidePanel", "downloads", "scripting"],
  host_permissions: ["<all_urls>"],
  web_accessible_resources: [
    {
      resources: ["src/editor/editor.html"],
      matches: ["<all_urls>"]
    }
  ]
});
