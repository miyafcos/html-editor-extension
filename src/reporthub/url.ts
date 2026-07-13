import type { GroupRule, Settings } from "./types";
import { FALLBACK_GROUP } from "./types";

export interface NormalizedFile {
  url: string;
  path: string;
  key: string;
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
