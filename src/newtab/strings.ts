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

  /**
   * Service sub-classification of web targets. These are the seed labels only —
   * rules live in chrome.storage.local under `serviceRules` and grow over time,
   * so auto-promoted services derive their label from the host instead.
   */
  service: {
    sheet: "表計算",
    doc: "文書",
    drive: "ドライブ",
    ai: "AI",
    dev: "開発",
    comm: "連絡",
    internal: "社内",
    search: "検索",
    study: "学習",
    media: "メディア",
    shop: "買い物",
    gov: "官庁",
    other: "その他"
  },

  /** Group-level controls that appear on hover in the dense layout. */
  group: {
    collapse: "このまとまりを畳む",
    expand: "このまとまりを開く",
    closeAll: "このまとまりを全部閉じる",
    closedToast: (name: string, n: number) => `「${name}」の ${n} 件を閉じた`,
    /** Bucket that single-entry groups get folded into. */
    misc: "その他"
  },

  /** Hover preview card. Excerpts are only available for local .html targets. */
  preview: {
    /** Relative time, e.g. 「3日前」. Called with whole days; 0 means today. */
    ago: (days: number) => (days <= 0 ? "さっき" : days === 1 ? "きのう" : `${days}日前`),
    visits: (n: number) => `${n}回`,
    pinned: "常設",
    later: "あとで",
    /** Separator-led line summarising document shape, e.g. 見出し8 · 表3 (最大44行) */
    shapeHeadings: (n: number) => `見出し${n}`,
    shapeTables: (n: number, maxRows: number) => `表${n}（最大${maxRows}行）`,
    shapeChips: (ok: number, warn: number, ng: number) => `✓${ok} ⚠${warn} ✕${ng}`,
    shapeFigures: (n: number) => `図${n}`
  },

  /** Search results drawn from the HTML hub index (read-only, local mirror). */
  hubIndex: {
    band: "ハブ資料",
    /** Shown when the match count exceeds the display cap. */
    more: (n: number) => `他 ${n} 件`,
    /** Extra tags beyond the first three. */
    moreTags: (n: number) => `+${n}`
  },

  /** Case-category chips, merged from the ledger group and the hub index category. */
  category: {
    label: "案件でしぼる"
  },

  /** Bookmark strip (bookmark_bar children) and the search-only bookmark band. */
  bookmarks: {
    lead: "ブックマーク",
    /** title attribute on a folder chip. */
    folderHint: (name: string, count: number) => `${name}（${count}件）`,
    /** Band heading shown only while a search query is active. */
    band: "ブックマーク",
    empty: "ブックマークバーは空",
    /** Breadcrumb back-link inside a nested folder dropdown. */
    back: "戻る"
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
