import type { ReportEntry } from "./types";
import { patchEntry } from "./repo";

/**
 * "Allow access to file URLs" toggle state. When false, fetch-based checks
 * are meaningless (everything would look missing) — callers must skip.
 */
export function isFileAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Only works from extension pages (side panel / dashboard) — the MV3 service
 * worker cannot fetch file: URLs.
 */
export async function checkEntryAlive(entry: ReportEntry): Promise<boolean> {
  try {
    const res = await fetch(entry.url, { cache: "no-store" });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function checkEntries(
  entries: ReportEntry[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void
): Promise<{ checked: number; missing: number }> {
  let idx = 0;
  let done = 0;
  let missing = 0;
  const worker = async () => {
    while (idx < entries.length) {
      const e = entries[idx++];
      const alive = await checkEntryAlive(e);
      if (!alive) missing++;
      await patchEntry(e.id, { missing: !alive, missingCheckedAt: Date.now() });
      done++;
      onProgress?.(done, entries.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(entries.length, 1)) }, worker)
  );
  return { checked: entries.length, missing };
}
