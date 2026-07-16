export interface ReportEntry {
  id: string;
  /** Last observed raw URL. Preferred when reopening (avoids encode round-trip drift). */
  url: string;
  /** Decoded display path, forward slashes, NFC-normalized. e.g. "G:/マイドライブ/案件X/レビュー.html" */
  path: string;
  /** Dedup key: path lowercased (Windows FS is case-insensitive). */
  key: string;
  title: string;
  /** Derived group name; recomputable from Settings.groupRules. */
  group: string;
  firstSeenAt: number;
  lastSeenAt: number;
  visitCount: number;
  pinned: boolean;
  archived: boolean;
  /** null = never checked */
  missing: boolean | null;
  missingCheckedAt: number | null;
  source: "live" | "backfill" | "import";
}

export interface GroupRule {
  /** Regex (case-insensitive) applied to ReportEntry.path. */
  pattern: string;
  /** Group name; "$1" etc. substituted from capture groups. */
  group: string;
}

export interface Settings {
  /** Substring match (lowercased) against ReportEntry.key. */
  excludePatterns: string[];
  /** First matching rule wins. */
  groupRules: GroupRule[];
  tabGroupTitle: string;
  tabGroupColor: chrome.tabGroups.ColorEnum;
  /** Minutes before an inactive report tab is discarded. 0 disables automatic discard. */
  autoDiscardMinutes: number;
  /** The Claude Ops daily dashboard — one-tap target for ☀ buttons. */
  dailyDashboardUrl: string;
}

/** Snapshot taken right before a close operation, for やりなおし (undo). Storage key: "undo:lastClosed" */
export interface UndoSnapshot {
  urls: string[];
  label: string;
  ts: number;
}

export interface Meta {
  schemaVersion: 1;
  backfillDoneAt: number | null;
}

/** Saved set of report tabs, reopenable as a batch. Storage key: "tabset:<id>" */
export interface TabSet {
  id: string;
  name: string;
  urls: string[];
  paths: string[];
  createdAt: number;
}

export interface ExportFile {
  schemaVersion: 1;
  exportedAt: number;
  settings: Settings;
  entries: ReportEntry[];
}

export const FALLBACK_GROUP = "その他";

export const DEFAULT_SETTINGS: Settings = {
  excludePatterns: ["/node_modules/", "/.git/", "/dist/assets/", "/coverage/"],
  groupRules: [
    { pattern: "/AppData/Local/Temp/claude/", group: "scratchpad(揮発)" },
    { pattern: "^[a-z]:/マイドライブ/([^/]+)/", group: "$1" },
    { pattern: "^[a-z]:/Users/[^/]+/([^/]+)/", group: "$1" }
  ],
  tabGroupTitle: "レポート",
  tabGroupColor: "blue",
  autoDiscardMinutes: 20,
  dailyDashboardUrl: "file:///C:/Users/miyaz/claude-ops/dashboard/index.html"
};
