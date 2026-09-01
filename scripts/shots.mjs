import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const CHROME = join(resolve(ROOT, ".."), "tools", "chrome-for-testing", "chrome", "win64-150.0.7871.115", "chrome-win64", "chrome.exe");
const DIST = join(ROOT, "dist");
const PROFILE = join(ROOT, "e2e", "e2e-profile", `store-shots-${process.pid}-${Date.now()}`);
const OUTPUT = join(ROOT, "store", "screenshots");
const PORT = 9900 + (process.pid % 80);
const TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception ?? {})}`);
  }
  return result.result?.value;
}

async function waitFor(check, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// A DOM node can be present while its fade-in transition is still running, which
// captures a half-transparent element on top of whatever sits behind it. Wait for
// every running animation to finish, then let two frames paint.
async function settle(cdp, sessionId) {
  await evaluate(cdp, sessionId, `(async () => {
    const limit = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
    // Background tabs never fire requestAnimationFrame, so every wait needs a ceiling.
    await limit(Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))), 1500);
    await limit(new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), 500);
    return true;
  })()`);
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return sessionId;
}

async function createTarget(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  return { targetId, sessionId: await attach(cdp, targetId) };
}

async function capture(cdp, sessionId, name) {
  await cdp.send("Page.bringToFront", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  // The override resizes the viewport; give the page a chance to re-lay out at 1280
  // before the pixels are read, or content still positioned for the old width is captured.
  await settle(cdp, sessionId);
  const image = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  writeFileSync(join(OUTPUT, name), Buffer.from(image.data, "base64"));
  console.log(`CAPTURED ${name}`);
}

function chromeArgs() {
  return [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--disable-extensions-file-access-check",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1000",
    "about:blank"
  ];
}

function stopChrome(process) {
  return new Promise((resolve) => {
    if (!process?.pid) return resolve();
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(process.pid)], { stdio: "ignore" });
    killer.on("exit", resolve);
    killer.on("error", resolve);
  });
}

function stopResidualChrome() {
  const escaped = CHROME.replaceAll("/", "\\").replaceAll("'", "''");
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
}

function fixtureEntry({ id, url, title, group, kind = "html", service = "other", at, pinned = false }) {
  const parsed = new URL(url);
  // URL.pathname keeps Japanese characters percent-encoded. The extension stores the
  // decoded path, so leaving it encoded here renders %E5%A3%B2... in the dashboard.
  const pathname = decodeURIComponent(parsed.pathname);
  const path = parsed.protocol === "file:" ? pathname : `${parsed.host}${pathname}`;
  return {
    id,
    url,
    path,
    key: url.toLowerCase(),
    title,
    group,
    firstSeenAt: at - 10_000,
    lastSeenAt: at,
    visitCount: 3,
    pinned,
    archived: false,
    missing: false,
    missingCheckedAt: at,
    source: "import",
    kind,
    service,
    later: false,
    laterAt: null
  };
}

const BOOKMARKS = [
  { title: "Gmail", url: "https://mail.google.com/" },
  { title: "ドライブ", url: "https://drive.google.com/" },
  { title: "カレンダー", url: "https://calendar.google.com/" },
  { title: "GitHub", url: "https://github.com/" },
  { title: "YouTube", url: "https://www.youtube.com/" },
  { title: "Notion", url: "https://www.notion.so/" },
  { title: "Slack", url: "https://app.slack.com/" },
  { title: "Figma", url: "https://www.figma.com/" },
  { title: "Amazon", url: "https://www.amazon.co.jp/" },
  { title: "Apple", url: "https://www.apple.com/jp/" }
];

function storageRecord(entries, now) {
  return {
    ...Object.fromEntries(entries.map((entry) => [`entry:${entry.id}`, entry])),
    "index:newtab": entries,
    "index:panel": entries,
    "excerpt:doc-weekly": {
      excerpt: "今週の進み具合と、次に確認することを短くまとめたページです。見出し、表、チェック項目を含む構成をそのまま把握できます。",
      shape: { headings: 2, tables: 1, maxTableRows: 4, ok: 3, warn: 1, ng: 0, figures: 1 },
      fetchedAt: now,
      lastSeenAt: now
    }
  };
}

async function openHub(cdp) {
  const page = await createTarget(cdp, "about:blank");
  await cdp.send("Page.navigate", { url: "chrome://newtab/" }, page.sessionId);
  await waitFor(() => evaluate(cdp, page.sessionId,
    "document.querySelector('[data-testid=\"hub-shell\"]')?.dataset.ready === 'true'"));
  return page;
}

async function hoverEntry(cdp, sessionId, id) {
  const point = await waitFor(() => evaluate(cdp, sessionId, `(() => {
    const rect = document.querySelector('[data-entry-id=${JSON.stringify(id)}]')?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(PROFILE, { recursive: true });
  const localPage = join(PROFILE, "quick-edit-demo.html");
  writeFileSync(localPage, `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>編集サンプル</title><style>
body{font-family:system-ui;margin:0;padding:104px 96px 64px;max-width:1000px;color:#183148;line-height:1.75}
h1{font-size:38px;margin:0 0 20px}
h2{font-size:22px;margin:32px 0 12px}
p{font-size:17px;margin:0 0 16px}
.card{padding:22px 26px;border-radius:14px;background:#eef7fa;margin:24px 0}
.card p{margin:0}
ul{font-size:17px;padding-left:1.4em;margin:0 0 20px}
li{margin-bottom:8px}
table{border-collapse:collapse;font-size:16px;width:100%;margin-top:8px}
th,td{border:1px solid #ccd9e2;padding:9px 14px;text-align:left}
th{background:#f2f7fa;font-weight:600}
</style></head><body>
<h1>ローカル HTML の編集</h1>
<p>ブラウザで表示したままの見た目で、この文書を直接書き換えられます。編集用の画面に移し替えないので、印刷レイアウトや配色が崩れません。</p>
<div class="card"><p>文字を選ぶとツールバーが使えます。太字、色、見出しの階層、箇条書き、リンクの張り替えに対応しています。</p></div>
<h2>できること</h2>
<ul>
<li>見出しと本文をその場で書き換える</li>
<li>表に行や列を足す、いらない行を削る</li>
<li>他のページから貼り付けた文字の書式を落とす</li>
<li>書き換えた結果をファイルとして保存する</li>
</ul>
<h2>変更の記録</h2>
<table>
<tr><th>日付</th><th>変更した箇所</th><th>状態</th></tr>
<tr><td>9月1日</td><td>見出しの文言</td><td>反映済み</td></tr>
<tr><td>9月1日</td><td>表の行を追加</td><td>反映済み</td></tr>
<tr><td>8月28日</td><td>本文の言い回し</td><td>確認待ち</td></tr>
</table>
</body></html>`, "utf8");

  stopResidualChrome();
  const chrome = spawn(CHROME, chromeArgs(), { stdio: "ignore" });
  try {
    let wsUrl = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        wsUrl = (await response.json()).webSocketDebuggerUrl ?? "";
        if (wsUrl) break;
      } catch {
        // Chrome is still starting.
      }
      await sleep(500);
    }
    if (!wsUrl) throw new Error("Chrome debug endpoint not reachable");

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new CDP(ws);
    const worker = await waitFor(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.find((target) => target.type === "service_worker" && target.url.includes("service-worker-loader"));
    });
    const extensionId = new URL(worker.url).host;
    const control = await createTarget(cdp, `chrome-extension://${extensionId}/src/dashboard/dashboard.html`);
    await waitFor(() => evaluate(cdp, control.sessionId, "Boolean(globalThis.chrome?.storage?.local)"));

    const now = Date.now();
    const entries = [
      // Well-known services everyone recognises, so the screenshots read the same
      // way for a reviewer in any country. Nothing here is real user data.
      fixtureEntry({ id: "svc-gmail", url: "https://mail.google.com/mail/u/0/#inbox", title: "Gmail — 受信トレイ", group: "Google", kind: "web", service: "google", at: now, pinned: true }),
      fixtureEntry({ id: "svc-drive", url: "https://drive.google.com/drive/my-drive", title: "Google ドライブ", group: "Google", kind: "web", service: "google", at: now - 1_000 }),
      fixtureEntry({ id: "svc-calendar", url: "https://calendar.google.com/calendar/u/0/r", title: "Google カレンダー", group: "Google", kind: "web", service: "google", at: now - 2_000 }),
      fixtureEntry({ id: "svc-docs", url: "https://docs.google.com/document/u/0/", title: "Google ドキュメント", group: "Google", kind: "web", service: "google", at: now - 3_000 }),
      fixtureEntry({ id: "svc-maps", url: "https://www.google.com/maps", title: "Google マップ", group: "Google", kind: "web", service: "google", at: now - 4_000 }),

      fixtureEntry({ id: "svc-github", url: "https://github.com/", title: "GitHub", group: "開発", kind: "web", service: "github", at: now - 5_000, pinned: true }),
      fixtureEntry({ id: "svc-pulls", url: "https://github.com/pulls", title: "GitHub — プルリクエスト", group: "開発", kind: "web", service: "github", at: now - 6_000 }),
      fixtureEntry({ id: "svc-so", url: "https://stackoverflow.com/questions", title: "Stack Overflow", group: "開発", kind: "web", service: "other", at: now - 7_000 }),
      fixtureEntry({ id: "svc-mdn", url: "https://developer.mozilla.org/ja/", title: "MDN Web Docs", group: "開発", kind: "web", service: "other", at: now - 8_000 }),
      fixtureEntry({ id: "svc-figma", url: "https://www.figma.com/files", title: "Figma — ファイル一覧", group: "開発", kind: "web", service: "other", at: now - 9_000 }),

      fixtureEntry({ id: "svc-slack", url: "https://app.slack.com/client", title: "Slack", group: "仕事", kind: "web", service: "other", at: now - 10_000 }),
      fixtureEntry({ id: "svc-notion", url: "https://www.notion.so/", title: "Notion", group: "仕事", kind: "web", service: "other", at: now - 11_000 }),
      fixtureEntry({ id: "svc-zoom", url: "https://zoom.us/meeting", title: "Zoom — ミーティング", group: "仕事", kind: "web", service: "other", at: now - 12_000 }),
      fixtureEntry({ id: "svc-dropbox", url: "https://www.dropbox.com/home", title: "Dropbox", group: "仕事", kind: "web", service: "other", at: now - 13_000 }),
      fixtureEntry({ id: "svc-trello", url: "https://trello.com/boards", title: "Trello — ボード", group: "仕事", kind: "web", service: "other", at: now - 14_000 }),

      fixtureEntry({ id: "svc-youtube", url: "https://www.youtube.com/", title: "YouTube", group: "よく見る", kind: "web", service: "other", at: now - 15_000 }),
      fixtureEntry({ id: "svc-x", url: "https://x.com/home", title: "X", group: "よく見る", kind: "web", service: "other", at: now - 16_000 }),
      fixtureEntry({ id: "svc-amazon", url: "https://www.amazon.co.jp/", title: "Amazon", group: "よく見る", kind: "web", service: "other", at: now - 17_000 }),
      fixtureEntry({ id: "svc-apple", url: "https://www.apple.com/jp/", title: "Apple", group: "よく見る", kind: "web", service: "other", at: now - 18_000 }),
      fixtureEntry({ id: "svc-wikipedia", url: "https://ja.wikipedia.org/", title: "Wikipedia", group: "よく見る", kind: "web", service: "other", at: now - 19_000 }),

      // Local HTML is what the extension is actually for, so it gets the most rows.
      fixtureEntry({ id: "doc-weekly", url: "file:///C:/Users/demo/reports/週次レポート.html", title: "週次レポート", group: "ローカルの資料", at: now - 20_000, pinned: true }),
      fixtureEntry({ id: "doc-test", url: "file:///C:/Users/demo/reports/テスト結果.html", title: "要確認: テスト結果", group: "ローカルの資料", at: now - 21_000 }),
      fixtureEntry({ id: "doc-summary", url: "file:///C:/Users/demo/reports/集計まとめ.html", title: "集計のまとめ", group: "ローカルの資料", at: now - 22_000 }),
      fixtureEntry({ id: "doc-minutes", url: "file:///C:/Users/demo/reports/議事録.html", title: "議事録", group: "ローカルの資料", at: now - 23_000 }),
      fixtureEntry({ id: "doc-check", url: "file:///C:/Users/demo/reports/確認事項.html", title: "要確認: 残っている項目", group: "ローカルの資料", at: now - 24_000 }),
      fixtureEntry({ id: "doc-design", url: "file:///C:/Users/demo/docs/設計メモ.html", title: "設計メモ", group: "ローカルの資料", at: now - 25_000 }),
      fixtureEntry({ id: "doc-howto", url: "file:///C:/Users/demo/docs/手順書.html", title: "手順書", group: "ローカルの資料", at: now - 26_000 }),
      fixtureEntry({ id: "doc-glossary", url: "file:///C:/Users/demo/docs/用語集.html", title: "用語集", group: "ローカルの資料", at: now - 27_000 }),

      fixtureEntry({ id: "pdf-manual", url: "file:///C:/Users/demo/docs/マニュアル.pdf", title: "マニュアル", group: "ローカルの資料", kind: "pdf", at: now - 28_000 }),
      fixtureEntry({ id: "pdf-report", url: "file:///C:/Users/demo/reports/報告書.pdf", title: "報告書", group: "ローカルの資料", kind: "pdf", at: now - 29_000 }),
      fixtureEntry({ id: "pdf-ref", url: "file:///C:/Users/demo/docs/参考資料.pdf", title: "参考資料", group: "ローカルの資料", kind: "pdf", at: now - 30_000 }),
      fixtureEntry({ id: "pdf-slides", url: "file:///C:/Users/demo/docs/説明スライド.pdf", title: "説明スライド", group: "ローカルの資料", kind: "pdf", at: now - 31_000 }),

      fixtureEntry({ id: "local-preview", url: "http://localhost:5173/preview.html", title: "表示の確認", group: "localhost", kind: "web", service: "other", at: now - 32_000 }),
      fixtureEntry({ id: "local-build", url: "http://localhost:4173/report.html", title: "ビルド後の確認", group: "localhost", kind: "web", service: "other", at: now - 33_000 }),
      fixtureEntry({ id: "local-story", url: "http://localhost:6006/", title: "コンポーネントの一覧", group: "localhost", kind: "web", service: "other", at: now - 34_000 })
    ];
    await evaluate(cdp, control.sessionId, `(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.storage.local.set(${JSON.stringify(storageRecord(entries, now))});
      return true;
    })()`);

    // The new tab page renders the user's bookmark bar. An empty bar makes the page
    // look unfinished, so seed it with the shortcuts a typical browser already has.
    await evaluate(cdp, control.sessionId, `(async () => {
      const bar = '1';
      const existing = await chrome.bookmarks.getChildren(bar);
      await Promise.all(existing.map((node) => chrome.bookmarks.removeTree(node.id)));
      const shortcuts = ${JSON.stringify(BOOKMARKS)};
      for (const shortcut of shortcuts) {
        await chrome.bookmarks.create({ parentId: bar, title: shortcut.title, url: shortcut.url });
      }
      return true;
    })()`);

    const catalog = await openHub(cdp);
    await waitFor(() => evaluate(cdp, catalog.sessionId,
      "document.querySelectorAll('[data-entry-id]').length >= 35 && document.querySelectorAll('.hub-group').length >= 5"));
    await settle(cdp, catalog.sessionId);
    await capture(cdp, catalog.sessionId, "01-catalog.png");

    await evaluate(cdp, catalog.sessionId, `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'google');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await waitFor(() => evaluate(cdp, catalog.sessionId, "document.querySelectorAll('[data-entry-id]').length >= 4"));
    await settle(cdp, catalog.sessionId);
    await capture(cdp, catalog.sessionId, "02-search.png");

    await evaluate(cdp, catalog.sessionId, `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => evaluate(cdp, catalog.sessionId, "document.querySelectorAll('[data-entry-id]').length >= 35"));
    await hoverEntry(cdp, catalog.sessionId, "doc-weekly");
    await waitFor(() => evaluate(cdp, catalog.sessionId, `(() => {
      const card = document.querySelector('[data-testid="preview-card"]');
      if (card?.dataset.previewEntryId !== 'doc-weekly') return false;
      if (!document.querySelector('[data-testid="preview-excerpt"]')) return false;
      const style = getComputedStyle(card);
      // The card fades in; capturing before it is fully opaque bleeds the list through it.
      return Number(style.opacity) === 1 && style.visibility === 'visible';
    })()`));
    await settle(cdp, catalog.sessionId);
    await capture(cdp, catalog.sessionId, "03-preview.png");

    // The side panel is laid out for a ~400px rail; rendering it at 1280 stretches it
    // into something users never see. The dashboard is the extension's real full-width
    // surface, so it is what belongs in a 1280x800 store screenshot.
    const dashboard = await createTarget(cdp, `chrome-extension://${extensionId}/src/dashboard/dashboard.html`);
    await waitFor(() => evaluate(cdp, dashboard.sessionId,
      "document.body.textContent.includes('週次レポート') && document.body.textContent.includes('Gmail')"));
    await settle(cdp, dashboard.sessionId);
    await capture(cdp, dashboard.sessionId, "04-dashboard.png");

    const editor = await createTarget(cdp, pathToFileURL(localPage).href);
    await waitFor(() => evaluate(cdp, editor.sessionId, "document.readyState === 'complete' && Boolean(document.querySelector('h1'))"));
    const editorTab = await waitFor(() => evaluate(cdp, control.sessionId,
      `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(pathToFileURL(localPage).href)})?.id ?? null)`));
    // The content script is injected at document_idle, so the tab can exist before it
    // can receive messages. Retry until the toggle is actually acknowledged; waitFor
    // stops at the first success, so the toggle never fires twice and turns itself off.
    await waitFor(() => evaluate(cdp, control.sessionId,
      `chrome.tabs.sendMessage(${editorTab}, { type: 'quick-edit:toggle' })
         .then((result) => result?.ok === true)
         .catch(() => false)`));
    await waitFor(() => evaluate(cdp, editor.sessionId, "Boolean(document.querySelector('#he-quick-edit-host')) && document.body.contentEditable === 'true'"));
    await settle(cdp, editor.sessionId);
    await capture(cdp, editor.sessionId, "05-editor.png");

    ws.close();
    console.log("DONE 5 screenshots");
  } finally {
    await stopChrome(chrome);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
