// HTML Hub tab-discard E2E (CDP, zero dependencies, Node 24 WebSocket).
import { spawn } from "node:child_process";

const CHROME = "C:/Users/miyaz/tools/chrome-for-testing/chrome/win64-150.0.7871.115/chrome-win64/chrome.exe";
const DIST = "C:/Users/miyaz/html-editor-extension/dist";
const PROFILE = `C:/Users/miyaz/html-editor-extension/e2e/e2e-profile/discard-${process.pid}-${Date.now()}`;
const PORT = 9300 + (process.pid % 500);
const REPORT_A = "file:///C:/Users/miyaz/html-editor-extension/src/dashboard/dashboard.html";
const REPORT_B = "file:///C:/Users/miyaz/html-editor-extension/src/editor/editor.html";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, 15000);
    });
  }
}

async function evalIn(cdp, sessionId, expression, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text + " " + JSON.stringify(result.exceptionDetails.exception ?? {}));
      }
      return result.result?.value;
    } catch (error) {
      if (attempt === retries - 1) throw error;
      await sleep(500);
    }
  }
}

async function waitFor(fn, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--disable-extensions-file-access-check",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1250,950",
    "about:blank"
  ],
  { stdio: "ignore" }
);

try {
  let wsUrl = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await response.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await sleep(500);
  }
  if (!wsUrl) throw new Error("Chrome debug endpoint not reachable");

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const cdp = new CDP(ws);

  const swTarget = await waitFor(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find(
      (target) => target.type === "service_worker" && target.url.includes("service-worker-loader")
    );
  });
  check("extension SW loaded", Boolean(swTarget), swTarget?.url ?? "not found");
  if (!swTarget) throw new Error("extension not loaded");

  const extensionId = new URL(swTarget.url).host;
  const { targetId: controlTargetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/src/dashboard/dashboard.html`
  });
  const { sessionId: controlSession } = await cdp.send("Target.attachToTarget", {
    targetId: controlTargetId,
    flatten: true
  });
  await cdp.send("Runtime.enable", {}, controlSession);
  await waitFor(() => evalIn(cdp, controlSession, "document.readyState === 'complete'", 1));

  const alarm = await evalIn(
    cdp,
    controlSession,
    "chrome.alarms.get('reporthub:auto-discard')"
  );
  check(
    "periodic auto-discard alarm registered",
    alarm?.name === "reporthub:auto-discard" && alarm.periodInMinutes === 5,
    JSON.stringify(alarm)
  );

  await evalIn(
    cdp,
    controlSession,
    `(async () => {
      const old = await chrome.tabs.query({ url: 'file:///*' });
      if (old.length) await chrome.tabs.remove(old.map((tab) => tab.id));
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      return true;
    })()`
  );

  const opened = await evalIn(
    cdp,
    controlSession,
    `(async () => {
      const a = await chrome.tabs.create({ url: ${JSON.stringify(REPORT_A)}, active: false });
      const b = await chrome.tabs.create({ url: ${JSON.stringify(REPORT_B)}, active: true });
      return { a: a.id, b: b.id };
    })()`
  );

  const entryBefore = await waitFor(() =>
    evalIn(
      cdp,
      controlSession,
      `chrome.storage.local.get(null).then((all) =>
        Object.values(all).find((value) => value?.url === ${JSON.stringify(REPORT_A)}) ?? null
      )`,
      1
    )
  );
  check(
    "both file report tabs opened and cataloged",
    entryBefore?.visitCount != null,
    `tabs=${JSON.stringify(opened)} visit=${entryBefore?.visitCount}`
  );

  const quickEditGuard = await evalIn(
    cdp,
    controlSession,
    `(async () => {
      const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(REPORT_A)} });
      const enabled = await chrome.tabs.sendMessage(tab.id, { type: 'quick-edit:enable' });
      const result = await chrome.runtime.sendMessage({ type: 'discard-report-tabs' });
      const after = await chrome.tabs.get(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'quick-edit:toggle' });
      return { editing: enabled.editing, count: result.count, discarded: after.discarded };
    })()`
  );
  check(
    "Quick Edit report is protected from discard",
    quickEditGuard?.editing === true && quickEditGuard.count === 0 && quickEditGuard.discarded === false,
    JSON.stringify(quickEditGuard)
  );

  const discardResult = await evalIn(
    cdp,
    controlSession,
    "chrome.runtime.sendMessage({ type: 'discard-report-tabs' })"
  );
  const manualState = await waitFor(() =>
    evalIn(
      cdp,
      controlSession,
      `(async () => {
        const tabs = await chrome.tabs.query({ url: 'file:///*' });
        const a = tabs.find((tab) => tab.url === ${JSON.stringify(REPORT_A)});
        const b = tabs.find((tab) => tab.url === ${JSON.stringify(REPORT_B)});
        return a?.discarded && !b?.discarded ? { a: a.id, b: b.id } : null;
      })()`,
      1
    )
  );
  check(
    "discard-report-tabs discards only the inactive report",
    discardResult?.ok === true && discardResult.count === 1 && Boolean(manualState),
    `response=${JSON.stringify(discardResult)} state=${JSON.stringify(manualState)}`
  );

  const resumeTab = await evalIn(
    cdp,
    controlSession,
    `(async () => {
      const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(REPORT_A)} });
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tab.id, windowId: tab.windowId };
    })()`
  );
  const resumeProcessed = await waitFor(() =>
    evalIn(
      cdp,
      controlSession,
      `(async () => {
        const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(REPORT_A)} });
        if (!tab || tab.discarded) return null;
        const session = await chrome.storage.session.get(null);
        if (Object.keys(session).some((key) => key.startsWith('tabdiscard:'))) return null;
        const all = await chrome.storage.local.get(null);
        const entry = Object.values(all).find((value) => value?.url === ${JSON.stringify(REPORT_A)});
        return entry?.lastSeenAt > ${entryBefore.lastSeenAt}
          ? { tabId: tab.id, status: tab.status, visitCount: entry.visitCount }
          : null;
      })()`,
      1
    )
  );
  check(
    "discard resume does not increment visitCount",
    resumeProcessed?.visitCount === entryBefore.visitCount,
    `before=${entryBefore.visitCount} after=${resumeProcessed?.visitCount ?? "not processed"} tab=${JSON.stringify(resumeTab)}`
  );

  const organizeResult = await evalIn(
    cdp,
    controlSession,
    "chrome.runtime.sendMessage({ type: 'organize-tabs', collapse: true })"
  );
  const collapsedState = await waitFor(() =>
    evalIn(
      cdp,
      controlSession,
      `(async () => {
        const tabs = await chrome.tabs.query({ url: 'file:///*' });
        if (tabs.length !== 2 || tabs.some((tab) => tab.groupId < 0)) return null;
        if (new Set(tabs.map((tab) => tab.groupId)).size !== 1) return null;
        const group = await chrome.tabGroups.get(tabs[0].groupId);
        return group.collapsed && tabs.some((tab) => tab.discarded)
          ? { collapsed: group.collapsed, discarded: tabs.filter((tab) => tab.discarded).length }
          : null;
      })()`,
      1
    )
  );
  check(
    "organize-collapse keeps grouping and discards collapsed reports",
    organizeResult?.ok === true && organizeResult.count === 2 && Boolean(collapsedState),
    `response=${JSON.stringify(organizeResult)} state=${JSON.stringify(collapsedState)}`
  );

  console.log(JSON.stringify({ ok: results.every((result) => result.ok), extensionId, results }, null, 2));
} finally {
  chrome.kill();
  await sleep(800);
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
    killer.on("exit", resolve);
    killer.on("error", resolve);
  });
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
