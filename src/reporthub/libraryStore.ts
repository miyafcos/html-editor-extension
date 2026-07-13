import { create } from "zustand";
import { isFileAccessAllowed } from "./liveness";
import { getAllEntries, getSettings, isEntryStorageKey } from "./repo";
import type { ReportEntry, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

interface LibraryState {
  entries: Record<string, ReportEntry>;
  settings: Settings;
  loaded: boolean;
  fileAccessAllowed: boolean | null;
  load: () => Promise<void>;
}

let subscribed = false;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  entries: {},
  settings: DEFAULT_SETTINGS,
  loaded: false,
  fileAccessAllowed: null,

  load: async () => {
    const [list, settings, fileAccessAllowed] = await Promise.all([
      getAllEntries(),
      getSettings(),
      isFileAccessAllowed()
    ]);
    const entries: Record<string, ReportEntry> = {};
    for (const e of list) entries[e.id] = e;
    set({ entries, settings, loaded: true, fileAccessAllowed });

    if (!subscribed) {
      subscribed = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const cur = { ...get().entries };
        let touched = false;
        let nextSettings = get().settings;
        for (const [k, ch] of Object.entries(changes)) {
          if (isEntryStorageKey(k)) {
            touched = true;
            const nv = ch.newValue as ReportEntry | undefined;
            if (nv) {
              cur[nv.id] = nv;
            } else {
              const ov = ch.oldValue as ReportEntry | undefined;
              if (ov) delete cur[ov.id];
            }
          } else if (k === "settings" && ch.newValue) {
            nextSettings = { ...DEFAULT_SETTINGS, ...(ch.newValue as Partial<Settings>) };
          }
        }
        set({ entries: touched ? cur : get().entries, settings: nextSettings });
      });
    }
  }
}));

export interface EntryFilter {
  query: string;
  group: string | null;
  showArchived: boolean;
  missingOnly: boolean;
}

export function filterEntries(entries: ReportEntry[], f: EntryFilter): ReportEntry[] {
  const q = f.query.trim().toLowerCase().normalize("NFC");
  return entries.filter((e) => {
    if (!f.showArchived && e.archived) return false;
    if (f.missingOnly && e.missing !== true) return false;
    if (f.group && e.group !== f.group) return false;
    if (q && !(e.title.toLowerCase().normalize("NFC").includes(q) || e.key.includes(q))) {
      return false;
    }
    return true;
  });
}

export function groupCounts(entries: ReportEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.archived) continue;
    counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}
