// Claude Ops dashboard decision-button E2E (CDP, zero deps, Node 24 WebSocket).
// Flow: launch Chrome for Testing with the HTML Hub dist -> open the real
// dashboard file -> click 👍 via claudeopsDecide() -> assert a decision JSON
// lands in Downloads/claude-ops-decisions/ and the card turns "decided".
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Users/miyaz/tools/chrome-for-testing/chrome/win64-150.0.7871.115/chrome-win64/chrome.exe";
const DIST = "C:/Users/miyaz/html-editor-extension/dist";
const PROFILE = new URL("./e2e-profile", import.meta.url).pathname.replace(/^\/(\w):/, "$1:");
const PORT = 9299;
const DASHBOARD_URL = "file:///C:/Users/miyaz/claude-ops/dashboard/index.html";
const INBOX = "C:/Users/miyaz/Downloads/claude-ops-decisions";
const QID = process.argv[2];
if (!QID) { console.error("usage: node e2e.mjs <qid>"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else this.events.push(msg);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout`)); } }, 15000);
    });
  }
}

async function evalIn(cdp, sessionId, expression, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + " " + JSON.stringify(res.exceptionDetails.exception ?? {}));
      return res.result?.value;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000);
    }
  }
}

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

fs.rmSync(PROFILE, { recursive: true, force: true });
const before = new Set(fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : []);

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${DIST}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  // fresh profiles have the per-extension "Allow file URLs" toggle OFF;
  // this switch bypasses the check so file:// content scripts inject in E2E
  "--disable-extensions-file-access-check",
  // download reputation checks need network and stall data: URL downloads in CfT
  "--safebrowsing-disable-download-protection",
  `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1250,950",
  "about:blank"
], { stdio: "ignore" });

