import { S } from "../newtab/strings";
import type {
  GroupRule,
  ServiceColorToken,
  ServiceId,
  ServiceRule,
  ServiceRulesStore,
  Settings
} from "./types";
import { FALLBACK_GROUP } from "./types";

export const SERVICE_RULES_VERSION = 1;

export const SERVICE_IDS: ServiceId[] = [
  "sheet",
  "doc",
  "drive",
  "ai",
  "dev",
  "comm",
  "internal",
  "search",
  "study",
  "media",
  "shop",
  "gov",
  "other"
];

const AUTO_COLOR_TOKENS: ServiceColorToken[] = [
  "--svc-sheet",
  "--svc-doc",
  "--svc-drive",
  "--svc-ai",
  "--svc-dev",
  "--svc-comm",
  "--svc-internal",
  "--svc-search",
  "--svc-study",
  "--svc-media",
  "--svc-shop",
  "--svc-gov"
];

export const SEED_SERVICE_RULES: ServiceRulesStore = {
  version: SERVICE_RULES_VERSION,
  rules: [
    {
      id: "sheet",
      label: S.service.sheet,
      match: {
        host: ["sheets.google.com"],
        pathPrefix: [{ host: "docs.google.com", prefix: "/spreadsheets" }]
      },
      color: "--svc-sheet",
      origin: "seed",
      hits: 0
    },
    {
      id: "doc",
      label: S.service.doc,
      match: {
        host: ["slides.google.com"],
        hostSuffix: ["officeapps.live.com"],
        pathPrefix: [
          { host: "docs.google.com", prefix: "/document" },
          { host: "docs.google.com", prefix: "/presentation" },
          { host: "docs.google.com", prefix: "/forms" },
          { host: "onedrive.live.com", prefix: "/edit.aspx" },
          { host: "onedrive.live.com", prefix: "/view.aspx" }
        ]
      },
      color: "--svc-doc",
      origin: "seed",
      hits: 0
    },
    {
      id: "drive",
      label: S.service.drive,
      match: { host: ["drive.google.com", "dropbox.com", "box.com", "onedrive.live.com", "1drv.ms"] },
      color: "--svc-drive",
      origin: "seed",
      hits: 0
    },
    {
      id: "ai",
      label: S.service.ai,
      match: {
        host: [
          "claude.ai",
          "chatgpt.com",
          "chat.openai.com",
          "gemini.google.com",
          "notebooklm.google.com",
          "cloud.dify.ai",
          "cursor.com",
          "perplexity.ai",
          "felo.ai"
        ]
      },
      color: "--svc-ai",
      origin: "seed",
      hits: 0
    },
    {
      id: "dev",
      label: S.service.dev,
      match: {
        host: [
          "github.com",
          "gitlab.com",
          "stackoverflow.com",
          "developer.mozilla.org",
          "developer.chrome.com",
          "chromium.googlesource.com",
          "npmjs.com",
          "zenn.dev",
          "qiita.com",
          "console.cloud.google.com",
          "script.google.com"
        ]
      },
      color: "--svc-dev",
      origin: "seed",
      hits: 0
    },
    {
      id: "comm",
      label: S.service.comm,
      match: {
        host: [
          "mail.google.com",
          "slack.com",
          "chatwork.com",
          "teams.microsoft.com",
          "discord.com",
          "calendar.google.com"
        ]
      },
      color: "--svc-comm",
      origin: "seed",
      hits: 0
    },
    {
      id: "internal",
      label: S.service.internal,
      match: {
        host: ["localhost", "127.0.0.1", "momosta-app.com", "jobcan.jp", "gridy.jp", "daj.co.jp"],
        hostSuffix: ["railway.app", "vercel.app", "ts.net"]
      },
      color: "--svc-internal",
      origin: "seed",
      hits: 0
    },
    {
      id: "search",
      label: S.service.search,
      match: {
        host: ["bing.com", "duckduckgo.com", "search.yahoo.co.jp"],
        pathPrefix: [{ host: "google.com", prefix: "/search" }]
      },
      color: "--svc-search",
      origin: "seed",
      hits: 0
    },
    {
      id: "study",
      label: S.service.study,
      match: {
        host: ["toshin.com", "pos.toshin.com", "yozemi.ac.jp", "studysapuri.jp", "texwiki.texjp.org", "manavi2000.com"]
      },
      color: "--svc-study",
      origin: "seed",
      hits: 0
    },
    {
      id: "media",
      label: S.service.media,
      match: { host: ["youtube.com", "nhk.or.jp", "sports.yahoo.co.jp", "netflix.com", "open.spotify.com"] },
      color: "--svc-media",
      origin: "seed",
      hits: 0
    },
    {
      id: "shop",
      label: S.service.shop,
      match: { host: ["amazon.co.jp", "amazon.com", "rakuten.co.jp", "auctions.yahoo.co.jp", "yodobashi.com", "keepa.com"] },
      color: "--svc-shop",
      origin: "seed",
      hits: 0
    },
    {
      id: "gov",
      label: S.service.gov,
      match: { host: ["mext.go.jp"], hostSuffix: ["go.jp", "lg.jp"] },
      color: "--svc-gov",
      origin: "seed",
      hits: 0
    },
    {
      id: "other",
      label: S.service.other,
      match: {},
      color: "--svc-other",
      origin: "seed",
      hits: 0
    }
  ]
};

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function hostMatches(host: string, target: string): boolean {
  const normalizedHost = normalizeHostname(host);
  const normalizedTarget = normalizeHostname(target).replace(/^\*?\./, "");
  return normalizedHost === normalizedTarget || normalizedHost.endsWith(`.${normalizedTarget}`);
}

