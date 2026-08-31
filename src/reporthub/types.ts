export interface ReportEntry {
  id: string;
  /** Last observed raw URL. Preferred when reopening (avoids encode round-trip drift). */
  url: string;
  /** Display path: decoded file path, or host + path for web/pdf targets. */
  path: string;
  /** Kind-specific normalized, lowercased dedup key. */
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
  kind: "web" | "html" | "pdf";
  /** Sub-classification of web targets. Always "other" for html/pdf kinds. */
  service: ServiceId;
  later: boolean;
  laterAt: number | null;
}

/** Compact projection stored under index:newtab. */
export type NewTabIndexEntry = Pick<
  ReportEntry,
  | "id"
  | "url"
  | "path"
  | "key"
  | "title"
  | "group"
  | "lastSeenAt"
  | "visitCount"
  | "pinned"
  | "archived"
  | "kind"
  | "service"
  | "later"
  | "laterAt"
>;

export type ServiceId =
  | "sheet"
  | "drive"
  | "ai"
  | "dev"
  | "comm"
  | "internal"
  | "doc"
  | "search"
  | "study"
  | "media"
  | "shop"
  | "gov"
  | "other";

export type ServiceColorToken =
  | "--svc-sheet"
  | "--svc-doc"
  | "--svc-drive"
  | "--svc-ai"
  | "--svc-dev"
  | "--svc-comm"
  | "--svc-internal"
  | "--svc-search"
  | "--svc-study"
  | "--svc-media"
  | "--svc-shop"
  | "--svc-gov"
  | "--svc-other";

export interface ServiceRuleMatch {
  host?: string[];
  hostSuffix?: string[];
  pathPrefix?: Array<{ host: string; prefix: string }>;
}

export interface ServiceRule {
  id: string;
  label: string;
  match: ServiceRuleMatch;
  color: ServiceColorToken;
  origin: "seed" | "auto" | "user";
  hits: number;
}

export interface ServiceRulesStore {
  version: number;
  rules: ServiceRule[];
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
}

/** Snapshot taken right before a close operation, for やりなおし (undo). Storage key: "undo:lastClosed" */
export interface UndoSnapshot {
  urls: string[];
  label: string;
  ts: number;
}

export interface Meta {
  schemaVersion: 3;
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
  autoDiscardMinutes: 20
};
