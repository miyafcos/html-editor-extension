import { useState, useCallback, useEffect } from "react";
import { listRecent, type StoredHandle } from "../editor/core/handleStore";
import { ReportPanel } from "../reporthub/ReportPanel";
import styles from "./sidepanel.module.css";

type PanelTab = "report" | "editor";
const PANEL_TAB_KEY = "ui:panelTab";

export function SidePanel() {
  const [tab, setTab] = useState<PanelTab>("report");
  const [tabLoaded, setTabLoaded] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get(PANEL_TAB_KEY).then((got) => {
      const v = got[PANEL_TAB_KEY];
      if (v === "editor" || v === "report") setTab(v);
      setTabLoaded(true);
    });
  }, []);

  const select = useCallback((t: PanelTab) => {
    setTab(t);
    void chrome.storage.local.set({ [PANEL_TAB_KEY]: t });
  }, []);

  if (!tabLoaded) return null;

  return (
    <div className={styles.tabRoot}>
      <div className={styles.tabBar}>
        <button
          className={tab === "report" ? styles.tabActive : styles.tabBtn}
          onClick={() => select("report")}
        >
          📚 レポート
        </button>
        <button
          className={tab === "editor" ? styles.tabActive : styles.tabBtn}
          onClick={() => select("editor")}
        >
          ✏️ 編集
        </button>
      </div>
      <div className={styles.tabBody}>
        {tab === "report" ? <ReportPanel /> : <EditorPanel />}
      </div>
    </div>
  );
}

function EditorPanel() {
  const [status, setStatus] = useState<string>("操作を選んでください。");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<StoredHandle[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await listRecent(10);
      setRecent(list);
    } catch (e) {
      console.warn("listRecent failed", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const editCurrentTab = useCallback(() => {
    setBusy(true);
    chrome.runtime.sendMessage(
      { type: "edit-current-tab" },
      (res: { ok: boolean; error?: string } | undefined) => {
        setBusy(false);
        if (res?.ok) setStatus("このタブの HTML をエディタタブで開きました");
        else setStatus("開けませんでした: " + (res?.error ?? "unknown"));
      }
    );
  }, []);

  const openEditor = useCallback(() => {
    setBusy(true);
    chrome.runtime.sendMessage(
      { type: "open-editor-tab" },
      (res: { ok: boolean; error?: string } | undefined) => {
        setBusy(false);
        if (res?.ok) setStatus("エディタタブを開きました");
        else setStatus("エディタタブを開けませんでした: " + (res?.error ?? "unknown"));
      }
    );
  }, []);

  const openRecent = useCallback(
    async (item: StoredHandle) => {
      setBusy(true);
      try {
        await chrome.storage.session.set({ pendingRecentId: item.id });
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/editor/editor.html")
        });
        setStatus(`「${item.name}」をエディタで開きます`);
      } catch (e) {
        setStatus("開けませんでした: " + (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const toggleQuickEdit = useCallback(() => {
    setBusy(true);
    chrome.runtime.sendMessage(
      { type: "toggle-quick-edit" },
      (res: { ok: boolean; error?: string } | undefined) => {
        setBusy(false);
        if (res?.ok) {
          setStatus("このタブを編集モードに切り替えました。もう一度押すと解除します。");
        } else {
          setStatus("切り替えできません: " + (res?.error ?? "unknown"));
        }
      }
    );
  }, []);

  const downloadCurrent = useCallback(async () => {
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus("アクティブタブが見つかりません");
        return;
      }
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          html: "<!DOCTYPE html>\n" + document.documentElement.outerHTML,
          title: document.title || "page"
        })
      });
      if (!result) {
        setStatus("ページ内容を取得できませんでした");
        return;
      }
      const blob = new Blob([result.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const safeTitle = result.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "page";
      chrome.runtime.sendMessage(
        { type: "download-html", url, filename: `${safeTitle}.html` },
        (res: { ok: boolean; error?: string } | undefined) => {
          if (res?.ok) setStatus(`保存ダイアログを表示しました: ${safeTitle}.html`);
          else setStatus("保存に失敗しました: " + (res?.error ?? "unknown"));
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      );
    } catch (e) {
      setStatus("保存できませんでした: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <h1 className={styles.title}>HTML Editor</h1>
        <p className={styles.subtitle}>ブラウザ実描画のまま編集</p>
      </header>

      <main className={styles.cards}>
        <button className={styles.card} onClick={editCurrentTab} disabled={busy}>
          <div className={styles.cardIcon}>📝</div>
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>このタブの HTML をエディタで開く</div>
            <div className={styles.cardDesc}>
              いま表示中のページをエディタタブに移して Ribbon で本格編集。
              <br />※ <code>file://</code> の HTML を表示中なら、拡張アイコンの
              <b>ワンクリック</b>でも同じ動作。
            </div>
          </div>
        </button>

        <button className={styles.card} onClick={openEditor} disabled={busy}>
          <div className={styles.cardIcon}>📂</div>
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>ファイルを選んで編集</div>
            <div className={styles.cardDesc}>
              ローカルの .html を選択して、Word のように直接編集 → 上書き保存。
            </div>
          </div>
        </button>

        <button className={styles.card} onClick={toggleQuickEdit} disabled={busy}>
          <div className={styles.cardIcon}>✏️</div>
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>このタブをその場で編集</div>
            <div className={styles.cardDesc}>
              軽量ツールバーをページ上に出して直接書き換え。もう一度押すと終了。
            </div>
          </div>
        </button>

        <button className={styles.card} onClick={downloadCurrent} disabled={busy}>
          <div className={styles.cardIcon}>💾</div>
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>このタブを .html として保存</div>
            <div className={styles.cardDesc}>
              ChatGPT のプレビューなど、編集後のページをファイルに書き出す。
            </div>
          </div>
        </button>

        <div className={styles.recentBlock}>
          <div className={styles.recentHeader}>最近のファイル</div>
          {recent.length === 0 && (
            <div className={styles.recentEmpty}>まだありません</div>
          )}
          {recent.map((item) => (
            <button
              key={item.id}
              className={styles.recentItem}
              onClick={() => openRecent(item)}
              disabled={busy}
              title={item.name}
            >
              <span className={styles.recentName}>{item.name}</span>
              <span className={styles.recentTime}>
                {new Date(item.lastOpened).toLocaleString("ja-JP", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </span>
            </button>
          ))}
        </div>
      </main>

      <footer className={styles.status} aria-live="polite">
        {status}
      </footer>
    </div>
  );
}
