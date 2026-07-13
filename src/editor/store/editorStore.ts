import { create } from "zustand";
import type { HtmlSplit } from "../core/htmlSplitter";

export interface RecentFileEntry {
  id: string;
  name: string;
  lastOpened: number;
  sourceUrl?: string;
}

export interface SearchState {
  open: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  showReplace: boolean;
  matchCount: number;
  currentIndex: number;
}

const defaultSearch: SearchState = {
  open: false,
  query: "",
  replacement: "",
  caseSensitive: false,
  showReplace: false,
  matchCount: 0,
  currentIndex: 0
};

export interface EditorState {
  fileHandle: FileSystemFileHandle | null;
  fileName: string | null;
  sourceUrl: string | null;
  split: HtmlSplit | null;
  assetsDir: FileSystemDirectoryHandle | null;
  dirty: boolean;
  recent: RecentFileEntry[];
  outlineOpen: boolean;
  search: SearchState;
  setFile: (params: { handle: FileSystemFileHandle; name: string; split: HtmlSplit }) => void;
  setFileFromText: (params: { name: string; split: HtmlSplit; sourceUrl?: string }) => void;
  replaceHandle: (handle: FileSystemFileHandle, name: string) => void;
  setAssetsDir: (dir: FileSystemDirectoryHandle | null) => void;
  setRecent: (recent: RecentFileEntry[]) => void;
  toggleOutline: () => void;
  setSearchOpen: (open: boolean, showReplace?: boolean) => void;
  setSearch: (patch: Partial<SearchState>) => void;
  markDirty: () => void;
  markClean: () => void;
  reset: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  fileHandle: null,
  fileName: null,
  sourceUrl: null,
  split: null,
  assetsDir: null,
  dirty: false,
  recent: [],
  outlineOpen: true,
  search: defaultSearch,
  setFile: ({ handle, name, split }) =>
    set({ fileHandle: handle, fileName: name, sourceUrl: null, split, dirty: false }),
  setFileFromText: ({ name, split, sourceUrl }) =>
    set({
      fileHandle: null,
      fileName: name,
      sourceUrl: sourceUrl ?? null,
      split,
      dirty: false
    }),
  replaceHandle: (handle, name) =>
    set({ fileHandle: handle, fileName: name, sourceUrl: null, dirty: false }),
  setAssetsDir: (dir) => set({ assetsDir: dir }),
  setRecent: (recent) => set({ recent }),
  toggleOutline: () => set({ outlineOpen: !get().outlineOpen }),
  setSearchOpen: (open, showReplace = false) =>
    set((s) => ({
      search: open
        ? { ...s.search, open, showReplace }
        : { ...defaultSearch }
    })),
  setSearch: (patch) => set((s) => ({ search: { ...s.search, ...patch } })),
  markDirty: () => set({ dirty: true }),
  markClean: () => set({ dirty: false }),
  reset: () =>
    set({
      fileHandle: null,
      fileName: null,
      sourceUrl: null,
      split: null,
      assetsDir: null,
      dirty: false,
      search: defaultSearch
    })
}));
