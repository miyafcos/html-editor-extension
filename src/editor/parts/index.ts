import { insertHtmlAtSelection, findAncestor } from "../core/commands";

export interface PartDef {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  run(iframe: HTMLIFrameElement): void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[c] as string));
}

const BADGE_COLORS = [
  { name: "青", color: "#2563eb" },
  { name: "赤", color: "#dc2626" },
  { name: "緑", color: "#16a34a" },
  { name: "黄", color: "#ca8a04" },
  { name: "灰", color: "#6b7280" }
];

const calloutHtml = (
  variant: "info" | "warn" | "success" | "error",
  text: string
): string => {
  const styles = {
    info: { border: "#2563eb", bg: "#eff6ff", color: "#1e3a8a", label: "情報" },
    warn: { border: "#ca8a04", bg: "#fef9c3", color: "#713f12", label: "注意" },
    success: { border: "#16a34a", bg: "#dcfce7", color: "#14532d", label: "OK" },
    error: { border: "#dc2626", bg: "#fee2e2", color: "#7f1d1d", label: "エラー" }
  }[variant];
  return (
    `<div role="note" style="margin:12px 0;padding:10px 14px;border-left:4px solid ${styles.border};` +
    `background:${styles.bg};color:${styles.color};border-radius:4px;">` +
    `<strong>${styles.label}:</strong> ${escapeHtml(text)}</div>`
  );
};

