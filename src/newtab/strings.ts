/**
 * All user-facing Japanese strings for the new tab hub.
 *
 * Authored by the parent session (not by the delegated implementer) because
 * writing large amounts of Japanese literals through the delegation path has a
 * history of mojibake. Implementers must import from here instead of embedding
 * Japanese literals in components.
 */

export const S = {
  /** Browser tab title. Also asserted by e2e/newtab.e2e.mjs. */
  documentTitle: "タブハブ",

  search: {
    placeholder: "検索 — 開いたものを探す / そのまま調べる",
    /** Shown under the box when the query matches nothing in the ledger. */
    fallbackHint: "Enter でウェブ検索",
    clear: "検索を消す"
  },

  pinned: {
    heading: "常設",
    /** Shown when nothing is pinned yet. */
    empty: "ピン留めしたタブと、📌 を付けたページがここに並ぶ"
  },

  /** Kind names. Used by the kind filter tabs and by row badges. */
  kind: {
    all: "すべて",
    web: "Web",
    html: "HTML",
    pdf: "PDF"
  },

  /** Tab bar controls above the list. */
  tabs: {
    /** Screen-reader label for the kind filter tab strip. */
    label: "種別でしぼる",
    /** title attribute on each tab: e.g. 「Web だけ表示 (18件)」 */
    hint: (kind: string, count: number) => `${kind} だけ表示（${count}件）`,
    allHint: (count: number) => `すべて表示（${count}件）`
  },

  /** Collapse / expand the real Chrome tab strip. */
  tabstrip: {
    collapse: "まとめる",
    collapseHint: "開いているタブを種別ごとにまとめて畳む",
    expand: "展開",
    expandHint: "畳んだタブグループを開き直す",
    collapsedToast: (n: number) => `${n}件のタブを畳んだ`,
    expandedToast: (n: number) => `${n}件のタブを展開した`,
    nothingToCollapse: "畳めるタブがない"
  },

  /** Band headings (revisit-frequency axis). */
  band: {
    open: "いま開いてる",
    recent: "最近",
    later: "あとで",
    /** title attribute on the ▾/▸ toggle. */
    collapse: "この帯を畳む",
    expand: "この帯を開く"
  },

  /** Empty-state text per band. Never render a bare zero. */
  empty: {
    open: "開いているタブはない",
    recent: "2回以上開いたページがここに溜まる",
    later: "🕐 で閉じたページがここで待つ",
    /** Shown when a kind filter yields nothing at all. */
    filtered: (kind: string) => `${kind} はまだ何もない`
  },

  /** Row action buttons (used as title/aria-label). */
  action: {
    later: "あとで見る（閉じて、ここに残す）",
    laterUndo: "閉じるのをやめる",
    pin: "常設にする",
    unpin: "常設をやめる",
    remove: "一覧から消す",
    switchTo: "このタブに切り替える",
    openNew: "新しいタブで開く"
  },

  /** Transient toast after a destructive-ish action. */
  toast: {
    closedOne: (title: string) => `「${title}」を「あとで」に入れた`,
    removedOne: (title: string) => `「${title}」を一覧から消した`,
    undo: "元に戻す"
  },

  /** Footer / diagnostics. */
  footer: {
    counts: (open: number, ledger: number) => `開いてる ${open} 件 / 台帳 ${ledger} 件`,
    settings: "設定"
  },

  /** Shown when the ledger has not collected anything yet (first run). */
  firstRun: {
    heading: "まだ何も溜まっていない",
    body: "同じページを2回開くと、ここに自動で載る。1回だけ見たページは残らない。"
  }
} as const;
