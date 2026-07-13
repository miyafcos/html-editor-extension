import { useState, useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { templates, type TemplateDef } from "../templates";
import styles from "../styles/ui.module.css";

interface Props {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onPickAssets: () => void;
  onNewFromTemplate: (tpl: TemplateDef) => void;
  onOpenRecent: (id: string) => void;
  busy: boolean;
}

export function FileBar({
  onOpen,
  onSave,
  onSaveAs,
  onPickAssets,
  onNewFromTemplate,
  onOpenRecent,
  busy
}: Props) {
  const fileName = useEditorStore((s) => s.fileName);
  const dirty = useEditorStore((s) => s.dirty);
  const assetsDir = useEditorStore((s) => s.assetsDir);
  const hasFile = useEditorStore((s) => s.split !== null);
  const recent = useEditorStore((s) => s.recent);

  const [openMenu, setOpenMenu] = useState<"new" | "recent" | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenu]);

  return (
    <header className={styles.bar} ref={wrapRef}>
      <div className={styles.barLeft}>
        <div className={styles.fbDropdown}>
          <button
            className={styles.btn}
            onClick={() => setOpenMenu(openMenu === "new" ? null : "new")}
            disabled={busy}
            title="テンプレから新規作成"
          >
            新規 ▾
          </button>
          {openMenu === "new" && (
            <div className={styles.fbDropdownMenu}>
              {templates.map((t) => (
                <button
                  key={t.id}
                  className={styles.fbItem}
                  onClick={() => {
                    setOpenMenu(null);
                    onNewFromTemplate(t);
                  }}
                >
                  <span className={styles.fbItemTitle}>{t.label}</span>
                  <span className={styles.fbItemHint}>{t.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className={styles.btn} onClick={onOpen} disabled={busy}>
          開く
        </button>

        <div className={styles.fbDropdown}>
          <button
            className={styles.btn}
            onClick={() => setOpenMenu(openMenu === "recent" ? null : "recent")}
            disabled={busy}
            title="最近開いたファイル"
          >
            最近 ▾
          </button>
          {openMenu === "recent" && (
            <div className={styles.fbDropdownMenu}>
              {recent.length === 0 && (
                <div className={styles.fbItemEmpty}>
                  最近のファイルはまだありません
                </div>
              )}
              {recent.map((r) => (
                <button
                  key={r.id}
                  className={styles.fbItem}
                  onClick={() => {
                    setOpenMenu(null);
                    onOpenRecent(r.id);
                  }}
                >
                  <span className={styles.fbItemTitle}>{r.name}</span>
                  <span className={styles.fbItemHint}>
                    {new Date(r.lastOpened).toLocaleString("ja-JP")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className={styles.btnPrimary}
          onClick={onSave}
          disabled={!hasFile || busy}
          title="保存 (Ctrl+S)"
        >
          保存{dirty ? " *" : ""}
        </button>
        <button
          className={styles.btn}
          onClick={onSaveAs}
          disabled={!hasFile || busy}
          title="別名で保存 (Ctrl+Shift+S)"
        >
          別名で保存
        </button>
        <button
          className={styles.btn}
          onClick={onPickAssets}
          disabled={busy}
          title="同階層フォルダの画像を読めるようにする"
        >
          画像フォルダ{assetsDir ? " ✓" : ""}
        </button>
      </div>
      <div className={styles.barRight}>
        {fileName ? (
          <span className={styles.fileName}>
            {fileName}
            {dirty && <span className={styles.dirtyDot}>●</span>}
          </span>
        ) : (
          <span className={styles.fileNameMuted}>(ファイル未選択)</span>
        )}
      </div>
    </header>
  );
}
