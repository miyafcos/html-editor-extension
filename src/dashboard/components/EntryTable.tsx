import { patchEntry } from "../../reporthub/repo";
import { focusOrOpen } from "../../reporthub/tabops";
import type { ReportEntry } from "../../reporthub/types";
import { fileName } from "../../reporthub/url";
import { useLibraryStore } from "../../reporthub/libraryStore";
import css from "../dashboard.module.css";

export interface SortState {
  col: "title" | "group" | "lastSeenAt" | "visitCount";
  dir: 1 | -1;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

interface Props {
  entries: ReportEntry[];
  selection: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  sort: SortState;
  onSort: (s: SortState) => void;
  loaded: boolean;
}

export default function EntryTable({
  entries,
  selection,
  onToggle,
  onToggleAll,
  sort,
  onSort,
  loaded
}: Props) {
  const settings = useLibraryStore((s) => s.settings);

  const header = (col: SortState["col"], label: string) => (
    <th
      className={css.sortable}
      onClick={() =>
        onSort(
          sort.col === col
            ? { col, dir: sort.dir === 1 ? -1 : 1 }
            : { col, dir: col === "title" || col === "group" ? 1 : -1 }
        )
      }
    >
      {label}
      {sort.col === col && <span className={css.sortMark}>{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  if (loaded && entries.length === 0) {
    return <div className={css.tableEmpty}>該当するレポートがありません</div>;
  }

  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th className={css.checkCol}>
              <input
                type="checkbox"
                checked={entries.length > 0 && selection.size >= entries.length}
                onChange={onToggleAll}
              />
            </th>
            {header("title", "タイトル")}
            {header("group", "グループ")}
            {header("lastSeenAt", "最終閲覧")}
            {header("visitCount", "回数")}
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const missing = e.missing === true;
            return (
              <tr
                key={e.id}
                className={`${missing ? css.rowMissing : ""} ${e.archived ? css.rowArchived : ""}`}
              >
                <td className={css.checkCol}>
                  <input
                    type="checkbox"
                    checked={selection.has(e.id)}
                    onChange={() => onToggle(e.id)}
                  />
                </td>
                <td className={css.titleCell}>
                  <button
                    className={`${css.pinBtn} ${e.pinned ? css.pinnedOn : ""}`}
                    title={e.pinned ? "ピン解除" : "ピン留め"}
                    onClick={() => void patchEntry(e.id, { pinned: !e.pinned })}
                  >
                    ★
                  </button>
                  <a
                    className={css.titleLink}
                    title={e.path}
                    onClick={(ev) => {
                      ev.preventDefault();
                      void focusOrOpen(e.url, e.key, settings);
                    }}
                    href={e.url}
                  >
                    {e.title || fileName(e.path)}
                  </a>
                  <div className={css.pathSub}>{e.path}</div>
                </td>
                <td className={css.groupCell}>{e.group}</td>
                <td className={css.dateCell}>{formatDateTime(e.lastSeenAt)}</td>
                <td className={css.numCell}>{e.visitCount}</td>
                <td className={css.stateCell}>
                  {missing && <span className={css.badgeMissing}>消失</span>}
                  {e.archived && <span className={css.badgeArchived}>ｱｰｶｲﾌﾞ</span>}
                  {!missing && !e.archived && e.missing === false && (
                    <span className={css.badgeOk}>✓</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
