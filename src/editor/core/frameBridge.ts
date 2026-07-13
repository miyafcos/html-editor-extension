import { readDirectoryFile } from "./fileIO";

const REWRITE_ATTR = "data-orig-src";

export interface AttachedFrame {
  setBodyInner(html: string): void;
  enableEdit(): void;
  getBodyInnerForSave(): string;
  onDirty(cb: () => void): () => void;
  onKeyDown(cb: (e: KeyboardEvent) => void): () => void;
  onPaste(cb: (e: ClipboardEvent) => void): () => void;
  onDrop(cb: (e: DragEvent) => void): () => void;
  onSelectionChange(cb: () => void): () => void;
  rewriteImagesForView(dir: FileSystemDirectoryHandle): Promise<void>;
  getIframe(): HTMLIFrameElement | null;
  dispose(): void;
}

type Listener<T = unknown> = (value: T) => void;

export function attachFrame(iframe: HTMLIFrameElement): AttachedFrame {
  let observer: MutationObserver | null = null;
  let dirtyListeners: Array<() => void> = [];
  let keyListeners: Array<Listener<KeyboardEvent>> = [];
  let pasteListeners: Array<Listener<ClipboardEvent>> = [];
  let dropListeners: Array<Listener<DragEvent>> = [];
  let selectionListeners: Array<() => void> = [];
  let blobUrls: string[] = [];
  let docListenersBound = false;

  const doc = () => iframe.contentDocument;

  const fireDirty = () => {
    for (const cb of dirtyListeners) cb();
  };

  function bindDocListeners() {
    const d = doc();
    if (!d || docListenersBound) return;
    docListenersBound = true;
    d.addEventListener("keydown", (e) => keyListeners.forEach((cb) => cb(e)), true);
    d.addEventListener("paste", (e) => pasteListeners.forEach((cb) => cb(e)));
    d.addEventListener("drop", (e) => dropListeners.forEach((cb) => cb(e)));
    d.addEventListener("dragover", (e) => e.preventDefault());
    d.addEventListener("selectionchange", () =>
      selectionListeners.forEach((cb) => cb())
    );
  }

  return {
    setBodyInner(html) {
      const d = doc();
      if (!d || !d.body) return;
      d.body.innerHTML = html;
    },

    enableEdit() {
      const d = doc();
      if (!d || !d.body) return;
      d.body.setAttribute("contenteditable", "true");
      d.body.style.outline = "none";
      observer?.disconnect();
      observer = new MutationObserver(fireDirty);
      observer.observe(d.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
      bindDocListeners();
    },

    getBodyInnerForSave() {
      const d = doc();
      if (!d || !d.body) return "";
      const clone = d.body.cloneNode(true) as HTMLElement;
      clone.removeAttribute("contenteditable");
      clone.style.removeProperty("outline");
      if (clone.getAttribute("style") === "") clone.removeAttribute("style");
      clone.querySelectorAll<HTMLImageElement>(`img[${REWRITE_ATTR}]`).forEach((img) => {
        const orig = img.getAttribute(REWRITE_ATTR);
        if (orig !== null) {
          img.setAttribute("src", orig);
          img.removeAttribute(REWRITE_ATTR);
        }
      });
      // strip search marks
      clone.querySelectorAll("mark.he-search-mark").forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        m.remove();
      });
      return clone.innerHTML;
    },

    onDirty(cb) {
      dirtyListeners.push(cb);
      return () => {
        dirtyListeners = dirtyListeners.filter((c) => c !== cb);
      };
    },

    onKeyDown(cb) {
      keyListeners.push(cb);
      bindDocListeners();
      return () => {
        keyListeners = keyListeners.filter((c) => c !== cb);
      };
    },

    onPaste(cb) {
      pasteListeners.push(cb);
      bindDocListeners();
      return () => {
        pasteListeners = pasteListeners.filter((c) => c !== cb);
      };
    },

    onDrop(cb) {
      dropListeners.push(cb);
      bindDocListeners();
      return () => {
        dropListeners = dropListeners.filter((c) => c !== cb);
      };
    },

    onSelectionChange(cb) {
      selectionListeners.push(cb);
      bindDocListeners();
      return () => {
        selectionListeners = selectionListeners.filter((c) => c !== cb);
      };
    },

    async rewriteImagesForView(dir) {
      const d = doc();
      if (!d || !d.body) return;
      const imgs = Array.from(d.body.querySelectorAll<HTMLImageElement>("img"));
      for (const img of imgs) {
        const src = img.getAttribute("src");
        if (!src) continue;
        if (/^(https?:|data:|blob:|chrome-extension:)/i.test(src)) continue;
        const file = await readDirectoryFile(dir, src);
        if (!file) continue;
        const url = URL.createObjectURL(file);
        blobUrls.push(url);
        img.setAttribute(REWRITE_ATTR, src);
        img.setAttribute("src", url);
      }
    },

    getIframe() {
      return iframe;
    },

    dispose() {
      observer?.disconnect();
      observer = null;
      dirtyListeners = [];
      keyListeners = [];
      pasteListeners = [];
      dropListeners = [];
      selectionListeners = [];
      docListenersBound = false;
      for (const url of blobUrls) URL.revokeObjectURL(url);
      blobUrls = [];
    }
  };
}