function ruleMatches(rule: ServiceRule, parsed: URL): boolean {
  const host = normalizeHostname(parsed.hostname);
  if (rule.match.pathPrefix?.some((item) => hostMatches(host, item.host) && parsed.pathname.startsWith(item.prefix))) {
    return true;
  }
  if (rule.match.host?.some((target) => hostMatches(host, target))) return true;
  return rule.match.hostSuffix?.some((suffix) => hostMatches(host, suffix)) ?? false;
}

export function matchServiceRule(url: string, rules: ServiceRule[]): ServiceRule | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return rules.find((rule) => rule.id === "other") ?? null;
  }
  const fallback = rules.find((rule) => rule.id === "other") ?? null;
  for (const rule of rules) {
    if (rule.id !== "other" && ruleMatches(rule, parsed)) return rule;
  }
  return fallback;
}

export function isServiceId(id: string): id is ServiceId {
  return SERVICE_IDS.includes(id as ServiceId);
}

export function inferService(url: string, kind: NormalizedTarget["kind"], rules: ServiceRule[]): ServiceId {
  if (kind !== "web") return "other";
  const id = matchServiceRule(url, rules)?.id ?? "other";
  return isServiceId(id) ? id : "other";
}

export function serviceHostname(url: string): string | null {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

function namePartFromHost(host: string): string {
  const parts = normalizeHostname(host).split(".").filter(Boolean);
  while (parts.length > 1 && (parts[0] === "www" || parts[0] === "app")) parts.shift();
  const compoundSuffix = parts.length >= 3 && ["co", "ac", "go", "lg", "or"].includes(parts.at(-2) ?? "");
  return compoundSuffix ? parts.at(-3) ?? parts[0] ?? host : parts.at(-2) ?? parts[0] ?? host;
}

export function autoServiceLabel(host: string): string {
  const part = namePartFromHost(host);
  return part ? part[0].toUpperCase() + part.slice(1) : host;
}

export function autoServiceId(host: string): string {
  return `auto:${normalizeHostname(host)}`;
}

function hashHost(host: string): number {
  let hash = 2166136261;
  for (const char of normalizeHostname(host)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function autoServiceColor(host: string, rules: ServiceRule[]): ServiceColorToken {
  const used = new Set(rules.filter((rule) => rule.origin === "auto").map((rule) => rule.color));
  const start = hashHost(host) % AUTO_COLOR_TOKENS.length;
  for (let offset = 0; offset < AUTO_COLOR_TOKENS.length; offset++) {
    const token = AUTO_COLOR_TOKENS[(start + offset) % AUTO_COLOR_TOKENS.length];
    if (!used.has(token)) return token;
  }
  return AUTO_COLOR_TOKENS[start];
}

export function hostDisplayName(url: string): string {
  const host = serviceHostname(url);
  return host ? autoServiceLabel(host) : url;
}

export interface NormalizedFile {
  url: string;
  path: string;
  key: string;
}

export interface NormalizedTarget {
  url: string;
  path: string;
  key: string;
  kind: "web" | "html" | "pdf";
}

/**
 * file:// URL → decoded path + dedup key.
 * Returns null for non-file URLs.
 */
export function normalizeFileUrl(rawUrl: string | null | undefined): NormalizedFile | null {
  if (!rawUrl || !rawUrl.startsWith("file:")) return null;
  let u = rawUrl;
  const cut = u.search(/[?#]/);
  if (cut >= 0) u = u.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(u);
  } catch {
    decoded = u;
  }
  decoded = decoded.replace(/\\/g, "/");
  let path: string;
  if (decoded.startsWith("file:///")) {
    path = decoded.slice(8);
  } else if (decoded.startsWith("file://")) {
    // UNC: file://server/share/... → //server/share/...
    path = "//" + decoded.slice(7);
  } else {
    path = decoded.slice(5);
  }
  path = path.normalize("NFC");
  if (!path) return null;
  return { url: rawUrl, path, key: path.toLowerCase() };
}

export function pathToFileUrl(path: string): string {
  const encoded = encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return path.startsWith("//") ? "file:" + encoded : "file:///" + encoded;
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

export function isExcluded(key: string, settings: Settings): boolean {
  return settings.excludePatterns.some((p) => p && key.includes(p.toLowerCase()));
}

export function isTargetFile(norm: NormalizedFile, settings: Settings): boolean {
  return isHtmlPath(norm.path) && !isExcluded(norm.key, settings);
}

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_eid", "_ga"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/** Normalize every URL kind tracked by the new-tab hub. */
export function normalizeTarget(
  rawUrl: string | null | undefined,
  settings: Settings
): NormalizedTarget | null {
  if (!rawUrl) return null;
  if (rawUrl.startsWith("file:")) {
    const norm = normalizeFileUrl(rawUrl);
    if (!norm || isExcluded(norm.key, settings)) return null;
    const kind = isHtmlPath(norm.path) ? "html" : /\.pdf$/i.test(norm.path) ? "pdf" : null;
    return kind ? { ...norm, kind } : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  for (const name of [...parsed.searchParams.keys()]) {
    if (isTrackingParam(name)) parsed.searchParams.delete(name);
  }
  let pathname = parsed.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  const query = parsed.searchParams.toString();
  const key = `${parsed.host}${pathname}${query ? `?${query}` : ""}`
    .toLowerCase()
    .normalize("NFC");
  if (isExcluded(key, settings)) return null;

  return {
    url: rawUrl,
    path: `${parsed.host}${parsed.pathname}`.normalize("NFC"),
    key,
    kind: /\.pdf$/i.test(parsed.pathname) ? "pdf" : "web"
  };
}

export function inferGroup(path: string, rules: GroupRule[]): string {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      continue;
    }
    const m = re.exec(path);
    if (m) {
      return rule.group.replace(/\$(\d)/g, (_all, d: string) => m[Number(d)] ?? "");
    }
  }
  return FALLBACK_GROUP;
}

export function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

export async function entryIdFromKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
