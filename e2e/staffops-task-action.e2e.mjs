// Safe Staff Ops task-action bridge E2E (CDP, zero deps).
// The payload is dryRun:true: native host may write/move a local inbox artifact,
// but watcher must never call the Staff Ops write tool for this action.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:/Users/miyaz/tools/chrome-for-testing/chrome/win64-150.0.7871.115/chrome-win64/chrome.exe";
const DIST = "C:/Users/miyaz/html-editor-extension/dist";
const PROFILE = `C:/Users/miyaz/html-editor-extension/e2e/staffops-profile-${process.pid}-${Date.now()}`;
const PORT = 9400 + (process.pid % 200);
const DASHBOARD_URL = "file:///C:/Users/miyaz/claude-ops/dashboard/index.html";
const ACTION_DIRS = ["inbox", "processed", "rejected", "quarantine"].map(
  (name) => `C:/Users/miyaz/claude-ops/actions/${name}`
);
const ACTION_ID = `e2e:${Date.now()}:${process.pid}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message); this.pending.delete(message.id);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => message.error
        ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }
      }, 15000);
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}

function findArtifact() {
  for (const dir of ACTION_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((item) => item.startsWith("staffops-action-") && item.endsWith(".json"))) {
      const file = path.join(dir, name);
      try {
        const body = JSON.parse(fs.readFileSync(file, "utf8"));
        if (body.actionId === ACTION_ID) return { file, body };
      } catch { /* watcher may be moving the file */ }
    }
  }
  return null;
}

const chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`, `--load-extension=${DIST}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--disable-extensions-file-access-check", `--remote-debugging-port=${PORT}`,
  "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: "ignore" });

try {
  let wsUrl = "";
  for (let i = 0; i < 30 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(500); }
  }
  if (!wsUrl) throw new Error("Chrome debug endpoint not reachable");
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: DASHBOARD_URL });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  let ref = "";
  for (let i = 0; i < 25 && !ref; i++) {
    await sleep(500);
    ref = await evaluate(cdp, sessionId, "document.querySelector('[data-task-ref]')?.dataset.taskRef || ''").catch(() => "");
  }
  if (!ref) throw new Error("dashboard has no rendered public task ref");
  await sleep(1200);
  const ack = await evaluate(cdp, sessionId, `new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok:false, error:'ack timeout' }), 12000);
    document.addEventListener('staffops-task-action-ack', (event) => {
      const value = JSON.parse(event.detail || '{}');
      if (value.actionId === '${ACTION_ID}') { clearTimeout(timer); resolve(value); }
    });
    document.dispatchEvent(new CustomEvent('staffops-task-action', { detail: JSON.stringify({
      type:'staffops-task-action', ref:'${ref}', actionId:'${ACTION_ID}', action:'complete',
      note:'', source:'dashboard', dryRun:true, ts:new Date().toISOString()
    }) }));
  })`);
  if (!ack?.ok) throw new Error(`bridge ack failed: ${JSON.stringify(ack)}`);
  let artifact = null;
  for (let i = 0; i < 24 && !artifact; i++) { artifact = findArtifact(); if (!artifact) await sleep(500); }
  if (!artifact) throw new Error("typed action artifact not found in inbox/processed/rejected/quarantine");
  if (artifact.body.dryRun !== true || artifact.body.ref !== ref || artifact.body.action !== "complete") {
    throw new Error(`unexpected payload: ${JSON.stringify(artifact.body)}`);
  }
  console.log(JSON.stringify({ ok: true, ref, actionId: ACTION_ID, artifact: artifact.file, dryRun: true }));
} finally {
  chrome.kill();
  await sleep(800);
  spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
}
