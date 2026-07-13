import { useCallback, useEffect, useRef, useState } from "react";
import { FileBar } from "./components/FileBar";
import { EditorFrame } from "./components/EditorFrame";
import { Ribbon } from "./components/Ribbon";
import { OutlinePane } from "./components/OutlinePane";
import { SearchBar } from "./components/SearchBar";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { CellMenu } from "./components/CellMenu";
import { useEditorStore } from "./store/editorStore";
import {
  openHtmlFile,
  saveHtmlFile,
  saveAsHtmlFile,
  pickAssetsDirectory
} from "./core/fileIO";
import { decodeHtml, splitHtml, assembleHtml } from "./core/htmlSplitter";
import { rearmScripts } from "./core/sanitize";
import {
  saveHandle,
  listRecent,
  touchHandle,
  removeHandle,
  verifyPermission,
  type StoredHandle
} from "./core/handleStore";
import type { AttachedFrame } from "./core/frameBridge";
import type { TemplateDef } from "./templates";
import styles from "./styles/ui.module.css";

export function App() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const opsRef = useRef<AttachedFrame | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const setFile = useEditorStore((s) => s.setFile);
  const setFileFromText = useEditorStore((s) => s.setFileFromText);
  const replaceHandle = useEditorStore((s) => s.replaceHandle);
  const setAssetsDir = useEditorStore((s) => s.setAssetsDir);
  const markClean = useEditorStore((s) => s.markClean);
  const setRecent = useEditorStore((s) => s.setRecent);
  const setSearchOpen = useEditorStore((s) => s.setSearchOpen);
  const hasFile = useEditorStore((s) => s.split !== null);

  const refreshRecent = useCallback(async () => {
    try {
      const list = await listRecent(10);
      setRecent(
        list.map((h) => ({
          id: h.id,
          name: h.name,
          lastOpened: h.lastOpened,
          sourceUrl: h.sourceUrl
        }))
      );
    } catch (e) {
      console.warn("listRecent failed", e);
    }
  }, [setRecent]);

  const loadHandle = useCallback(
    async (handle: FileSystemFileHandle, name: string) => {
      const ok = await verifyPermission(handle, true);
      if (!ok) {
        setStatus("ファイルアクセスが許可されませんでした");
        return;
      }
      const file = await handle.getFile();
      const buffer = await file.arrayBuffer();
      const { text, bom, newline } = decodeHtml(buffer);
      const split = splitHtml(text, bom, newline);
      setFile({ handle, name, split });
      await saveHandle({ name, handle });
      await refreshRecent();
      setStatus(`${name} を開きました`);
    },
    [setFile, refreshRecent]
  );

  const handleOpen = useCallback(async () => {
    setBusy(true);
    try {
      const result = await openHtmlFile();
      if (!result) return;
      await loadHandle(result.handle, result.name);
    } catch (e) {
      setStatus(`開けませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [loadHandle]);

  const handleOpenRecent = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const list = await listRecent(50);
        const item = list.find((h) => h.id === id);
        if (!item) {
          setStatus("該当の最近ファイルが見つかりません");
          return;
        }
        await loadHandle(item.handle, item.name);
        await touchHandle(item.id);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("NotFoundError") || msg.includes("not found")) {
          await removeHandle(id);
          await refreshRecent();
        }
        setStatus(`開けませんでした: ${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [loadHandle, refreshRecent]
  );

  const handleNewFromTemplate = useCallback(
    (tpl: TemplateDef) => {
      try {
        const buffer = new TextEncoder().encode(tpl.html).buffer as ArrayBuffer;
        const { text, bom, newline } = decodeHtml(buffer);
        const split = splitHtml(text, bom, newline);
        setFileFromText({ name: `${tpl.label}.html`, split });
        setStatus(`テンプレ「${tpl.label}」から新規作成しました`);
      } catch (e) {
        setStatus(`テンプレ読込失敗: ${(e as Error).message}`);
      }
    },
    [setFileFromText]
  );

  const buildBytes = useCallback((): Uint8Array | null => {
    const { split } = useEditorStore.getState();
    const ops = opsRef.current;
    if (!split || !ops) return null;
    const editedBody = ops.getBodyInnerForSave();
    const restored = rearmScripts(editedBody);
    return assembleHtml(split, restored);
  }, []);

  const handleSave = useCallback(async () => {
    const state = useEditorStore.getState();
    setBusy(true);
    try {
      const bytes = buildBytes();
      if (!bytes) return;
      if (state.fileHandle) {
        await saveHtmlFile(state.fileHandle, bytes);
        markClean();
        if (state.fileName) {
          await saveHandle({ name: state.fileName, handle: state.fileHandle });
          await refreshRecent();
        }
        setStatus(`保存しました: ${state.fileName ?? ""}`);
        return;
      }
      const handle = await saveAsHtmlFile(bytes, state.fileName ?? "untitled.html");
      if (!handle) return;
      const file = await handle.getFile();
      replaceHandle(handle, file.name);
      await saveHandle({ name: file.name, handle });
      await refreshRecent();
      markClean();
      setStatus(`保存しました: ${file.name}`);
    } catch (e) {
      setStatus(`保存できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [buildBytes, markClean, replaceHandle, refreshRecent]);

  const handleSaveAs = useCallback(async () => {
    const state = useEditorStore.getState();
    setBusy(true);
    try {
      const bytes = buildBytes();
      if (!bytes) return;
      const handle = await saveAsHtmlFile(bytes, state.fileName ?? "untitled.html");
      if (!handle) return;
      const file = await handle.getFile();
      replaceHandle(handle, file.name);
      await saveHandle({ name: file.name, handle });
      await refreshRecent();
      markClean();
      setStatus(`別名で保存しました: ${file.name}`);
    } catch (e) {
      setStatus(`保存できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [buildBytes, markClean, replaceHandle, refreshRecent]);

  const handlePickAssets = useCallback(async () => {
    setBusy(true);
    try {
      const dir = await pickAssetsDirectory();
      if (!dir) return;
      setAssetsDir(dir);
      setStatus(`画像フォルダを設定しました: ${dir.name}`);
    } catch (e) {
      setStatus(`フォルダを指定できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [setAssetsDir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (e.shiftKey) void handleSaveAs();
        else void handleSave();
        return;
      }
      if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true, false);
        return;
      }
      if (mod && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        setSearchOpen(true, true);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleSaveAs, setSearchOpen]);

  const handleAttached = useCallback((ops: AttachedFrame | null) => {
    opsRef.current = ops;
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  useEffect(() => {
    (async () => {
      try {
        const recentData = await chrome.storage.session.get(["pendingRecentId"]);
        const recentId = recentData.pendingRecentId as string | undefined;
        if (recentId) {
          await chrome.storage.session.remove(["pendingRecentId"]);
          await handleOpenRecent(recentId);
          return;
        }
      } catch (e) {
        console.warn("pending recent load failed", e);
      }
      try {
        const data = await chrome.storage.session.get([
          "pendingHtml",
          "pendingName",
          "pendingUrl"
        ]);
        const rawHtml = data.pendingHtml as string | undefined;
        if (!rawHtml) return;
        const buffer = new TextEncoder().encode(rawHtml).buffer as ArrayBuffer;
        const { text, bom, newline } = decodeHtml(buffer);
        const split = splitHtml(text, bom, newline);
        setFileFromText({
          name: (data.pendingName as string) ?? "page.html",
          split,
          sourceUrl: data.pendingUrl as string | undefined
        });
        await chrome.storage.session.remove([
          "pendingHtml",
          "pendingName",
          "pendingUrl",
          "pendingTitle",
          "pendingAt"
        ]);
        setStatus(`表示中のページを読み込みました: ${data.pendingName ?? "page.html"}`);
      } catch (e) {
        console.warn("pending session load failed", e);
      }
    })();
  }, [setFileFromText, handleOpenRecent]);

  return (
    <div className={styles.app}>
      <div className={styles.fileBarArea}>
        <FileBar
          onOpen={handleOpen}
          onSave={handleSave}
          onSaveAs={handleSaveAs}
          onPickAssets={handlePickAssets}
          onNewFromTemplate={handleNewFromTemplate}
          onOpenRecent={handleOpenRecent}
          busy={busy}
        />
      </div>
      <div className={styles.ribbonArea}>
        <Ribbon
          iframeRef={iframeRef}
          disabled={!hasFile || busy}
          onOpenSearch={() => setSearchOpen(true, false)}
          onPickAssets={handlePickAssets}
        />
      </div>
      <div className={styles.searchArea}>
        <SearchBar iframeRef={iframeRef} />
      </div>
      <div className={styles.outlineArea}>
        <OutlinePane iframeRef={iframeRef} attached={hasFile} />
      </div>
      <div className={styles.mainArea}>
        <EditorFrame onAttached={handleAttached} iframeRef={iframeRef} />
        <FloatingToolbar iframeRef={iframeRef} active={hasFile} />
        <CellMenu iframeRef={iframeRef} active={hasFile} />
      </div>
      <footer className={`${styles.status} ${styles.statusArea}`}>
        {status || "Ctrl+S 保存 / Ctrl+F 検索 / Tab でセル移動"}
      </footer>
    </div>
  );
}

// satisfy unused vars
void ([] as StoredHandle[]);
