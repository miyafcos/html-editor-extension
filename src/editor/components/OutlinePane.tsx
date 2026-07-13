import { useEffect, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import styles from "../styles/ui.module.css";

interface Props {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  attached: boolean;
}

interface OutlineEntry {
  level: number;
  text: string;
  el: HTMLElement;
}

export function OutlinePane({ iframeRef, attached }: Props) {
  const outlineOpen = useEditorStore((s) => s.outlineOpen);
  const toggleOutline = useEditorStore((s) => s.toggleOutline);
  const [entries, setEntries] = useState<OutlineEntry[]>([]);

  useEffect(() => {
    if (!attached) {
      setEntries([]);
      return;
    }
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;

    const collect = () => {
      const headings = Array.from(
        doc.body.querySelectorAll<HTMLElement>("h1, h2, h3, h4")
      );
      const next = headings.map<OutlineEntry>((el) => ({
        level: parseInt(el.tagName.slice(1)),
        text: (el.textContent ?? "").trim() || "(無題)",
        el
      }));
      setEntries(next);
    };

    collect();
    const observer = new MutationObserver(() => collect());
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [attached, iframeRef]);

  if (!outlineOpen) {
    return (
      <aside className={styles.outlineClosed}>
        <button
          className={styles.outlineToggle}
          onClick={toggleOutline}
          title="アウトラインを開く"
        >
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.outlinePane}>
      <div className={styles.outlineHeader}>
        <span>見出し</span>
        <button
          className={styles.outlineToggle}
          onClick={toggleOutline}
          title="アウトラインを閉じる"
        >
          ✕
        </button>
      </div>
      <div className={styles.outlineList}>
        {entries.length === 0 && (
          <div className={styles.outlineEmpty}>見出しなし</div>
        )}
        {entries.map((entry, i) => (
          <button
            key={i}
            className={styles.outlineItem}
            style={{ paddingLeft: 8 + (entry.level - 1) * 12 }}
            title={entry.text}
            onClick={() => entry.el.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            <span className={styles.outlineLevel}>H{entry.level}</span>
            <span className={styles.outlineText}>{entry.text}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
