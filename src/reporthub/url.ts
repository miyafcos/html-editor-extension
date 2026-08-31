import type { GroupRule, Settings } from "./types";
import { FALLBACK_GROUP } from "./types";

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