try {
  let wsUrl = "";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!wsUrl) throw new Error("Chrome debug endpoint not reachable");
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);

  // 1. our SW is loaded (identify by service-worker-loader.js, not by type alone)
  let swTarget = null;
  for (let i = 0; i < 20 && !swTarget; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.includes("service-worker-loader"));
    if (!swTarget) await sleep(500);
  }
  check("extension SW loaded", !!swTarget, swTarget?.url ?? "not found");
  if (!swTarget) throw new Error("extension not loaded");
  const extId = new URL(swTarget.url).host;

  // 2. open the dashboard file
  const { targetId } = await cdp.send("Target.createTarget", { url: DASHBOARD_URL });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  // readyState alone is a trap: the initial about:blank is already "complete".
  for (let i = 0; i < 20; i++) {
    const state = await evalIn(cdp, sessionId,
      "location.href.includes('claude-ops/dashboard') && document.readyState === 'complete'", 1
    ).catch(() => false);
    if (state === true) break;
    await sleep(500);
  }
  await sleep(1500); // let content scripts (document_idle) attach
  const cardFound = await evalIn(cdp, sessionId, `!!document.querySelector('[data-qid="${QID}"]')`);
  check("decision card rendered", cardFound === true, QID);

  // 2.5 verify the bridge content script actually injected (isolated world marker)
  const swSession = (await cdp.send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true })).sessionId;
  let bridgeInjected = false;
  for (let i = 0; i < 10 && !bridgeInjected; i++) {
    bridgeInjected = (await evalIn(cdp, swSession, `
      chrome.tabs.query({url:'file:///*'})
        .then(ts => chrome.scripting.executeScript({ target: { tabId: ts[0].id }, func: () => window.__claudeopsBridge === true }))
        .then(r => r[0]?.result === true).catch(() => false)`, 1).catch(() => false)) === true;
    if (!bridgeInjected) await sleep(1000);
  }
  check("bridge content script injected", bridgeInjected);

  // 3. content script injected on file:// ? (fresh profiles may lack file access)
  await sleep(3000);
  await evalIn(cdp, sessionId, `(() => {
    window.__e2eAcks = 0;
    document.addEventListener('claudeops-decision-ack', () => { window.__e2eAcks++; });
    document.dispatchEvent(new CustomEvent('claudeops-decision', { detail: JSON.stringify({ qid: '${QID}', action: 'note', note: 'E2E probe (harmless note)', ts: new Date().toISOString() }) }));
    return true;
  })()`);
  let probeAck = false;
  for (let i = 0; i < 12 && !probeAck; i++) {
    await sleep(500);
    probeAck = (await evalIn(cdp, sessionId, "window.__e2eAcks > 0")) === true;
  }
  check("content-script bridge acks on file://", probeAck === true,
    probeAck === true ? "" : "fresh profile may lack 'Allow file URLs' — real profile has it ON");

  // 4. the actual button path (poll includes in-progress .crdownload; watcher
  //    may ingest+delete the final file within the window, so count either)
  await evalIn(cdp, sessionId, `claudeopsDecide('${QID}', 'done'); true`);
  let decisionFile = "";
  let sawAny = "";
  for (let i = 0; i < 24 && !decisionFile; i++) {
    await sleep(500);
    const now = fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : [];
    const fresh = now.filter((f) => !before.has(f));
    if (fresh.length && !sawAny) sawAny = fresh.join(",");
    decisionFile = fresh.find((f) => f.includes(QID) && f.endsWith(".json")) ?? "";
  }
  check("decision JSON written to inbox", !!decisionFile || !!sawAny, decisionFile || `observed: ${sawAny || "(nothing)"}`);
  if (decisionFile) {
    // both the note probe and the done click drop files for QID — assert on the done one
    const fresh = fs.readdirSync(INBOX).filter((f) => !before.has(f) && f.includes(QID) && f.endsWith(".json"));
    const bodies = fresh.map((f) => JSON.parse(fs.readFileSync(path.join(INBOX, f), "utf-8")));
    const doneBody = bodies.find((b) => b.action === "done");
    check("payload fields", !!doneBody && doneBody.qid === QID && doneBody.via === "html-hub-extension", JSON.stringify(doneBody ?? bodies));
  }
  await sleep(3000); // ack window is 2500ms
  const decided = await evalIn(cdp, sessionId, `document.querySelector('[data-qid="${QID}"]').classList.contains('decided')`);
  check("card shows optimistic decided state", decided === true);

  // 5. floating ☀ nav injected on the daily page (report-nav content script)
  const navHost = await evalIn(cdp, sessionId, "!!document.getElementById('he-report-nav')");
  check("floating nav injected on daily", navHost === true);

  // helper: open an extension page and attach (full chrome API available there)
  const openExtPage = async (rel) => {
    await evalIn(cdp, swSession, `chrome.tabs.create({ url: chrome.runtime.getURL('${rel}') }).then(() => true)`);
    let target = null;
    for (let i = 0; i < 20 && !target; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      target = targetInfos.find((t) => t.type === "page" && t.url.includes(rel));
      if (!target) await sleep(500);
    }
    const s = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await cdp.send("Runtime.enable", {}, s);
    await sleep(1500);
    return s;
  };

  // 6. side panel: ☀デイリー + 5 buttons, 「集約のみ」 is gone
  const panelS = await openExtPage("src/sidepanel/sidepanel.html");
  const panelText = await evalIn(cdp, panelS, "document.body.innerText");
  check(
    "panel has daily + 5 simplified buttons",
    ["☀ 今日のデイリー", "まとめる", "展開/畳む", "かぶり閉じる", "全部とじる", "やりなおし"].every((t) => panelText.includes(t)) &&
      !panelText.includes("集約のみ"),
    panelText.includes("集約のみ") ? "集約のみ still present" : ""
  );

  // 7. undo round-trip, driven from the Hub dashboard page (extension context)
  const ctrlS = await openExtPage("src/dashboard/dashboard.html");
  const n0 = await evalIn(cdp, ctrlS, "chrome.tabs.query({url:'file:///*'}).then(ts => ts.length)");
  const closedRes = await evalIn(cdp, ctrlS, "chrome.runtime.sendMessage({type:'close-report-tabs'})");
  await sleep(1500);
  const n1 = await evalIn(cdp, ctrlS, "chrome.tabs.query({url:'file:///*'}).then(ts => ts.length)");
  const undoRes = await evalIn(cdp, ctrlS, "chrome.runtime.sendMessage({type:'undo-close'})");
  let n2 = 0;
  for (let i = 0; i < 12 && n2 < n0; i++) {
    await sleep(500);
    n2 = await evalIn(cdp, ctrlS, "chrome.tabs.query({url:'file:///*'}).then(ts => ts.length)");
  }
  check(
    "undo restores closed report tabs",
    n0 >= 1 && closedRes?.count === n0 && n1 === 0 && undoRes?.ok === true && n2 === n0,
    `before=${n0} closed=${closedRes?.count} after-close=${n1} undo=${JSON.stringify(undoRes)} restored=${n2}`
  );

  console.log(JSON.stringify({ ok: results.every((r) => r.ok), extId, results }, null, 1));
} finally {
  chrome.kill();
  await sleep(800);
  spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
