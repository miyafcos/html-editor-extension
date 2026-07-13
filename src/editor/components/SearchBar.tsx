import { useEffect, useRef, useState, useCallback } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  highlightMatches,
  clearMarks,
  focusMark,
  replaceMatches
} from "../core/searchEngine";
import styles from "../styles/ui.module.css";

interface Props {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
}

export function SearchBar({ iframeRef }: Props) {
  const search = useEditorStore((s) => s.search);
  const setSearch = useEditorStore((s) => s.setSearch);
  const setSearchOpen = useEditorStore((s) => s.setSearchOpen);

  const marksRef = useRef<HTMLElement[]>([]);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const runSearch = useCallback(
    (q: string) => {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return;
      const marks = highlightMatches(doc.body, q, search.caseSensitive);
      marksRef.current = marks;
      setSearch({ matchCount: marks.length, currentIndex: marks.length > 0 ? 1 : 0 });
      setActiveIndex(0);
      if (marks[0]) focusMark(marks[0]);
    },
    [iframeRef, setSearch, search.caseSensitive]
  );

  useEffect(() => {
    if (search.open) {
      queryRef.current?.focus();
      queryRef.current?.select();
    }
  }, [search.open]);

  useEffect(() => {
    return () => {
      const doc = iframeRef.current?.contentDocument;
      if (doc) clearMarks(doc.body);
    };
  }, [iframeRef]);

  useEffect(() => {
    if (!search.open) {
      const doc = iframeRef.current?.contentDocument;
      if (doc) clearMarks(doc.body);
      marksRef.current = [];
    }
  }, [search.open, iframeRef]);

  const navigate = (delta: number) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    const newIdx = (activeIndex + delta + marks.length) % marks.length;
    setActiveIndex(newIdx);
    setSearch({ currentIndex: newIdx + 1 });
    focusMark(marks[newIdx]);
  };

  const close = () => {
    setSearchOpen(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
  };

  const doReplaceOne = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const marks = marksRef.current;
    if (marks.length === 0 || !marks[activeIndex]) return;
    const current = marks[activeIndex];
    current.replaceWith(doc.createTextNode(search.replacement));
    doc.body.normalize();
    runSearch(search.query);
  };

  const doReplaceAll = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const count = replaceMatches(
      doc.body,
      search.query,
      search.replacement,
      search.caseSensitive
    );
    marksRef.current = [];
    setSearch({ matchCount: 0, currentIndex: 0 });
    setActiveIndex(0);
    window.alert(`${count} 件置換しました`);
  };

  if (!search.open) return null;

  return (
    <div className={styles.searchBar}>
      <div className={styles.searchRow}>
        <input
          ref={queryRef}
          className={styles.searchInput}
          value={search.query}
          placeholder="検索"
          onChange={(e) => {
            const v = e.target.value;
            setSearch({ query: v });
            runSearch(v);
          }}
          onKeyDown={onKey}
        />
        <span className={styles.searchCount}>
          {search.matchCount > 0
            ? `${search.currentIndex} / ${search.matchCount}`
            : search.query
            ? "0件"
            : ""}
        </span>
        <button
          className={styles.searchBtn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => navigate(-1)}
          title="前へ (Shift+Enter)"
        >
          ↑
        </button>
        <button
          className={styles.searchBtn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => navigate(1)}
          title="次へ (Enter)"
        >
          ↓
        </button>
        <label className={styles.searchOption}>
          <input
            type="checkbox"
            checked={search.caseSensitive}
            onChange={(e) => {
              setSearch({ caseSensitive: e.target.checked });
              runSearch(search.query);
            }}
          />
          Aa
        </label>
        <button
          className={styles.searchBtn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSearch({ showReplace: !search.showReplace })}
          title="置換切替"
        >
          {search.showReplace ? "▲" : "▼"}
        </button>
        <button
          className={styles.searchBtn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
          title="閉じる (Esc)"
        >
          ×
        </button>
      </div>
      {search.showReplace && (
        <div className={styles.searchRow}>
          <input
            className={styles.searchInput}
            value={search.replacement}
            placeholder="置換後"
            onChange={(e) => setSearch({ replacement: e.target.value })}
          />
          <button
            className={styles.searchBtn}
            onMouseDown={(e) => e.preventDefault()}
            onClick={doReplaceOne}
            disabled={search.matchCount === 0}
          >
            1件置換
          </button>
          <button
            className={styles.searchBtn}
            onMouseDown={(e) => e.preventDefault()}
            onClick={doReplaceAll}
            disabled={search.matchCount === 0}
          >
            全置換
          </button>
        </div>
      )}
    </div>
  );
}
