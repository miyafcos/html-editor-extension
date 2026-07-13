import { handleTableKeydown } from "../editor/core/tableOps";
import { cleanPastedHtml, shouldClean } from "../editor/core/pasteClean";

(() => {
  const STATE_KEY = "__HE_QUICK_EDIT_LOADED__";
  const w = window as unknown as Record<string, unknown>;
  if (w[STATE_KEY]) return;
  w[STATE_KEY] = true;

  let editing = false;
  let host: HTMLElement | null = null;
  let prevContentEditable = "";
  let prevOutline = "";
  let savedHandle: FileSystemFileHandle | null = null;
  let toastTimer: number | null = null;
  let detachers: Array<() => void> = [];

  const TEXT_COLORS = ["#111827", "#dc2626", "#2563eb", "#16a34a", "#ea580c"];
  const BG_COLORS = ["transparent", "#fef3c7", "#dbeafe", "#dcfce7", "#fce7f3"];
  const BADGE_COLORS = [
    { name: "青", color: "#2563eb" },
    { name: "赤", color: "#dc2626" },
    { name: "緑", color: "#16a34a" },
    { name: "黄", color: "#ca8a04" },
    { name: "灰", color: "#6b7280" }
  ];
  const CALLOUTS = [
    { name: "情報", border: "#2563eb", bg: "#eff6ff", color: "#1e3a8a", label: "情報" },
    { name: "注意", border: "#ca8a04", bg: "#fef9c3", color: "#713f12", label: "注意" },
    { name: "OK", border: "#16a34a", bg: "#dcfce7", color: "#14532d", label: "OK" },
    { name: "エラー", border: "#dc2626", bg: "#fee2e2", color: "#7f1d1d", label: "エラー" }
  ];

  const css = `
    :host { all: initial; }
    .bar {
      position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
      background: #111827; color: #fff; border-radius: 10px;
      padding: 6px 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
      font-family: "Segoe UI","Yu Gothic UI","Meiryo",sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      z-index: 2147483647; max-width: calc(100vw - 16px);
    }
    button, select {
      background: transparent; border: 1px solid transparent;
      color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer;
      font-size: 13px; line-height: 1.2; font-family: inherit;
    }
    button:hover { background: #374151; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    select {
      background: #1f2937; border-color: #374151;
      padding: 4px 6px; font-size: 12px;
    }
    .sep { width: 1px; align-self: stretch; background: #4b5563; margin: 0 4px; }
    .save { background: #16a34a; }
    .save:hover { background: #15803d; }
    .close { color: #f87171; padding: 4px 10px; }
    .close:hover { background: #4b1d1d; color: #fff; }
    .swatch {
      width: 18px; height: 18px; padding: 0; border-radius: 3px;
      border: 1px solid #4b5563;
    }
    .swatch.transparent { background: #fff !important; border-style: dashed; }
    .label { font-size: 11px; color: #9ca3af; padding: 0 4px; }
    .menu {
      position: absolute; top: calc(100% + 4px); right: 0;
      background: #ffffff; color: #111827;
      border-radius: 8px; padding: 4px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      display: none; flex-direction: column; gap: 2px; min-width: 220px; max-height: 60vh; overflow-y: auto;
    }
    .menu.open { display: flex; }
    .menu button {
      color: #111827; text-align: left; padding: 6px 10px;
      border-radius: 4px; display: flex; flex-direction: column;
      align-items: flex-start; gap: 2px;
    }
    .menu button:hover { background: #f3f4f6; }
    .menu .mTitle { font-weight: 600; font-size: 13px; }
    .menu .mHint { font-size: 11px; color: #6b7280; }
    .partsWrap { position: relative; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #111827; color: #fff; padding: 8px 16px; border-radius: 8px;
      font-family: "Segoe UI","Yu Gothic UI","Meiryo",sans-serif; font-size: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35); z-index: 2147483647;
      opacity: 0; transition: opacity 200ms;
    }
    .toast.show { opacity: 1; }
    .toast.err { background: #b91c1c; }
    .floatMini {
      position: fixed; z-index: 2147483646;
      background: #111827; color: #fff; padding: 4px 6px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      display: none; gap: 2px; align-items: center;
    }
    .floatMini.show { display: flex; }
    .floatMini button { padding: 4px 8px; border-radius: 4px; }
    .floatMini .miniSwatch { width: 16px; height: 16px; border-radius: 3px; padding: 0; border: 1px solid #4b5563; }
    .floatMini .miniSep { width: 1px; align-self: stretch; background: #4b5563; margin: 0 3px; }
  `;

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[c] as string));
  }

  function showToast(shadow: ShadowRoot, text: string, isError = false) {
    let t = shadow.querySelector(".toast") as HTMLElement | null;
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      shadow.appendChild(t);
    }
    t.textContent = text;
    t.classList.remove("err");
    if (isError) t.classList.add("err");
    requestAnimationFrame(() => t!.classList.add("show"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t!.classList.remove("show"), 2400);
  }

  function getSelection(): { sel: Selection; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    return { sel, range: sel.getRangeAt(0) };
  }

  function insertHtmlAtCaret(html: string) {
    document.body.focus();
    const got = getSelection();
    if (!got || !document.body.contains(got.range.commonAncestorContainer)) {
      document.body.insertAdjacentHTML("beforeend", html);
      return;
    }
    got.range.deleteContents();
    const template = document.createElement("template");
    template.innerHTML = html;
    const frag = template.content;
    const last = frag.lastChild;
    got.range.insertNode(frag);
    if (last) {
      const newRange = document.createRange();
      newRange.setStartAfter(last);
      newRange.collapse(true);
      got.sel.removeAllRanges();
      got.sel.addRange(newRange);
    }
  }

  function findAncestor<T extends Element>(selector: string): T | null {
    const got = getSelection();
    if (!got) return null;
    let node: Node | null = got.range.commonAncestorContainer;
    while (node && node !== document.body) {
      if (node.nodeType === 1 && (node as Element).matches(selector)) return node as T;
      node = node.parentNode;
    }
    return null;
  }

  async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function insertImage(blob: Blob) {
    const url = await blobToBase64(blob);
    insertHtmlAtCaret(`<img src="${url}" alt="" style="max-width:100%;" />`);
  }

  const insertParts: Array<{ id: string; title: string; hint: string; run: () => void }> = [
    {
      id: "badge",
      title: "色バッジ",
      hint: "ステータス・タグ表示",
      run: () => {
        const text = window.prompt("バッジの文字", "新規");
        if (text === null) return;
        const colorName = window.prompt(
          "色 (" + BADGE_COLORS.map((c) => c.name).join("/") + ")",
          "青"
        );
        const found = BADGE_COLORS.find((c) => c.name === colorName) ?? BADGE_COLORS[0];
        const html =
          '<span style="display:inline-block;padding:2px 10px;border-radius:9999px;' +
          'font-size:12px;background:' + found.color + ';color:#fff;font-weight:600;">' +
          escapeHtml(text) + "</span>&nbsp;";
        insertHtmlAtCaret(html);
      }
    },
    {
      id: "table",
      title: "表 (3×3)",
      hint: "ヘッダ+2行の表",
      run: () => {
        const td = 'style="border:1px solid #d1d5db;padding:6px 10px;vertical-align:top;"';
        const th =
          'style="border:1px solid #d1d5db;padding:6px 10px;background:#f3f4f6;' +
          'text-align:left;font-weight:600;"';
        const html =
          '<table style="border-collapse:collapse;width:100%;margin:12px 0;">' +
          "<thead><tr><th " + th + ">列1</th><th " + th + ">列2</th><th " + th + ">列3</th></tr></thead>" +
          "<tbody>" +
          "<tr><td " + td + ">　</td><td " + td + ">　</td><td " + td + ">　</td></tr>" +
          "<tr><td " + td + ">　</td><td " + td + ">　</td><td " + td + ">　</td></tr>" +
          "</tbody></table><p>　</p>";
        insertHtmlAtCaret(html);
      }
    },
    {
      id: "table-row",
      title: "表に行追加",
      hint: "選択中の表の末尾に1行",
      run: () => {
        const table = findAncestor<HTMLTableElement>("table");
        if (!table) {
          window.alert("表のセルにカーソルを置いてから押してください。");
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
      title: "引用ブロック",
      hint: "リード文・注意書き",
      run: () => {
        insertHtmlAtCaret(
          '<blockquote style="margin:12px 0;padding:8px 12px;border-left:4px solid #2563eb;' +
            'background:#eff6ff;color:#1e3a8a;">引用テキスト</blockquote>'
        );
      }
    },
    {
      id: "divider",
      title: "区切り線",
      hint: "セクション区切り",
      run: () => {
        insertHtmlAtCaret('<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />');
      }
    },
    {
      id: "callout",
      title: "コールアウト",
      hint: "情報 / 注意 / OK / エラー",
      run: () => {
        const name = window.prompt("種類 (" + CALLOUTS.map((c) => c.name).join(" / ") + ")", "注意");
        const found = CALLOUTS.find((c) => c.name === name) ?? CALLOUTS[1];
        const text = window.prompt("本文", "ここに本文を書きます") ?? "本文";
        insertHtmlAtCaret(
          '<div role="note" style="margin:12px 0;padding:10px 14px;border-left:4px solid ' +
            found.border + ';background:' + found.bg + ';color:' + found.color +
            ';border-radius:4px;"><strong>' + found.label + ':</strong> ' +
            escapeHtml(text) + '</div>'
        );
      }
    },
    {
      id: "code",
      title: "コードブロック",
      hint: "monospace + 背景",
      run: () => {
        insertHtmlAtCaret(
          '<pre style="background:#1f2937;color:#f3f4f6;padding:12px 14px;border-radius:6px;' +
            'overflow:auto;line-height:1.5;"><code style="font-family:Consolas,Menlo,monospace;font-size:13px;">コード...</code></pre>'
        );
      }
    },
    {
      id: "checklist",
      title: "チェックリスト",
      hint: "進捗・納品チェック用",
      run: () => {
        insertHtmlAtCaret(
          '<ul style="list-style:none;padding-left:0;margin:8px 0;">' +
            '<li style="margin:4px 0;"><input type="checkbox"> <span>項目1</span></li>' +
            '<li style="margin:4px 0;"><input type="checkbox"> <span>項目2</span></li>' +
            '<li style="margin:4px 0;"><input type="checkbox"> <span>項目3</span></li>' +
            '</ul>'
        );
      }
    },
    {
      id: "details",
      title: "折りたたみ <details>",
      hint: "クリックで開閉する枠",
      run: () => {
        insertHtmlAtCaret(
          '<details style="margin:8px 0;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;">' +
            '<summary style="cursor:pointer;font-weight:600;">詳細を表示</summary>' +
            '<div style="padding-top:8px;">本文をここに書きます。</div></details>'
        );
      }
    }
  ];

  function buildToolbar(): { host: HTMLElement; shadow: ShadowRoot } {
    const root = document.createElement("div");
    root.id = "he-quick-edit-host";
    const shadow = root.attachShadow({ mode: "closed" });

    const partsButtons = insertParts
      .map(
        (p) =>
          `<button data-part="${p.id}"><span class="mTitle">${escapeHtml(p.title)}</span>` +
          `<span class="mHint">${escapeHtml(p.hint)}</span></button>`
      )
      .join("");

    const textSwatches = TEXT_COLORS.map(
      (c) =>
        `<button class="swatch" data-color="${c}" style="background:${c};" title="文字色 ${c}"></button>`
    ).join("");

    const bgSwatches = BG_COLORS.map((c) => {
      const cls = c === "transparent" ? "swatch transparent" : "swatch";
      const style = c === "transparent" ? "" : `background:${c};`;
      return `<button class="${cls}" data-bg="${c}" style="${style}" title="背景色 ${c}"></button>`;
    }).join("");

    shadow.innerHTML = `<style>${css}</style><div class="bar" role="toolbar" aria-label="HTML Editor">
      <button data-cmd="bold" title="太字"><b>B</b></button>
      <button data-cmd="italic" title="斜体"><i>I</i></button>
      <button data-cmd="underline" title="下線"><u>U</u></button>
      <button data-cmd="strikeThrough" title="取り消し線"><s>S</s></button>
      <span class="sep"></span>
      <select data-block aria-label="段落スタイル">
        <option value="">見出し…</option>
        <option value="P">本文</option>
        <option value="H1">見出し1</option>
        <option value="H2">見出し2</option>
        <option value="H3">見出し3</option>
        <option value="H4">見出し4</option>
      </select>
      <button data-cmd="insertUnorderedList" title="箇条書き">• 一覧</button>
      <button data-cmd="insertOrderedList" title="番号付き">1. 一覧</button>
      <span class="sep"></span>
      <button data-action="link" title="リンク挿入">🔗</button>
      <button data-cmd="unlink" title="リンク解除">解除</button>
      <span class="sep"></span>
      <span class="label">A</span>${textSwatches}
      <span class="label">▮</span>${bgSwatches}
      <span class="sep"></span>
      <button data-cmd="justifyLeft" title="左寄せ">⬅</button>
      <button data-cmd="justifyCenter" title="中央">⬌</button>
      <button data-cmd="justifyRight" title="右寄せ">➡</button>
      <span class="sep"></span>
      <button data-cmd="undo" title="元に戻す">↶</button>
      <button data-cmd="redo" title="やり直し">↷</button>
      <button data-cmd="removeFormat" title="書式解除">書式解除</button>
      <span class="sep"></span>
      <div class="partsWrap">
        <button data-action="parts" title="部品挿入">+ 部品</button>
        <div class="menu" data-menu="parts">${partsButtons}</div>
      </div>
      <span class="sep"></span>
      <button class="save" data-action="save" title=".html として保存">💾 保存</button>
      <button class="close" data-action="close" title="編集モード終了">×</button>
    </div>
    <div class="floatMini" data-mini>
      <button data-cmd="bold" title="太字"><b>B</b></button>
      <button data-cmd="italic" title="斜体"><i>I</i></button>
      <button data-cmd="underline" title="下線"><u>U</u></button>
      <span class="miniSep"></span>
      ${TEXT_COLORS.map((c) => `<button class="miniSwatch" data-color="${c}" style="background:${c};"></button>`).join("")}
    </div>`;

    const bar = shadow.querySelector(".bar") as HTMLElement;
    const partsMenu = shadow.querySelector('[data-menu="parts"]') as HTMLElement;
    const mini = shadow.querySelector(".floatMini") as HTMLElement;

    bar.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "BUTTON" || t.closest("button") || t.tagName === "SELECT") {
        e.preventDefault();
      }
    });

    mini.addEventListener("mousedown", (e) => e.preventDefault());

    bar.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest("button") as HTMLButtonElement | null;
      if (!btn) return;
      const cmd = btn.dataset.cmd;
      const color = btn.dataset.color;
      const bg = btn.dataset.bg;
      const action = btn.dataset.action;
      const part = btn.dataset.part;

      if (cmd) {
        document.body.focus();
        document.execCommand(cmd, false);
        return;
      }
      if (color) {
        document.body.focus();
        document.execCommand("foreColor", false, color);
        return;
      }
      if (bg) {
        document.body.focus();
        document.execCommand("backColor", false, bg);
        return;
      }
      if (part) {
        partsMenu.classList.remove("open");
        const p = insertParts.find((x) => x.id === part);
        if (p) p.run();
        return;
      }
      if (action === "link") {
        const url = window.prompt("リンク先 URL", "https://");
        if (!url) return;
        document.body.focus();
        document.execCommand("createLink", false, url);
        return;
      }
      if (action === "parts") {
        partsMenu.classList.toggle("open");
        return;
      }
      if (action === "save") {
        await saveHtml(shadow);
        return;
      }
      if (action === "close") {
        teardown();
        return;
      }
    });

    bar.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      if (target.tagName !== "SELECT") return;
      const v = target.value;
      if (v) {
        document.body.focus();
        document.execCommand("formatBlock", false, v);
        target.value = "";
      }
    });

    mini.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest("button") as HTMLButtonElement | null;
      if (!btn) return;
      document.body.focus();
      if (btn.dataset.cmd) {
        document.execCommand(btn.dataset.cmd, false);
      } else if (btn.dataset.color) {
        document.execCommand("foreColor", false, btn.dataset.color);
      }
    });

    shadow.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest('[data-action="parts"]')) {
        partsMenu.classList.remove("open");
      }
    });

    // mini bar follow selection
    let mouseDown = false;
    const onMouseDown = () => {
      mouseDown = true;
      mini.classList.remove("show");
    };
    const onMouseUp = () => {
      mouseDown = false;
      setTimeout(() => updateMini(mini), 0);
    };
    const onSel = () => {
      if (mouseDown) return;
      updateMini(mini);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSel);
    detachers.push(() => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSel);
    });

    return { host: root, shadow };
  }

  function updateMini(mini: HTMLElement) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      mini.classList.remove("show");
      return;
    }
    // テーブルセル内は隠す
    let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
    while (node) {
      if (node.nodeType === 1) {
        const tag = (node as Element).tagName;
        if (tag === "TD" || tag === "TH") {
          mini.classList.remove("show");
          return;
        }
      }
      node = node.parentNode;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      mini.classList.remove("show");
      return;
    }
    mini.style.top = Math.max(4, rect.top - 42) + "px";
    mini.style.left = rect.left + rect.width / 2 + "px";
    mini.style.transform = "translateX(-50%)";
    mini.classList.add("show");
  }

  async function saveHtml(shadow: ShadowRoot) {
    const body = document.body;
    const prevCE = body.contentEditable;
    const prevOL = body.style.outline;
    body.contentEditable = "false";
    body.style.outline = "";
    try {
      const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      const suggested = (() => {
        try {
          const u = new URL(location.href);
          const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
          return last || (document.title || "page") + ".html";
        } catch {
          return (document.title || "page") + ".html";
        }
      })();

      const canFsa = typeof (window as unknown as Record<string, unknown>).showSaveFilePicker === "function";
      if (canFsa) {
        try {
          let handle = savedHandle;
          if (!handle) {
            const picker = (window as unknown as {
              showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
            }).showSaveFilePicker;
            handle = await picker({
              suggestedName: suggested,
              types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }]
            });
            savedHandle = handle;
          }
          if (handle) {
            const bytes = new TextEncoder().encode(html);
            const safe = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(safe).set(bytes);
            const writable = await handle.createWritable();
            await writable.write(safe);
            await writable.close();
            showToast(shadow, "保存しました: " + (handle.name ?? suggested));
            return;
          }
        } catch (e) {
          const name = (e as DOMException).name;
          if (name === "AbortError") return;
          console.warn("FSA save failed, falling back to download", e);
        }
      }

      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const safeName = suggested.replace(/[\\/:*?"<>|]/g, "_");
      chrome.runtime.sendMessage(
        { type: "download-html", url, filename: safeName },
        (res: { ok: boolean; error?: string } | undefined) => {
          if (res?.ok) showToast(shadow, "ダウンロードしました: " + safeName);
          else showToast(shadow, "保存失敗: " + (res?.error ?? "unknown"), true);
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      );
    } finally {
      body.contentEditable = prevCE || "true";
      body.style.outline = prevOL || "2px dashed #2563eb";
    }
  }

  function setup() {
    if (editing) return;
    prevContentEditable = document.body.contentEditable;
    prevOutline = document.body.style.outline;
    document.body.contentEditable = "true";
    document.body.style.outline = "2px dashed #2563eb";
    const built = buildToolbar();
    host = built.host;
    document.documentElement.appendChild(host);

    // T1: table keydown
    const onKey = (e: KeyboardEvent) => handleTableKeydown(e, window);
    document.addEventListener("keydown", onKey, true);
    detachers.push(() => document.removeEventListener("keydown", onKey, true));

    // T2: image paste / drop (base64 only in Quick Edit)
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              await insertImage(file);
              return;
            }
          }
        }
      }
      // T3: Word/Docs paste cleanup
      const html = e.clipboardData?.getData("text/html");
      if (html && shouldClean(html)) {
        e.preventDefault();
        const cleaned = cleanPastedHtml(html);
        document.execCommand("insertHTML", false, cleaned);
      }
    };
    const onDrop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          e.preventDefault();
          await insertImage(f);
          return;
        }
      }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    document.addEventListener("paste", onPaste);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragover", onDragOver);
    detachers.push(() => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", onDragOver);
    });

    editing = true;
  }

  function teardown() {
    if (!editing) return;
    document.body.contentEditable = prevContentEditable || "inherit";
    document.body.style.outline = prevOutline;
    host?.remove();
    host = null;
    detachers.forEach((d) => d());
    detachers = [];
    editing = false;
  }

  chrome.runtime.onMessage.addListener((msg: { type: string }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === "quick-edit:toggle") {
      if (editing) teardown();
      else setup();
      sendResponse({ ok: true, editing });
    } else if (msg.type === "quick-edit:enable") {
      if (!editing) setup();
      sendResponse({ ok: true, editing });
    }
    return true;
  });
})();
