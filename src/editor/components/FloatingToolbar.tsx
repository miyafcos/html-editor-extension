import { useEffect, useState, useCallback } from "react";
import { commands, runCommand, findAncestor } from "../core/commands";
import styles from "../styles/ui.module.css";

interface Props {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  active: boolean;
}

interface BarState {
  top: number;
  left: number;
}

const COLORS = [
  { label: "黒", value: "#111827" },
  { label: "赤", value: "#dc2626" },
  { label: "青", value: "#2563eb" },
  { label: "緑", value: "#16a34a" },
  { label: "橙", value: "#ea580c" }
];

export function FloatingToolbar({ iframeRef, active }: Props) {
  const [state, setState] = useState<BarState | null>(null);

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
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setState(null);
      return;
    }
    // テーブルセル選択時は CellMenu に譲る
    if (findAncestor<HTMLElement>(iframeRef.current, "td,th")) {
      setState(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setState(null);
      return;
    }
    const iframeRect = iframe.getBoundingClientRect();
    setState({
      top: iframeRect.top + rect.top - 40,
      left: iframeRect.left + rect.left + rect.width / 2
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
    let mouseDown = false;
    const onDown = () => {
      mouseDown = true;
      setState(null);
    };
    const onUp = () => {
      mouseDown = false;
      setTimeout(recompute, 0);
    };
    const onSel = () => {
      if (mouseDown) return;
      recompute();
    };
    doc.addEventListener("mousedown", onDown);
    doc.addEventListener("mouseup", onUp);
    doc.addEventListener("selectionchange", onSel);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      doc.removeEventListener("mousedown", onDown);
      doc.removeEventListener("mouseup", onUp);
      doc.removeEventListener("selectionchange", onSel);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [active, iframeRef, recompute]);

  if (!state) return null;

  const press =
    (cmd: (typeof commands)[keyof typeof commands] | ReturnType<typeof commands.color>) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      runCommand(iframeRef.current, cmd as never);
    };

  return (
    <div
      className={styles.floatingBar}
      style={{ top: Math.max(4, state.top), left: state.left, transform: "translateX(-50%)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className={styles.floatBtn} onClick={press(commands.bold)} title="太字">
        <b>B</b>
      </button>
      <button className={styles.floatBtn} onClick={press(commands.italic)} title="斜体">
        <i>I</i>
      </button>
      <button className={styles.floatBtn} onClick={press(commands.underline)} title="下線">
        <u>U</u>
      </button>
      <span className={styles.floatSep} />
      {COLORS.map((c) => (
        <button
          key={c.value}
          className={styles.floatSwatch}
          style={{ background: c.value }}
          onClick={press(commands.color(c.value))}
          title={`文字色 ${c.label}`}
          aria-label={`文字色 ${c.label}`}
        />
      ))}
    </div>
  );
}
