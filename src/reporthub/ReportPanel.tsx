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
  const { entries, settings, loaded, fileAccessAllowed, load } = useLibraryStore();
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
    void load();
  }, [load]);

  const refreshTabs = useCallback(async () => {
    if (!loaded) return;
    setOpenTabs(await listReportTabs(settings));
  }, [loaded, settings]);

  useEffect(() => {
    void refreshTabs();
    const handler = () => void refreshTabs();
    chrome.tabs.onUpdated.addListener(handler);
    chrome.tabs.onRemoved.addListener(handler);
    chrome.tabs.onActivated.addListener(handler);
    return () => {
      chrome.tabs.onUpdated.removeListener(handler);
      chrome.tabs.onRemoved.removeListener(handler);
      chrome.tabs.onActivated.removeListener(handler);
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
          onClick={() => void sendMsg({ type: "focus-or-open" })}
        >
          ☀ 今日のデイリー
        </button>
        <input
          className={css.search}
          type="search"
          placeholder="タイトル・パスで検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
        <span className={css.status}>{status}</span>
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