export const parts: PartDef[] = [
  {
    id: "badge",
    label: "色バッジ",
    hint: "ステータス・タグ表示",
    group: "基本",
    run(iframe) {
      const text = window.prompt("バッジの文字", "新規");
      if (text === null) return;
      const colorName = window.prompt(
        "色 (" + BADGE_COLORS.map((c) => c.name).join("/") + ")",
        "青"
      );
      const found = BADGE_COLORS.find((c) => c.name === colorName) ?? BADGE_COLORS[0];
      const html =
        `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;` +
        `font-size:12px;background:${found.color};color:#fff;font-weight:600;">` +
        `${escapeHtml(text)}</span>&nbsp;`;
      insertHtmlAtSelection(iframe, html);
    }
  },
  {
    id: "table",
    label: "表 (3×3)",
    hint: "ヘッダ+2行の表",
    group: "基本",
    run(iframe) {
      const td = `style="border:1px solid #d1d5db;padding:6px 10px;vertical-align:top;"`;
      const th =
        `style="border:1px solid #d1d5db;padding:6px 10px;background:#f3f4f6;` +
        `text-align:left;font-weight:600;"`;
      const html =
        `<table style="border-collapse:collapse;width:100%;margin:12px 0;">` +
        `<thead><tr><th ${th}>列1</th><th ${th}>列2</th><th ${th}>列3</th></tr></thead>` +
        `<tbody>` +
        `<tr><td ${td}>　</td><td ${td}>　</td><td ${td}>　</td></tr>` +
        `<tr><td ${td}>　</td><td ${td}>　</td><td ${td}>　</td></tr>` +
        `</tbody></table><p>　</p>`;
      insertHtmlAtSelection(iframe, html);
    }
  },
  {
    id: "table-row",
    label: "表に行追加",
    hint: "選択中の表の末尾に1行",
    group: "基本",
    run(iframe) {
      const table = findAncestor<HTMLTableElement>(iframe, "table");
      if (!table) {
        window.alert("表のセルにカーソルを置いてからもう一度押してください。");
        return;
      }
      const ref = table.querySelector("tbody tr") ?? table.querySelector("tr");
      if (!ref) return;
      const newRow = ref.cloneNode(true) as HTMLTableRowElement;
      newRow.querySelectorAll("th,td").forEach((cell) => {
        (cell as HTMLElement).innerHTML = "　";
      });
      (table.querySelector("tbody") ?? table).appendChild(newRow);
    }
  },
  {
    id: "blockquote",
    label: "引用ブロック",
    hint: "リード文・注意書き",
    group: "基本",
    run(iframe) {
      const html =
        `<blockquote style="margin:12px 0;padding:8px 12px;border-left:4px solid #2563eb;` +
        `background:#eff6ff;color:#1e3a8a;">引用テキスト</blockquote>`;
      insertHtmlAtSelection(iframe, html);
    }
  },
  {
    id: "divider",
    label: "区切り線",
    group: "基本",
    run(iframe) {
      insertHtmlAtSelection(
        iframe,
        `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />`
      );
    }
  },
  {
    id: "callout-info",
    label: "コールアウト(情報)",
    hint: "info 枠",
    group: "コールアウト",
    run(iframe) {
      insertHtmlAtSelection(iframe, calloutHtml("info", "補足情報をここに記入"));
    }
  },
  {
    id: "callout-warn",
    label: "コールアウト(注意)",
    hint: "warn 枠",
    group: "コールアウト",
    run(iframe) {
      insertHtmlAtSelection(iframe, calloutHtml("warn", "注意点をここに記入"));
    }
  },
  {
    id: "callout-success",
    label: "コールアウト(OK)",
    hint: "success 枠",
    group: "コールアウト",
    run(iframe) {
      insertHtmlAtSelection(iframe, calloutHtml("success", "確認済みの内容"));
    }
  },
  {
    id: "callout-error",
    label: "コールアウト(エラー)",
    hint: "error 枠",
    group: "コールアウト",
    run(iframe) {
      insertHtmlAtSelection(iframe, calloutHtml("error", "修正が必要な項目"));
    }
  },
  {
    id: "code-block",
    label: "コードブロック",
    hint: "monospace + 背景",
    group: "コード",
    run(iframe) {
      insertHtmlAtSelection(
        iframe,
        `<pre style="background:#1f2937;color:#f3f4f6;padding:12px 14px;border-radius:6px;` +
          `overflow:auto;line-height:1.5;"><code style="font-family:'Consolas','Menlo',monospace;` +
          `font-size:13px;">コード...</code></pre>`
      );
    }
  },
  {
    id: "code-inline",
    label: "インラインコード",
    hint: "選択範囲を <code> で囲む",
    group: "コード",
    run(iframe) {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) return;
      const sel = win.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        insertHtmlAtSelection(
          iframe,
          `<code style="background:#f3f4f6;padding:1px 6px;border-radius:3px;` +
            `font-family:'Consolas','Menlo',monospace;font-size:0.92em;">コード</code>`
        );
        return;
      }
      const range = sel.getRangeAt(0);
      const code = doc.createElement("code");
      code.setAttribute(
        "style",
        "background:#f3f4f6;padding:1px 6px;border-radius:3px;font-family:'Consolas','Menlo',monospace;font-size:0.92em;"
      );
      code.appendChild(range.extractContents());
      range.insertNode(code);
    }
  },
  {
    id: "checklist",
    label: "チェックリスト",
    hint: "進捗 / 納品チェック用",
    group: "リスト",
    run(iframe) {
      insertHtmlAtSelection(
        iframe,
        `<ul style="list-style:none;padding-left:0;margin:8px 0;">` +
          `<li style="margin:4px 0;"><input type="checkbox"> <span>項目1</span></li>` +
          `<li style="margin:4px 0;"><input type="checkbox"> <span>項目2</span></li>` +
          `<li style="margin:4px 0;"><input type="checkbox"> <span>項目3</span></li>` +
          `</ul>`
      );
    }
  },
  {
    id: "toc",
    label: "目次(自動生成)",
    hint: "H1〜H3 を集めて作成",
    group: "ナビ",
    run(iframe) {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const headings = Array.from(
        doc.body.querySelectorAll<HTMLElement>("h1, h2, h3")
      );
      if (headings.length === 0) {
        window.alert("見出し(H1〜H3)が見つかりません。先に見出しを書いてから挿入してください。");
        return;
      }
      const items = headings
        .map((h) => {
          if (!h.id) h.id = "h-" + Math.random().toString(36).slice(2, 8);
          const level = parseInt(h.tagName.slice(1));
          const indent = (level - 1) * 16;
          return (
            `<li style="margin:2px 0 2px ${indent}px;">` +
            `<a href="#${h.id}" style="color:#2563eb;text-decoration:none;">${escapeHtml(
              h.textContent ?? ""
            )}</a></li>`
          );
        })
        .join("");
      insertHtmlAtSelection(
        iframe,
        `<nav style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;` +
          `padding:12px 16px;margin:12px 0;"><strong style="display:block;margin-bottom:6px;">` +
          `目次</strong><ul style="list-style:none;padding-left:0;margin:0;line-height:1.7;">` +
          `${items}</ul></nav>`
      );
    }
  },
  {
    id: "details",
    label: "折りたたみ <details>",
    hint: "クリックで開閉する枠",
    group: "ナビ",
    run(iframe) {
      insertHtmlAtSelection(
        iframe,
        `<details style="margin:8px 0;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;">` +
          `<summary style="cursor:pointer;font-weight:600;">詳細を表示</summary>` +
          `<div style="padding-top:8px;">本文をここに書きます。</div></details>`
      );
    }
  }
];
