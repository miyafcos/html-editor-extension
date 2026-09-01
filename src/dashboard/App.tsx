import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkEntries } from "../reporthub/liveness";
import { sendMsg } from "../reporthub/messages";
import { patchEntry, removeEntries, upsertVisit } from "../reporthub/repo";
import type { ReportEntry } from "../reporthub/types";
import { isHtmlPath, normalizeFileUrl, pathToFileUrl } from "../reporthub/url";
import { filterEntries, groupCounts, useLibraryStore } from "../reporthub/libraryStore";
import EntryTable, { type SortState } from "./components/EntryTable";
import GroupSidebar from "./components/GroupSidebar";
import SettingsPane from "./components/SettingsPane";
import Toolbar from "./components/Toolbar";
import css from "./dashboard.module.css";

type View = "library" | "settings";

export default function App() {
  const { entries, settings, loaded, fileAccessAllowed, load } = useLibraryStore();
  const [view, setView] = useState<View>("library");
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [missingOnly, setMissingOnly] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ col: "lastSeenAt", dir: -1 });
  const [status, setStatus] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const list = useMemo(() => Object.values(entries), [entries]);
  const groups = useMemo(() => groupCounts(list), [list]);

  const filtered = useMemo(() => {
    const f = filterEntries(list, { query, group, showArchived, missingOnly });
    const dir = sort.dir;
    return [...f].sort((a, b) => {
      switch (sort.col) {
        case "title":
          return dir * a.title.localeCompare(b.title, "ja");
        case "group":
          return dir * a.group.localeCompare(b.group, "ja");
        case "visitCount":
          return dir * (a.visitCount - b.visitCount);
        default:
          return dir * (a.lastSeenAt - b.lastSeenAt);
      }
    });
  }, [list, query, group, showArchived, missingOnly, sort]);

  const selected = useMemo(
    () => filtered.filter((e) => selection.has(e.id)),
    [filtered, selection]
  );

  const toggle = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelection((prev) =>
      prev.size >= filtered.length ? new Set() : new Set(filtered.map((e) => e.id))
    );
  }, [filtered]);

  const patchSelected = useCallback(
    async (patch: Partial<ReportEntry>, label: string) => {
      for (const e of selected) await patchEntry(e.id, patch);
      setStatus(`${label}: ${selected.length}件`);
    },
    [selected]
  );

  const openSelected = useCallback(async () => {
    const targets = selected.filter((e) => e.missing !== true);
    if (!targets.length) return;
    const res = await sendMsg({ type: "open-entries", urls: targets.map((e) => e.url) });
    setStatus(res.ok ? `${res.count}件を開いてグループ化しました` : `失敗: ${res.error}`);
  }, [selected]);

  const deleteSelected = useCallback(async () => {
    if (!selected.length) return;
    if (!window.confirm(`${selected.length}件をカタログから完全削除します。よろしいですか？\n(ファイル自体は削除されません)`)) {
      return;
    }
    await removeEntries(selected.map((e) => e.id));
    setSelection(new Set());
    setStatus(`削除: ${selected.length}件`);
  }, [selected]);

  const runLiveness = useCallback(async () => {
    if (fileAccessAllowed === false) {
      setStatus("ファイル URL アクセスが OFF のため存在確認できません");
      return;
    }
    setBusy(true);
    try {
      const result = await checkEntries(filtered, 8, (done, total) =>
        setStatus(`存在確認中… ${done}/${total}`)
      );
      setStatus(`存在確認完了: 消失 ${result.missing}件 / ${result.checked}件`);
    } finally {
      setBusy(false);
    }
  }, [filtered, fileAccessAllowed]);

  const runBackfill = useCallback(async () => {
    setBusy(true);
    setStatus("履歴から取り込み中…");
    try {
      const res = await sendMsg({ type: "run-backfill" });
      setStatus(res.ok ? `履歴取り込み完了: ${res.count}件` : `失敗: ${res.error}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const doExport = useCallback(async () => {
    const { exportData } = await import("../reporthub/repo");
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    a.href = url;
    a.download = `report-hub-export-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`エクスポート: ${data.entries.length}件`);
  }, []);

  const doImport = useCallback(async (file: File) => {
    try {
      const { importData } = await import("../reporthub/repo");
      const parsed = JSON.parse(await file.text());
      const includeSettings = window.confirm(
        "設定 (除外パターン・グループルール) も上書きしますか？\nOK=設定も取り込む / キャンセル=エントリのみ"
      );
      const n = await importData(parsed, { includeSettings });
      setStatus(`インポート完了: ${n}件`);
    } catch (e) {
      setStatus(`インポート失敗: ${String(e)}`);
    }
  }, []);

  const doPasteImport = useCallback(async () => {
    const lines = pasteText.split(/\r?\n/);
    let imported = 0;
    for (const raw of lines) {
      let line = raw.trim().replace(/^["']|["']$/g, "");
      if (!line) continue;
      if (!line.startsWith("file:")) {
        line = pathToFileUrl(line.replace(/\\/g, "/"));
      }
      const norm = normalizeFileUrl(line);
      if (!norm || !isHtmlPath(norm.path)) continue;
      await upsertVisit(
        {
          url: norm.url,
          path: norm.path,
          key: norm.key,
          at: Date.now(),
          source: "import",
          countVisit: false
        },
        settings
      );
      imported++;
    }
    setStatus(`貼り付け取り込み: ${imported}件`);
    setPasteText("");
    setPasteOpen(false);
  }, [pasteText, settings]);

  return (
    <div className={css.app}>
      <header className={css.header}>
        <div className={css.brand}>HTML Hub</div>
        <nav className={css.nav}>
          <button
            className={view === "library" ? css.navActive : ""}
            onClick={() => setView("library")}
          >
            ライブラリ
          </button>
          <button
            className={view === "settings" ? css.navActive : ""}
            onClick={() => setView("settings")}
          >
            設定
          </button>
        </nav>
        <div className={css.statusBar}>{status}</div>
      </header>

      {fileAccessAllowed === false && (
        <div className={css.warn}>
          「ファイルの URL へのアクセスを許可」が OFF です。chrome://extensions → 拡張の詳細から
          ON にすると、存在確認と再オープンが正しく動きます。
        </div>
      )}

      {view === "settings" ? (
        <SettingsPane onStatus={setStatus} />
      ) : (
        <div className={css.body}>
          <GroupSidebar
            groups={groups}
            total={list.filter((e) => !e.archived).length}
            selected={group}
            onSelect={(g) => {
              setGroup(g);
              setSelection(new Set());
            }}
          />
          <main className={css.main}>
            <Toolbar
              query={query}
              onQuery={setQuery}
              showArchived={showArchived}
              onShowArchived={setShowArchived}
              missingOnly={missingOnly}
              onMissingOnly={setMissingOnly}
              selectedCount={selected.length}
              busy={busy}
              onOpenSelected={() => void openSelected()}
              onPin={() => void patchSelected({ pinned: true }, "ピン留め")}
              onUnpin={() => void patchSelected({ pinned: false }, "ピン解除")}
              onArchive={() => void patchSelected({ archived: true }, "アーカイブ")}
              onUnarchive={() => void patchSelected({ archived: false }, "アーカイブ解除")}
              onDelete={() => void deleteSelected()}
              onLiveness={() => void runLiveness()}
              onBackfill={() => void runBackfill()}
              onExport={() => void doExport()}
              onImport={() => fileInput.current?.click()}
              onPasteToggle={() => setPasteOpen((v) => !v)}
            />
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
                e.target.value = "";
              }}
            />
            {pasteOpen && (
              <div className={css.pastePanel}>
                <div className={css.pasteHint}>
                  パスまたは file:// URL を1行1件で貼り付け (.html / .htm のみ取り込み)
                </div>
                <textarea
                  className={css.pasteArea}
                  rows={6}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={"C:\\Users\\...\\レポート.html\nG:\\マイドライブ\\案件X\\納品レビュー.html"}
                />
                <div className={css.pasteBtns}>
                  <button onClick={() => void doPasteImport()}>取り込み</button>
                  <button onClick={() => setPasteOpen(false)}>閉じる</button>
                </div>
              </div>
            )}
            <EntryTable
              entries={filtered}
              selection={selection}
              onToggle={toggle}
              onToggleAll={toggleAll}
              sort={sort}
              onSort={setSort}
              loaded={loaded}
            />
          </main>
        </div>
      )}
    </div>
  );
}
