// HTML Hub new-tab E2E (CDP, zero dependencies, Node 24 WebSocket).
import { spawn, spawnSync } from "node:child_process";
import { S } from "../src/newtab/strings.ts";

const CHROME = "C:/Users/miyaz/tools/chrome-for-testing/chrome/win64-150.0.7871.115/chrome-win64/chrome.exe";
const DIST = "C:/Users/miyaz/html-editor-extension/dist";
const PROFILE = `C:/Users/miyaz/html-editor-extension/e2e/e2e-profile/newtab-${process.pid}-${Date.now()}`;
const PORT = 9600 + (process.pid % 300);
const FILE_HTML = "file:///C:/Users/miyaz/html-editor-extension/src/newtab/index.html";
const WEB_URL = "https://example.com/";
const PDF_URL = "https://example.com/y.pdf";
const REPEAT_URL = `https://example.com/?hub-e2e=${Date.now()}`;

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

async function waitFor(fn, timeoutMs = 15000) {
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

function stopResidualChromeForTesting() {
  const escaped = CHROME.replaceAll("/", "\\").replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  return sessionId;
}

async function createControl(cdp, extensionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/src/dashboard/dashboard.html`
    });
    const sessionId = await attach(cdp, targetId);
    const ready = await waitFor(
      () =>
        evalIn(
          cdp,
          sessionId,
          "location.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.storage?.local)",
          1
        ),
      4000
    );
    if (ready) return { targetId, sessionId };
    await cdp.send("Target.closeTarget", { targetId });
    await sleep(500);
  }
  throw new Error("extension control page did not become ready");
}

async function openTab(cdp, controlSession, url, active = false) {
  const tab = await evalIn(
    cdp,
    controlSession,
    `chrome.tabs.create({ url: ${JSON.stringify(url)}, active: ${active} }).then((tab) => ({ id: tab.id }))`
  );
  await waitFor(() =>
    evalIn(
      cdp,
      controlSession,
      `chrome.tabs.get(${tab.id}).then((tab) => tab.status === 'complete').catch(() => false)`,
      1
    )
  );
  return tab.id;
}

async function openHub(cdp, control, extensionId) {
  void control;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const sessionId = await attach(cdp, targetId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: "chrome://newtab/" }, sessionId);
  const ready = await waitFor(() =>
    evalIn(
      cdp,
      sessionId,
      `document.title === ${JSON.stringify(S.documentTitle)} ? { title: document.title, href: location.href } : null`,
      1
    )
  );
  if (!ready) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = targetInfos.filter((item) => item.type === "page").map((item) => item.url);
    const state = await evalIn(cdp, sessionId, "({ title: document.title, href: location.href })", 1);
    throw new Error(`new-tab title not found after Page.navigate: extension=${extensionId} state=${JSON.stringify(state)} pages=${JSON.stringify(pages)}`);
  }
  const appReady = await waitFor(() =>
    evalIn(
      cdp,
      sessionId,
      "document.querySelector('[data-testid=\"hub-shell\"]')?.dataset.ready === 'true'",
      1
    )
  );
  if (!appReady) throw new Error("new-tab app did not become ready");
  return { targetId, sessionId };
}

async function findEntry(cdp, controlSession, url) {
  return evalIn(
    cdp,
    controlSession,
    `chrome.storage.local.get(null).then((all) => {
      const pair = Object.entries(all).find(([key, value]) => key.startsWith('entry:') && value?.url === ${JSON.stringify(url)});
      return pair ? { storageKey: pair[0], entry: pair[1] } : null;
    })`,
    1
  );
}

async function waitForEntry(cdp, controlSession, url, predicate = () => true) {
  return waitFor(async () => {
    const found = await findEntry(cdp, controlSession, url);
    return found && predicate(found.entry) ? found : null;
  });
}

function chromeArgs(port) {
  return [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--disable-extensions-file-access-check",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1000",
    "about:blank"
  ];
}

async function stopProcessTree(process) {
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(process.pid)], { stdio: "ignore" });
    killer.on("exit", resolve);
    killer.on("error", resolve);
  });
  if (process.exitCode == null) process.kill();
  await sleep(600);
}

stopResidualChromeForTesting();

const chrome = spawn(
  CHROME,
  chromeArgs(PORT),
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
  let control = await createControl(cdp, extensionId);
  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      const tabs = await chrome.tabs.query({});
      const removable = tabs.filter((tab) => tab.url !== location.href && !tab.url?.startsWith('chrome://')).map((tab) => tab.id);
      if (removable.length) await chrome.tabs.remove(removable);
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      return true;
    })()`
  );

  const { targetId: panelTargetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`
  });
  const panelSession = await attach(cdp, panelTargetId);
  const reportState = await waitFor(() =>
    evalIn(
      cdp,
      panelSession,
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const body = document.querySelector('[class*="tabBody"]');
        return buttons.length >= 2 && body?.childElementCount
          ? { labels: buttons.slice(0, 2).map((button) => button.textContent.trim()), active: buttons[0].className }
          : null;
      })()`,
      1
    )
  );
  const editorState = await evalIn(
    cdp,
    panelSession,
    `(async () => {
      const buttons = [...document.querySelectorAll('button')];
      buttons[1].click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        title: document.querySelector('h1')?.textContent,
        active: [...document.querySelectorAll('button')][1]?.className
      };
    })()`
  );
  const reportReturn = await evalIn(
    cdp,
    panelSession,
    `(async () => {
      const buttons = [...document.querySelectorAll('button')];
      buttons[0].click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        hasBody: Boolean(document.querySelector('[class*="tabBody"]')?.childElementCount),
        active: [...document.querySelectorAll('button')][0]?.className
      };
    })()`
  );
  check(
    "existing side-panel report and editor tabs",
    reportState?.labels?.length === 2 &&
      reportState.active.includes("tabActive") &&
      editorState?.title === "HTML Editor" &&
      editorState.active.includes("tabActive") &&
      reportReturn?.hasBody === true &&
      reportReturn.active.includes("tabActive"),
    `labels=${JSON.stringify(reportState?.labels)} editor=${editorState?.title} reportBack=${reportReturn?.hasBody}`
  );
  await cdp.send("Target.closeTarget", { targetId: panelTargetId });

  let hub = await openHub(cdp, control, extensionId);
  const hubState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `document.title === ${JSON.stringify(S.documentTitle)} ? {
        title: document.title,
        url: location.href,
        focused: document.hasFocus(),
        activeTestId: document.activeElement?.dataset?.testid ?? null
      } : null`,
      1
    )
  );
  check(
    "a. newtab override title",
    hubState?.title === S.documentTitle,
    JSON.stringify(hubState)
  );
  check(
    "a. page-side focus behavior recorded",
    Boolean(hubState),
    `focused=${hubState?.focused} active=${hubState?.activeTestId}`
  );

  const firstTab = await openTab(cdp, control.sessionId, REPEAT_URL);
  const firstVisit = await waitForEntry(cdp, control.sessionId, REPEAT_URL, (entry) => entry.visitCount === 1);
  const firstIndex = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get('index:newtab').then((got) => got['index:newtab'] ?? [])`
  );
  check(
    "b. one visit is not listed",
    firstVisit?.entry.visitCount === 1 && !firstIndex.some((entry) => entry.id === firstVisit.entry.id),
    `visit=${firstVisit?.entry.visitCount} listed=${firstIndex.some((entry) => entry.id === firstVisit?.entry.id)}`
  );
  await evalIn(cdp, control.sessionId, `chrome.tabs.remove(${firstTab})`);

  const secondTab = await openTab(cdp, control.sessionId, REPEAT_URL);
  const secondVisit = await waitForEntry(cdp, control.sessionId, REPEAT_URL, (entry) => entry.visitCount === 2);
  const secondIndex = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get('index:newtab').then((got) =>
        (got['index:newtab'] ?? []).some((entry) => entry.id === ${JSON.stringify(secondVisit?.entry.id)})
      )`,
      1
    )
  );
  await evalIn(cdp, control.sessionId, `chrome.tabs.remove(${secondTab})`);
  const listedInHub = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Boolean(document.querySelector('[data-entry-id=${JSON.stringify(secondVisit?.entry.id)}]'))`,
      1
    )
  );
  check(
    "b. second visit is listed",
    secondVisit?.entry.visitCount === 2 && Boolean(secondIndex) && Boolean(listedInHub),
    `visit=${secondVisit?.entry.visitCount} index=${Boolean(secondIndex)} dom=${Boolean(listedInHub)}`
  );

  const oldAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      const got = await chrome.storage.local.get(${JSON.stringify(secondVisit.storageKey)});
      await chrome.storage.local.set({
        [${JSON.stringify(secondVisit.storageKey)}]: { ...got[${JSON.stringify(secondVisit.storageKey)}], lastSeenAt: ${oldAt}, pinned: false }
      });
      await chrome.storage.local.remove('index:newtab');
      return true;
    })()`
  );
  hub = await openHub(cdp, control, extensionId);
  const silentMissing = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `chrome.storage.local.get('index:newtab').then((got) => Array.isArray(got['index:newtab']))`,
      1
    )
  );
  const silentVisible = await evalIn(
    cdp,
    hub.sessionId,
    `Boolean(document.querySelector('[data-entry-id=${JSON.stringify(secondVisit.entry.id)}]'))`
  );
  check(
    "c. eight-day entry is silent",
    Boolean(silentMissing) && silentVisible === false,
    `rebuilt=${Boolean(silentMissing)} visible=${silentVisible}`
  );

  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      const got = await chrome.storage.local.get(${JSON.stringify(secondVisit.storageKey)});
      await chrome.storage.local.set({
        [${JSON.stringify(secondVisit.storageKey)}]: { ...got[${JSON.stringify(secondVisit.storageKey)}], pinned: true }
      });
      await chrome.storage.local.remove('index:newtab');
      return true;
    })()`
  );
  hub = await openHub(cdp, control, extensionId);
  const pinnedVisible = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Boolean(document.querySelector('[data-entry-id=${JSON.stringify(secondVisit.entry.id)}]'))`,
      1
    )
  );
  check("c. pinned eight-day entry remains", Boolean(pinnedVisible), `visible=${Boolean(pinnedVisible)}`);

  const laterUrl = `https://example.com/?hub-later=${Date.now()}`;
  const laterTab = await openTab(cdp, control.sessionId, laterUrl);
  const laterEntry = await waitForEntry(cdp, control.sessionId, laterUrl, (entry) => entry.visitCount === 1);
  const laterButton = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `document.querySelector('[data-testid=${JSON.stringify(`later-${laterEntry?.entry.id}`)}]')?.click() || true`,
      1
    )
  );
  const movedLater = await waitFor(async () => {
    const found = await findEntry(cdp, control.sessionId, laterUrl);
    const tabGone = await evalIn(
      cdp,
      control.sessionId,
      `chrome.tabs.get(${laterTab}).then(() => false).catch(() => true)`,
      1
    );
    const undo = await evalIn(cdp, control.sessionId, "chrome.storage.local.get('undo:lastClosed').then((got) => got['undo:lastClosed'])", 1);
    return found?.entry.later === true && typeof found.entry.laterAt === "number" && tabGone && undo?.urls?.[0] === laterUrl
      ? { found, undo }
      : null;
  });
  const laterRow = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Boolean(document.querySelector('[data-testid=${JSON.stringify(`row-later-${laterEntry?.entry.id}`)}]'))`,
      1
    )
  );
  check(
    "d. Later closes tab and stores undo",
    Boolean(laterButton) && Boolean(movedLater) && Boolean(laterRow),
    `closed=${Boolean(movedLater)} band=${Boolean(laterRow)} undo=${Boolean(movedLater?.undo)}`
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid=${JSON.stringify(`row-later-${laterEntry.entry.id}`)}]').click()`
  );
  const restoredLater = await waitFor(async () => {
    const found = await findEntry(cdp, control.sessionId, laterUrl);
    const tabs = await evalIn(
      cdp,
      control.sessionId,
      `chrome.tabs.query({ url: ${JSON.stringify(laterUrl)} }).then((tabs) => tabs.map((tab) => tab.id))`,
      1
    );
    return found?.entry.later === false && found.entry.laterAt === null && tabs.length ? { found, tabs } : null;
  });
  check(
    "d. Later row restores tab and clears flag",
    Boolean(restoredLater),
    `tabs=${restoredLater?.tabs?.length ?? 0} later=${restoredLater?.found?.entry.later}`
  );

  await openTab(cdp, control.sessionId, FILE_HTML);
  await openTab(cdp, control.sessionId, PDF_URL);
  await openTab(cdp, control.sessionId, WEB_URL);
  const chromeTab = await openTab(cdp, control.sessionId, "chrome://version/");
  const kinds = await waitFor(async () => {
    const [html, pdf, web] = await Promise.all([
      findEntry(cdp, control.sessionId, FILE_HTML),
      findEntry(cdp, control.sessionId, PDF_URL),
      findEntry(cdp, control.sessionId, WEB_URL)
    ]);
    return html && pdf && web ? { html: html.entry.kind, pdf: pdf.entry.kind, web: web.entry.kind } : null;
  }, 20000);
  const chromeRecorded = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get(null).then((all) => Object.values(all).some((value) => value?.url?.startsWith('chrome://version')))`
  );
  check(
    "e. target kinds and ignored scheme",
    kinds?.html === "html" && kinds.pdf === "pdf" && kinds.web === "web" && chromeRecorded === false,
    `${JSON.stringify(kinds)} chromeRecorded=${chromeRecorded}`
  );
  await evalIn(cdp, control.sessionId, `chrome.tabs.remove(${chromeTab})`);

  const legacyKey = "entry:legacy-e2e";
  const legacy = {
    id: "legacy-e2e",
    url: FILE_HTML,
    path: "C:/Users/miyaz/html-editor-extension/src/newtab/index.html",
    key: "c:/users/miyaz/html-editor-extension/src/newtab/index.html",
    title: "legacy-e2e",
    group: "legacy-e2e",
    firstSeenAt: 1,
    lastSeenAt: 2,
    visitCount: 2,
    pinned: false,
    archived: false,
    missing: null,
    missingCheckedAt: null,
    source: "import"
  };
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ meta: { schemaVersion: 1, backfillDoneAt: null }, ${JSON.stringify(legacyKey)}: ${JSON.stringify(legacy)} })`
  );
  await openHub(cdp, control, extensionId);
  const migratedOnce = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get(['meta', ${JSON.stringify(legacyKey)}]).then((got) => {
        const entry = got[${JSON.stringify(legacyKey)}];
        return got.meta?.schemaVersion === 2 && entry?.kind === 'html' && entry?.later === false && entry?.laterAt === null
          ? { meta: got.meta, entry }
          : null;
      })`,
      1
    )
  );
  check(
    "f. schema v1 migrates to v2",
    Boolean(migratedOnce),
    `schema=${migratedOnce?.meta?.schemaVersion} kind=${migratedOnce?.entry?.kind}`
  );

  const countBeforeSecondRun = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('entry:')).length)"
  );
  await openHub(cdp, control, extensionId);
  const migratedTwice = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get(['meta', ${JSON.stringify(legacyKey)}]).then((got) => ({ meta: got.meta, entry: got[${JSON.stringify(legacyKey)}] }))`,
      1
    )
  );
  const countAfterSecondRun = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('entry:')).length)"
  );
  check(
    "f. schema migration is idempotent",
    migratedTwice?.meta?.schemaVersion === 2 &&
      migratedTwice.entry?.kind === "html" &&
      migratedTwice.entry?.later === false &&
      migratedTwice.entry?.laterAt === null &&
      countAfterSecondRun === countBeforeSecondRun,
    `before=${countBeforeSecondRun} after=${countAfterSecondRun}`
  );

  console.log(JSON.stringify({ ok: results.every((result) => result.ok), extensionId, results }, null, 2));
} catch (error) {
  console.error(error);
  check("unhandled E2E error", false, String(error));
} finally {
  await stopProcessTree(chrome);
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
