import css from "../dashboard.module.css";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  showArchived: boolean;
  onShowArchived: (v: boolean) => void;
  missingOnly: boolean;
  onMissingOnly: (v: boolean) => void;
  selectedCount: number;
  busy: boolean;
  onOpenSelected: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onLiveness: () => void;
  onBackfill: () => void;
  onExport: () => void;
  onImport: () => void;
  onPasteToggle: () => void;
}

export default function Toolbar(p: Props) {
  const hasSel = p.selectedCount > 0;
  return (
    <div className={css.toolbar}>
      <div className={css.toolRow}>
        <input
          className={css.toolSearch}
          type="search"
          placeholder="タイトル・パスで検索"
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
        />
        <label className={css.toolCheck}>
          <input
            type="checkbox"
            checked={p.showArchived}
            onChange={(e) => p.onShowArchived(e.target.checked)}
          />
          アーカイブも表示
        </label>
        <label className={css.toolCheck}>
          <input
            type="checkbox"
            checked={p.missingOnly}
            onChange={(e) => p.onMissingOnly(e.target.checked)}
          />
          消失のみ
        </label>
        <span className={css.toolSpacer} />
        <button onClick={p.onLiveness} disabled={p.busy}>
          存在確認を実行
        </button>
        <button onClick={p.onBackfill} disabled={p.busy}>
          履歴から再取り込み
        </button>
        <button onClick={p.onPasteToggle}>貼り付け取り込み</button>
        <button onClick={p.onExport}>エクスポート</button>
        <button onClick={p.onImport}>インポート</button>
      </div>
      <div className={css.toolRow}>
        <span className={css.selInfo}>
          {hasSel ? `${p.selectedCount}件選択中` : "未選択"}
        </span>
        <button onClick={p.onOpenSelected} disabled={!hasSel} className={css.primaryBtn}>
          まとめて開く→グループ化
        </button>
        <button onClick={p.onPin} disabled={!hasSel}>
          ピン留め
        </button>
        <button onClick={p.onUnpin} disabled={!hasSel}>
          ピン解除
        </button>
        <button onClick={p.onArchive} disabled={!hasSel}>
          アーカイブ
        </button>
        <button onClick={p.onUnarchive} disabled={!hasSel}>
          アーカイブ解除
        </button>
        <button onClick={p.onDelete} disabled={!hasSel} className={css.dangerBtn}>
          削除
        </button>
      </div>
    </div>
  );
}
