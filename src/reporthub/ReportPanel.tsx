import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Msg } from "./messages";
import { sendMsg } from "./messages";
import { isTabSetStorageKey, listTabSets, patchEntry, removeTabSet } from "./repo";
import type { ReportTab } from "./tabops";
import { focusOrOpen, getUndoSnapshot, listReportTabs, UNDO_KEY } from "./tabops";
import type { ReportEntry, TabSet, UndoSnapshot } from "./types";
import { fileName } from "./url";
import { filterEntries, useLibraryStore } from "./libraryStore";
import css from "./reporthub.module.css";

function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}/${md}`;
}

function EntryRow({ entry }: { entry: ReportEntry }) {
  const settings = useLibraryStore((s) => s.settings);
  const missing = entry.missing === true;
  return (
    <div
      className={`${css.row} ${missing ? css.missing : ""}`}
      title={entry.path}
      onClick={() => void focusOrOpen(entry.url, entry.key, settings)}
    >
      <div className={css.rowMain}>
        <div className={css.rowTitle}>
          {entry.title || fileName(entry.path)}
          {missing && <span className={css.badge}>消失</span>}
        </div>
        <div className={css.rowMeta}>
          <span className={css.group}>{entry.group}</span>
          <span>{formatDate(entry.lastSeenAt)}</span>
        </div>
      </div>
      <button
        className={`${css.pinBtn} ${entry.pinned ? css.pinned : ""}`}
        title={entry.pinned ? "ピン解除" : "ピン留め"}
        onClick={(ev) => {
          ev.stopPropagation();
          void patchEntry(entry.id, { pinned: !entry.pinned });
        }}
      >
        ★
      </button>
    </div>
  );
}

export function ReportPanel() {
  const { entries, settings, loaded, fileAccessAllowed, loadPanel, ensureFull } = useLibraryStore();
  const [query, setQuery] = useState("");
  const [openTabs, setOpenTabs] = useState<ReportTab[]>([]);
  const [status, setStatus] = useState("");
  const [sets, setSets] = useState<TabSet[]>([]);
  const [setNameOpen, setSetNameOpen] = useState(false);
  const [setName, setSetName] = useState("");
  const [undo, setUndo] = useState<UndoSnapshot | null>(null);
  const statusTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void getUndoSnapshot().then(setUndo);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && UNDO_KEY in changes) {
        setUndo((changes[UNDO_KEY].newValue as UndoSnapshot | undefined) ?? null);
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  useEffect(() => {
    void loadPanel();
  }, [loadPanel]);

  const refreshTabs = useCallback(async () => {
    if (!loaded) return;
    const tabs = await listReportTabs(settings);
    // identity-stable update: skip the re-render when nothing visible changed
    setOpenTabs((prev) => {
      const sig = (list: ReportTab[]) =>
        list.map((t) => `${t.tab.id}:${t.norm.key}:${t.tab.title ?? ""}`).join("|");
      return sig(prev) === sig(tabs) ? prev : tabs;
    });
  }, [loaded, settings]);

  useEffect(() => {
    void refreshTabs();
    // tabs.onUpdated fires for EVERY page-load step of EVERY tab; unfiltered it
    // kept the panel re-querying while browsing (2026-07-14 重さFBの主因の一つ)
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshTabs(), 400);
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (changeInfo.status !== "complete" && !changeInfo.url) return;
      const url = changeInfo.url ?? tab.url ?? "";
      if (!url.startsWith("file:")) return;
      schedule();
    };
    const onRemoved = () => schedule();
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      window.clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [refreshTabs]);

  const showStatus = useCallback((text: string) => {
    setStatus(text);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(""), 4000);
  }, []);

  const runTabOp = useCallback(
    async (msg: Msg, label: string) => {
      const res = await sendMsg(msg);
      if (msg.type === "toggle-collapse") {
        showStatus(
          res.ok ? (res.count === 1 ? "畳みました" : "展開しました") : "「レポート」グループがありません"
        );
      } else {
        showStatus(res.ok ? `${label}: ${res.count ?? 0}件` : `失敗: ${res.error}`);
      }
      void refreshTabs();
    },
    [refreshTabs, showStatus]
  );

  const refreshSets = useCallback(async () => setSets(await listTabSets()), []);

  useEffect(() => {
    void refreshSets();
    const handler = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && Object.keys(changes).some(isTabSetStorageKey)) {
        void refreshSets();
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [refreshSets]);

  const saveSet = useCallback(async () => {
    const res = await sendMsg({ type: "save-tabset", name: setName });
    showStatus(res.ok ? `セット保存: ${res.count}件` : "開いているレポートがありません");
    setSetName("");
    setSetNameOpen(false);
  }, [setName, showStatus]);

  const list = useMemo(() => Object.values(entries), [entries]);
  const filtered = useMemo(
    () =>
      filterEntries(list, {
        query,
        group: null,
        showArchived: false,
        missingOnly: false
      }).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    [list, query]
  );
  const pinned = useMemo(() => filtered.filter((e) => e.pinned), [filtered]);
  const recent = useMemo(
    () => filtered.filter((e) => !e.pinned).slice(0, 30),
    [filtered]
  );

  return (
    <div className={css.app}>
      <div className={css.header}>
        <button
          className={css.dailyBtn}
          title="Claude Ops デイリーダッシュボードを開く (開いていればそのタブへ)"
          onClick={async () => {
            const res = await sendMsg({ type: "focus-or-open" }).catch((e) => ({
              ok: false,
              error: String(e)
            }));
            showStatus(res?.ok ? "☀ デイリーを開きました" : `デイリーを開けません: ${res?.error ?? "応答なし"}`);
          }}
        >
          ☀ 今日のデイリー
        </button>
        <input
          className={css.search}
          type="search"
          placeholder="タイトル・パスで検索"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // the panel keeps only pinned∪recent in memory; searching upgrades
            // to the full set once, lazily
            if (e.target.value.trim()) void ensureFull();
          }}
        />
      </div>

      {fileAccessAllowed === false && (
        <div className={css.warn}>
          「ファイルの URL へのアクセスを許可」が OFF です。chrome://extensions →
          拡張の詳細から ON にしてください。
        </div>
      )}

      <div className={css.section}>
        <div className={css.sectionTitle}>
          開いているレポート <span className={css.count}>{openTabs.length}</span>
        </div>
        {openTabs.length === 0 ? (
          <div className={css.empty}>file:// のレポートタブはありません</div>
        ) : (
          openTabs.map(({ tab, norm }) => (
            <div
              key={tab.id}
              className={css.tabRow}
              title={norm.path}
              onClick={() => {
                if (tab.id != null) {
                  void chrome.tabs.update(tab.id, { active: true });
                }
              }}
            >
              <span className={css.tabDot} />
              <span className={css.tabTitle}>{tab.title || fileName(norm.path)}</span>
            </div>
          ))
        )}
        <div className={css.btnRow}>
          <button
            className={css.primaryAction}
            title="file://タブを「レポート」グループに集約して畳む (Ctrl+Shift+9)"
            onClick={() => void runTabOp({ type: "organize-tabs", collapse: true }, "まとめ")}
          >
            まとめる
          </button>
          <button
            title="レポートグループの畳み/展開 (Ctrl+Shift+8)"
            onClick={() => void runTabOp({ type: "toggle-collapse" }, "")}
          >
            展開/畳む
          </button>
        </div>
        <div className={css.btnRow}>
          <button
            title="同じファイルの重複タブを閉じる (1つ残す)"
            onClick={() => void runTabOp({ type: "close-duplicate-tabs" }, "かぶり閉じ")}
          >
            かぶり閉じる
          </button>
          <button
            title="レポートタブを全部閉じる (やりなおしで戻せます)"
            onClick={() => void runTabOp({ type: "close-report-tabs" }, "クローズ")}
          >
            全部とじる
          </button>
          <button
            disabled={!undo}
            title={undo ? `「${undo.label}」で閉じた ${undo.urls.length}件を開き直す` : "戻せる操作はありません"}
            onClick={() => void runTabOp({ type: "undo-close" }, "やりなおし")}
          >
            やりなおし
          </button>
        </div>
      </div>

      <details className={css.foldSection}>
        <summary className={css.foldSummary}>
          タブセット <span className={css.count}>{sets.length}</span>
        </summary>
        {setNameOpen ? (
          <div className={css.setSaveRow}>
            <input
              className={css.setInput}
              autoFocus
              placeholder="セット名 (例: これヤバ赤入れ一式)"
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveSet();
                if (e.key === "Escape") setSetNameOpen(false);
              }}
            />
            <button onClick={() => void saveSet()}>保存</button>
          </div>
        ) : (
          <button
            className={css.setSaveBtn}
            disabled={openTabs.length === 0}
            title="いま開いているレポートタブ一式を名前を付けて保存"
            onClick={() => setSetNameOpen(true)}
          >
            + 今のタブをセット保存 ({openTabs.length}件)
          </button>
        )}
        {sets.map((s) => (
          <div key={s.id} className={css.setRow} title={s.paths.join("\n")}>
            <span
              className={css.setName}
              onClick={() =>
                void runTabOp({ type: "open-tabset", id: s.id }, "セットを開く")
              }
            >
              {s.name} <span className={css.setCount}>({s.urls.length})</span>
            </span>
            <button
              className={css.setDel}
              title="セットを削除 (ファイルは消えません)"
              onClick={() => void removeTabSet(s.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </details>

      {pinned.length > 0 && (
        <div className={css.section}>
          <div className={css.sectionTitle}>ピン留め</div>
          {pinned.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </div>
      )}

      <div className={`${css.section} ${css.grow}`}>
        <div className={css.sectionTitle}>最近</div>
        {recent.length === 0 ? (
          <div className={css.empty}>
            {loaded ? "まだ記録がありません" : "読み込み中…"}
          </div>
        ) : (
          recent.map((e) => <EntryRow key={e.id} entry={e} />)
        )}
      </div>

      <div className={css.footer}>
        <span className={css.status}>
          {status || `v${chrome.runtime.getManifest().version}`}
        </span>
        <button
          className={css.dashBtn}
          onClick={() =>
            void chrome.tabs.create({
              url: chrome.runtime.getURL("src/dashboard/dashboard.html")
            })
          }
        >
          ダッシュボード
        </button>
      </div>
    </div>
  );
}
