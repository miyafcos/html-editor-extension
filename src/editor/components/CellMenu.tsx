import { useEffect, useState, useCallback } from "react";
import {
  findCell,
  addRowAfter,
  addRowBefore,
  addColumnAfter,
  addColumnBefore,
  deleteRow,
  deleteColumn,
  type TableContext
} from "../core/tableOps";
import styles from "../styles/ui.module.css";

interface Props {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  active: boolean;
}

interface MenuState {
  ctx: TableContext;
  top: number;
  left: number;
}

export function CellMenu({ iframeRef, active }: Props) {
  const [state, setState] = useState<MenuState | null>(null);

  const recompute = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      setState(null);
      return;
    }
    const win = iframe.contentWindow;
    if (!win) {
      setState(null);
      return;
    }
    const sel = win.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setState(null);
      return;
    }
    const ctx = findCell(sel.getRangeAt(0).startContainer);
    if (!ctx) {
      setState(null);
      return;
    }
    const cellRect = ctx.cell.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();
    setState({
      ctx,
      top: iframeRect.top + cellRect.top - 36,
      left: iframeRect.left + cellRect.left
    });
  }, [iframeRef]);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    const handler = () => recompute();
    doc.addEventListener("selectionchange", handler);
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    recompute();
    return () => {
      doc.removeEventListener("selectionchange", handler);
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [active, iframeRef, recompute]);

  if (!state) return null;

  const op = (fn: (ctx: TableContext) => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn(state.ctx);
    setTimeout(recompute, 0);
  };

  return (
    <div
      className={styles.cellMenu}
      style={{ top: Math.max(4, state.top), left: state.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className={styles.cellBtn} onClick={op(addRowBefore)} title="上に行を追加">
        ↑+行
      </button>
      <button className={styles.cellBtn} onClick={op(addRowAfter)} title="下に行を追加">
        ↓+行
      </button>
      <button className={styles.cellBtn} onClick={op(addColumnBefore)} title="左に列を追加">
        ←+列
      </button>
      <button className={styles.cellBtn} onClick={op(addColumnAfter)} title="右に列を追加">
        →+列
      </button>
      <span className={styles.cellSep} />
      <button
        className={`${styles.cellBtn} ${styles.cellBtnDanger}`}
        onClick={op(deleteRow)}
        title="この行を削除"
      >
        −行
      </button>
      <button
        className={`${styles.cellBtn} ${styles.cellBtnDanger}`}
        onClick={op(deleteColumn)}
        title="この列を削除"
      >
        −列
      </button>
    </div>
  );
}
