// HTML Hub new-tab E2E (CDP, zero dependencies, Node 24 WebSocket).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HUB_INDEX_CACHE_KEY, HUB_INDEX_SETTINGS_KEY } from "../src/newtab/hubindex.ts";
import { S } from "../src/newtab/strings.ts";

const CHROME = "C:/Users/miyaz/tools/chrome-for-testing/chrome/win64-150.0.7871.115/chrome-win64/chrome.exe";
const DIST = "C:/Users/miyaz/html-editor-extension/dist";
const PROFILE = `C:/Users/miyaz/html-editor-extension/e2e/e2e-profile/newtab-${process.pid}-${Date.now()}`;
const PORT = 9600 + (process.pid % 300);
const CDP_COMMAND_TIMEOUT_MS = 30000;
const FILE_HTML = "file:///C:/Users/miyaz/html-editor-extension/src/newtab/index.html";
const WEB_URL = "https://example.com/";
const PDF_URL = "https://example.com/y.pdf";
const REPEAT_URL = `https://example.com/?hub-e2e=${Date.now()}`;
// Commit 7b4e5da, same 140-row fixture and performance.now() sample: 358.7, 336.0, 345.9 ms (median 345.9).
const V013_DENSE_RENDER_BASELINE_MS = 345.9;
// Parent-verified v0.14.0 (abd804b) render time under the accepted 140-row lane.
const V014_HUB_INDEX_RENDER_BASELINE_MS = 368.7;

const HUB_INDEX_SMALL_PATH = join(PROFILE, "hub-index-small", "mobile", "search.json");
const HUB_INDEX_PERF_PATH = join(PROFILE, "hub-index-perf", "mobile", "search.json");
const HUB_INDEX_MISSING_PATH = join(PROFILE, "hub-index-missing", "mobile", "search.json");
const HUB_INDEX_SMALL_URL = pathToFileURL(HUB_INDEX_SMALL_PATH).href;
const HUB_INDEX_PERF_URL = pathToFileURL(HUB_INDEX_PERF_PATH).href;
const HUB_INDEX_MISSING_URL = pathToFileURL(HUB_INDEX_MISSING_PATH).href;

function hubIndexFixtureRow({ id, title, description = "", category = "FixtureCase", tags = [], prefix = "report" }) {
  return {
    i: id,
    t: title,
    d: description,
    c: category,
    r: "knowledge",
    m: "2026-08-31T00:00:00+09:00",
    p: `docs/${prefix}__${id}.html`,
    f: false,
    g: tags,
    s: "fixture"
  };
}

const HUB_INDEX_FIXTURE_IDS = {
  description: "111111111111",
  tag: "222222222222",
  duplicate: "333333333333",
  dedupControl: "444444444444",
  unifiedA: "555555555555",
  unifiedB: "666666666666",
  otherCase: "777777777777"
};
const hubIndexSmallRows = [
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.description, title: "Description-only document", description: "The hidden descneedle appears only in this description." }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.tag, title: "Tag-only document", tags: ["tagneedle"] }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.duplicate, title: "dedupneedle duplicate", prefix: "duplicate" }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.dedupControl, title: "dedupneedle control", prefix: "control" }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.unifiedA, title: "casefilter unified one", category: "UnifiedCase" }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.unifiedB, title: "casefilter unified two", category: "UnifiedCase", tags: ["one", "two", "three", "four"] }),
  hubIndexFixtureRow({ id: HUB_INDEX_FIXTURE_IDS.otherCase, title: "casefilter other", category: "OtherCase" }),
  ...Array.from({ length: 43 }, (_, index) => {
    const id = (0x800000 + index).toString(16).padStart(12, "0");
    return hubIndexFixtureRow({ id, title: `capneedle result ${String(index).padStart(2, "0")}`, category: "CapCase", prefix: `cap-${index}` });
  })
];
const hubIndexPerfRows = Array.from({ length: 4000 }, (_, index) => {
  const id = (0x1000000 + index).toString(16).padStart(12, "0");
  return hubIndexFixtureRow({ id, title: `perfcommon ${index}`, category: `PerfCase${index % 8}`, prefix: `perf-${index}` });
});
mkdirSync(dirname(HUB_INDEX_SMALL_PATH), { recursive: true });
mkdirSync(dirname(HUB_INDEX_PERF_PATH), { recursive: true });
writeFileSync(HUB_INDEX_SMALL_PATH, JSON.stringify(hubIndexSmallRows), "utf8");
writeFileSync(HUB_INDEX_PERF_PATH, JSON.stringify(hubIndexPerfRows), "utf8");

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
      }, CDP_COMMAND_TIMEOUT_MS);
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

async function waitFor(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
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

async function openHub(cdp, control, extensionId, { initScript = "" } = {}) {
  void control;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const sessionId = await attach(cdp, targetId);
  await cdp.send("Page.enable", {}, sessionId);
  if (initScript) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript }, sessionId);
  await cdp.send("Page.navigate", { url: "chrome://newtab/" }, sessionId);
  const ready = await waitFor(() =>
    evalIn(
      cdp,
      sessionId,
      `document.title === ${JSON.stringify(S.documentTitle)} ? { title: document.title, href: location.href } : null`,
      1
    ),
    15000,
    25
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
    ),
    15000,
    25
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

function fixtureEntry({ id, url, kind = "web", service = "other", group = "fixture", title = id, at = Date.now() }) {
  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.protocol === "file:" ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
  } catch {
    // Keep the raw fixture URL as its display path.
  }
  return {
    id,
    url,
    path,
    key: url.toLowerCase(),
    title,
    group,
    firstSeenAt: at - 1000,
    lastSeenAt: at,
    visitCount: 2,
    pinned: false,
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

function entryRecord(entries) {
  return Object.fromEntries(entries.map((entry) => [`entry:${entry.id}`, entry]));
}

function stableStringify(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

async function closeHubTargets(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const closing = [];
  for (const target of targetInfos) {
    if (target.type === "page" && target.url.includes("/src/newtab/index.html")) {
      closing.push(target.targetId);
      await cdp.send("Target.closeTarget", { targetId: target.targetId });
    }
  }
  if (!closing.length) return;
  const closed = await waitFor(async () => {
    const current = await cdp.send("Target.getTargets");
    return closing.every((targetId) => !current.targetInfos.some((target) => target.targetId === targetId));
  }, 5000);
  if (!closed) throw new Error(`new-tab targets did not close: ${closing.join(",")}`);
}

async function resetHubFixture(cdp, controlSession, { clearRules = false, closeTabs = true } = {}) {
  await closeHubTargets(cdp);
  await evalIn(
    cdp,
    controlSession,
    `(async () => {
      localStorage.removeItem('tabhub:layout');
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith('entry:') || key.startsWith('excerpt:') || key === 'index:newtab' || key === 'index:panel' || key === ${JSON.stringify(HUB_INDEX_CACHE_KEY)}${clearRules ? " || key === 'serviceRules'" : ""});
      if (keys.length) await chrome.storage.local.remove(keys);
      ${closeTabs ? "const current = await chrome.tabs.getCurrent(); const tabs = await chrome.tabs.query({}); const ids = tabs.filter((tab) => tab.id !== current.id && !tab.url?.startsWith('chrome://')).map((tab) => tab.id); if (ids.length) await chrome.tabs.remove(ids);" : ""}
      return true;
    })()`
  );
}

async function setSearchQuery(cdp, sessionId, value) {
  return evalIn(
    cdp,
    sessionId,
    `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`,
    1
  );
}

function hubIndexSpyScript(urls) {
  return `(() => {
    const watched = new Set(${JSON.stringify(urls)});
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.__hubIndexFetches = [];
    globalThis.__hubIndexErrors = [];
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!watched.has(url)) return nativeFetch(input, init);
      const call = { url, at: performance.now(), settled: false };
      globalThis.__hubIndexFetches.push(call);
      return nativeFetch(input, init).then(
        (response) => { call.settled = true; return response; },
        (error) => { call.settled = true; call.error = String(error); throw error; }
      );
    };
    addEventListener('error', (event) => globalThis.__hubIndexErrors.push(String(event.error ?? event.message)));
    addEventListener('unhandledrejection', (event) => globalThis.__hubIndexErrors.push(String(event.reason)));
  })();`;
}

async function hoverEntry(cdp, sessionId, entryId) {
  const point = await waitFor(() =>
    evalIn(
      cdp,
      sessionId,
      `(() => {
        const rect = document.querySelector('[data-entry-id=${JSON.stringify(entryId)}]')?.getBoundingClientRect();
        return rect?.width > 0 && rect?.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`,
      1
    )
  );
  if (!point) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
  return true;
}

async function leaveHubRows(cdp, sessionId) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }, sessionId);
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
      await chrome.storage.local.set({
        [${JSON.stringify(HUB_INDEX_SETTINGS_KEY)}]: { sourceUrl: ${JSON.stringify(HUB_INDEX_SMALL_URL)} }
      });
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

  const htmlTab = await openTab(cdp, control.sessionId, FILE_HTML);
  const pdfTab = await openTab(cdp, control.sessionId, PDF_URL);
  const webTab = await openTab(cdp, control.sessionId, WEB_URL);
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
        return got.meta?.schemaVersion === 3 && entry?.kind === 'html' && entry?.service === 'other' && entry?.later === false && entry?.laterAt === null
          ? { meta: got.meta, entry }
          : null;
      })`,
      1
    )
  );
  check(
    "f. schema v1 migrates to v3",
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
    migratedTwice?.meta?.schemaVersion === 3 &&
      migratedTwice.entry?.kind === "html" &&
      migratedTwice.entry?.service === "other" &&
      migratedTwice.entry?.later === false &&
      migratedTwice.entry?.laterAt === null &&
      countAfterSecondRun === countBeforeSecondRun,
    `before=${countBeforeSecondRun} after=${countAfterSecondRun}`
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid="kind-tab-web"]').click()`,
    1
  );
  const webFilter = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const selected = document.querySelector('[data-testid="kind-tab-web"]')?.getAttribute('aria-selected') === 'true';
        const rows = [...document.querySelectorAll('.hub-row')];
        return selected && rows.length > 0
          ? {
              total: rows.length,
              web: rows.filter((row) => row.dataset.kind === 'web').length,
              html: rows.filter((row) => row.dataset.kind === 'html').length,
              pdf: rows.filter((row) => row.dataset.kind === 'pdf').length
            }
          : null;
      })()`,
      1
    )
  );
  check(
    "g. kind tab keeps only matching rows in DOM",
    webFilter?.total > 0 && webFilter.web === webFilter.total && webFilter.html === 0 && webFilter.pdf === 0,
    JSON.stringify(webFilter)
  );

  const openCountBeforeCollapse = await evalIn(
    cdp,
    hub.sessionId,
    `Number(document.querySelector('[data-testid="band-count-open"]')?.textContent ?? -1)`,
    1
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid="band-toggle-open"]').click()`,
    1
  );
  const collapsedBand = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const band = document.querySelector('[data-testid="band-open"]');
        const count = Number(document.querySelector('[data-testid="band-count-open"]')?.textContent ?? -1);
        return band?.dataset.collapsed === 'true' && !document.querySelector('[data-testid="band-rows-open"]')
          ? { before: ${openCountBeforeCollapse}, count, header: Boolean(document.querySelector('[data-testid="band-toggle-open"]')) }
          : null;
      })()`,
      1
    )
  );
  check(
    "h. band collapse keeps heading and count",
    collapsedBand?.header === true && collapsedBand.before >= 0 && collapsedBand.count === collapsedBand.before,
    JSON.stringify(collapsedBand)
  );

  const hubTabId = await evalIn(cdp, hub.sessionId, "chrome.tabs.getCurrent().then((tab) => tab.id)", 1);
  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid="tabstrip-collapse"]')?.click()`,
    1
  );
  const collapsedGroups = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `(async () => {
        const fixture = await Promise.all([${webTab}, ${htmlTab}, ${pdfTab}].map((id) => chrome.tabs.get(id)));
        const hubTab = await chrome.tabs.get(${hubTabId});
        if (fixture.some((tab) => tab.groupId < 0)) return null;
        const groups = await Promise.all(fixture.map((tab) => chrome.tabGroups.get(tab.groupId)));
        return groups.every((group) => group.collapsed)
          ? {
              hubGroupId: hubTab.groupId,
              groups: groups.map((group) => ({ title: group.title, color: group.color, collapsed: group.collapsed }))
            }
          : null;
      })()`,
      1
    )
  );
  const expectedGroups = [
    { title: "Web", color: "blue" },
    { title: "HTML", color: "green" },
    { title: "PDF", color: "red" }
  ];
  check(
    "i. collapse groups tabs by kind and excludes hub",
    collapsedGroups?.hubGroupId < 0 &&
      expectedGroups.every((expected, index) =>
        collapsedGroups.groups[index]?.title === expected.title &&
        collapsedGroups.groups[index]?.color === expected.color &&
        collapsedGroups.groups[index]?.collapsed === true
      ),
    JSON.stringify(collapsedGroups)
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid="tabstrip-expand"]')?.click()`,
    1
  );
  const expandedGroups = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `(async () => {
        const fixture = await Promise.all([${webTab}, ${htmlTab}, ${pdfTab}].map((id) => chrome.tabs.get(id)));
        if (fixture.some((tab) => tab.groupId < 0)) return null;
        const groups = await Promise.all(fixture.map((tab) => chrome.tabGroups.get(tab.groupId)));
        return groups.every((group) => !group.collapsed)
          ? groups.map((group) => ({ title: group.title, collapsed: group.collapsed }))
          : null;
      })()`,
      1
    )
  );
  check(
    "j. expand reopens kind groups",
    expandedGroups?.length === 3 && expandedGroups.every((group) => group.collapsed === false),
    JSON.stringify(expandedGroups)
  );

  const layoutStored = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const value = JSON.parse(localStorage.getItem('tabhub:layout') ?? 'null');
        return value?.kind === 'web' && value?.collapsedBands?.includes('open') ? value : null;
      })()`,
      1
    )
  );
  await cdp.send("Target.closeTarget", { targetId: hub.targetId });
  hub = await openHub(cdp, control, extensionId);
  const restoredLayout = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const selected = document.querySelector('[data-testid="kind-tab-web"]')?.getAttribute('aria-selected') === 'true';
        const band = document.querySelector('[data-testid="band-open"]');
        const count = Number(document.querySelector('[data-testid="band-count-open"]')?.textContent ?? -1);
        return selected && band?.dataset.collapsed === 'true' && !document.querySelector('[data-testid="band-rows-open"]')
          ? { selected, collapsed: true, count }
          : null;
      })()`,
      1
    )
  );
  check(
    "k. kind and band layout persist across reopen",
    Boolean(layoutStored) && restoredLayout?.selected === true && restoredLayout.collapsed === true && restoredLayout.count >= 0,
    `stored=${JSON.stringify(layoutStored)} restored=${JSON.stringify(restoredLayout)}`
  );

  await cdp.send("Target.closeTarget", { targetId: hub.targetId });
  const bookmarkUrl = `https://example.com/?hub-bookmark=${Date.now()}`;
  const directBookmarkUrl = `https://example.com/?hub-direct-bookmark=${Date.now()}`;
  const bookmarkFixture = await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      const [root] = await chrome.bookmarks.getTree();
      const bar = root.children?.find((node) => node.id === '1') ?? root.children?.find((node) => !node.url);
      if (!bar) throw new Error('bookmark bar not found');
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Hub E2E Folder' });
      const link = await chrome.bookmarks.create({ parentId: folder.id, title: 'Hub Bookmark Search Result', url: ${JSON.stringify(bookmarkUrl)} });
      const direct = await chrome.bookmarks.create({ parentId: bar.id, title: 'Hub Direct Bookmark', url: ${JSON.stringify(directBookmarkUrl)} });
      return { folderId: folder.id, linkId: link.id, directId: direct.id };
    })()`
  );
  await sleep(800);
  const entryCountBeforeBookmarks = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('entry:')).length)"
  );

  hub = await openHub(cdp, control, extensionId);
  const bookmarkStripState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const strip = document.querySelector('[data-testid="bookmark-strip"]');
        const folder = document.querySelector('[data-testid=${JSON.stringify(`bookmark-folder-${bookmarkFixture.folderId}`)}]');
        const direct = document.querySelector('[data-testid=${JSON.stringify(`bookmark-direct-${bookmarkFixture.directId}`)}]');
        return strip && folder && direct ? { folder: folder.textContent.trim(), direct: direct.textContent.trim() } : null;
      })()`,
      1
    )
  );
  await sleep(500);
  const entryCountAfterStrip = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('entry:')).length)"
  );
  check(
    "l. bookmark create renders strip chips",
    bookmarkStripState?.folder.includes("Hub E2E Folder") && bookmarkStripState?.direct.includes("Hub Direct Bookmark"),
    JSON.stringify(bookmarkStripState)
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid=${JSON.stringify(`bookmark-folder-${bookmarkFixture.folderId}`)}]').click()`,
    1
  );
  const bookmarkDropdown = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const menu = document.querySelector('[data-testid="bookmark-dropdown"]');
        const link = document.querySelector('[data-testid=${JSON.stringify(`bookmark-item-link-${bookmarkFixture.linkId}`)}]');
        return menu && link ? { title: link.textContent.trim() } : null;
      })()`,
      1
    )
  );
  await sleep(500);
  const entryCountAfterFolder = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith('entry:')).length)"
  );
  await evalIn(
    cdp,
    hub.sessionId,
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    1
  );
  const dropdownClosed = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "!document.querySelector('[data-testid=\"bookmark-dropdown\"]')", 1)
  );
  check(
    "m. folder dropdown renders link and Escape closes",
    bookmarkDropdown?.title === "Hub Bookmark Search Result" && Boolean(dropdownClosed),
    `link=${bookmarkDropdown?.title} closed=${Boolean(dropdownClosed)}`
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid=${JSON.stringify(`bookmark-folder-${bookmarkFixture.folderId}`)}]').click()`,
    1
  );
  await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Boolean(document.querySelector('[data-testid=${JSON.stringify(`bookmark-item-link-${bookmarkFixture.linkId}`)}]'))`,
      1
    )
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid=${JSON.stringify(`bookmark-item-link-${bookmarkFixture.linkId}`)}]').click()`,
    1
  );
  const openedBookmarkTabs = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.tabs.query({ url: ${JSON.stringify(bookmarkUrl)} }).then((tabs) => tabs.length ? tabs.map((tab) => tab.id) : null)`,
      1
    )
  );
  check(
    "n. bookmark dropdown link opens a new tab",
    openedBookmarkTabs?.length > 0,
    `tabs=${openedBookmarkTabs?.length ?? 0} url=${bookmarkUrl}`
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Hub Bookmark Search Result');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
    1
  );
  const bookmarkSearchBand = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const band = document.querySelector('[data-testid="band-bookmarks"]');
        const row = document.querySelector('[data-testid=${JSON.stringify(`bookmark-search-${bookmarkFixture.linkId}`)}]');
        const recent = document.querySelector('[data-testid="band-recent"]');
        const later = document.querySelector('[data-testid="band-later"]');
        return band && row && recent && later
          ? {
              count: Number(document.querySelector('[data-testid="band-count-bookmarks"]')?.textContent),
              afterRecent: Boolean(recent.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING),
              beforeLater: Boolean(band.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING),
              actions: row.querySelectorAll('.row-actions').length,
              heading: document.querySelector('[data-testid="band-toggle-bookmarks"]')?.textContent.trim(),
              mark: row.querySelector('.bookmark-result-mark')?.textContent
            }
          : null;
      })()`,
      1
    )
  );
  await evalIn(
    cdp,
    hub.sessionId,
    "document.querySelector('[data-testid=\"band-toggle-bookmarks\"]')?.click()",
    1
  );
  const bookmarkBandCollapsed = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `document.querySelector('[data-testid="band-bookmarks"]')?.dataset.collapsed === 'true' && !document.querySelector('[data-testid="band-rows-bookmarks"]')`,
      1
    )
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
    1
  );
  const bookmarkBandAbsent = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "!document.querySelector('[data-testid=\"band-bookmarks\"]')", 1)
  );
  check(
    "o. search shows an independent collapsible bookmark band",
    bookmarkSearchBand?.count === 1 &&
      bookmarkSearchBand.afterRecent === true &&
      bookmarkSearchBand.beforeLater === true &&
      bookmarkSearchBand.actions === 0 &&
      bookmarkSearchBand.heading.includes("⭐") &&
      bookmarkSearchBand.heading.includes(S.bookmarks.band) &&
      bookmarkSearchBand.mark === "⭐" &&
      Boolean(bookmarkBandCollapsed) &&
      Boolean(bookmarkBandAbsent),
    `state=${JSON.stringify(bookmarkSearchBand)} collapsed=${Boolean(bookmarkBandCollapsed)} absent=${Boolean(bookmarkBandAbsent)}`
  );
  check(
    "p. bookmark reads do not mutate ledger entries",
    entryCountAfterStrip === entryCountBeforeBookmarks && entryCountAfterFolder === entryCountBeforeBookmarks,
    `before=${entryCountBeforeBookmarks} strip=${entryCountAfterStrip} folder=${entryCountAfterFolder}`
  );

  await resetHubFixture(cdp, control.sessionId);
  const classificationCases = [
    ["r-sheet", "https://docs.google.com/spreadsheets/d/x", "web", "sheet"],
    ["r-doc", "https://docs.google.com/document/d/x", "web", "doc"],
    ["r-drive", "https://drive.google.com/drive/folders/x", "web", "drive"],
    ["r-ai", "https://claude.ai/chat", "web", "ai"],
    ["r-dev", "https://github.com/a/b", "web", "dev"],
    ["r-not-dev", "https://notgithub.com/", "web", "other"],
    ["r-gov", "https://www.mext.go.jp/a", "web", "gov"],
    ["u-html", FILE_HTML, "html", "other"],
    ["u-pdf", PDF_URL, "pdf", "other"]
  ];
  const migrationEntries = classificationCases.map(([id, url, kind]) => {
    const entry = fixtureEntry({ id, url, kind });
    delete entry.service;
    return entry;
  });
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ meta: { schemaVersion: 2, backfillDoneAt: null }, ...${JSON.stringify(entryRecord(migrationEntries))} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const migratedV3 = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get(null).then((all) => {
        const entries = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('entry:')).map(([, entry]) => [entry.id, entry]));
        const index = all['index:newtab'] ?? [];
        return all.meta?.schemaVersion === 3 && ${JSON.stringify(classificationCases.map(([id]) => id))}.every((id) => entries[id]?.service)
          ? { meta: all.meta, entries, index }
          : null;
      })`,
      1
    )
  );
  const classificationActual = classificationCases.map(([id]) => migratedV3?.entries?.[id]?.service);
  const classificationExpected = classificationCases.map(([, , , expected]) => expected);
  check(
    "r. service classification uses exact host boundaries",
    JSON.stringify(classificationActual) === JSON.stringify(classificationExpected),
    `actual=${JSON.stringify(classificationActual)}`
  );
  check(
    "u. schema v2 migrates every entry and index to v3",
    migratedV3?.meta?.schemaVersion === 3 &&
      classificationCases.every(([id, , , expected]) => migratedV3.entries[id]?.service === expected) &&
      migratedV3.index.every((entry) => typeof entry.service === "string"),
    `schema=${migratedV3?.meta?.schemaVersion} entries=${Object.keys(migratedV3?.entries ?? {}).length} index=${migratedV3?.index?.length}`
  );
  const migrationSnapshot = JSON.stringify(migratedV3?.entries);
  await closeHubTargets(cdp);
  hub = await openHub(cdp, control, extensionId);
  const migratedAgain = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get(null).then((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('entry:')).map(([, entry]) => [entry.id, entry])))`
  );
  check(
    "u. schema v3 migration is idempotent",
    JSON.stringify(migratedAgain) === migrationSnapshot,
    `before=${Object.keys(migratedV3?.entries ?? {}).length} after=${Object.keys(migratedAgain ?? {}).length}`
  );

  await resetHubFixture(cdp, control.sessionId, { clearRules: true });
  await evalIn(cdp, control.sessionId, "chrome.storage.local.set({ meta: { schemaVersion: 3, backfillDoneAt: null } })");
  hub = await openHub(cdp, control, extensionId);
  const seededRules = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      "chrome.storage.local.get('serviceRules').then((got) => got.serviceRules?.rules?.length ? got.serviceRules : null)",
      1
    )
  );
  const customizedRules = structuredClone(seededRules);
  customizedRules.version = 987;
  const otherIndex = customizedRules.rules.findIndex((rule) => rule.id === "other");
  customizedRules.rules.splice(otherIndex < 0 ? customizedRules.rules.length : otherIndex, 0, {
    id: "custom-e2e",
    label: "Custom E2E",
    match: { host: ["custom-e2e.test"] },
    color: "--svc-ai",
    origin: "user",
    hits: 0
  });
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ serviceRules: ${JSON.stringify(customizedRules)} })`
  );
  await closeHubTargets(cdp);
  hub = await openHub(cdp, control, extensionId);
  const preservedRules = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get('serviceRules').then((got) => got.serviceRules)"
  );
  check(
    "u2. existing service rules are never overwritten by the seed",
    stableStringify(preservedRules) === stableStringify(customizedRules),
    `version=${preservedRules?.version} rules=${preservedRules?.rules?.length}`
  );

  await resetHubFixture(cdp, control.sessionId, { closeTabs: true });
  const promotionHost = "example-newsite.test";
  const promotionEntries = Array.from({ length: 5 }, (_, index) =>
    fixtureEntry({
      id: `u3-${index + 1}`,
      url: `https://${promotionHost}/item-${index + 1}`,
      service: "other",
      title: `promotion-${index + 1}`
    })
  );
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(promotionEntries.slice(0, 4)))}, 'index:newtab': ${JSON.stringify(promotionEntries.slice(0, 4))} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const rulesAtFour = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get('serviceRules').then((got) => got.serviceRules.rules.filter((rule) => rule.origin === 'auto' && rule.match?.host?.includes(${JSON.stringify(promotionHost)})))`
  );
  check("u3. four unmatched entries do not auto-promote", rulesAtFour.length === 0, `auto=${rulesAtFour.length}`);

  await closeHubTargets(cdp);
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord([promotionEntries[4]]))}, 'index:newtab': ${JSON.stringify(promotionEntries)} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const promotedAtFive = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(async () => {
        const got = await chrome.storage.local.get('serviceRules');
        const rules = got.serviceRules.rules.filter((rule) => rule.origin === 'auto' && rule.match?.host?.includes(${JSON.stringify(promotionHost)}));
        if (rules.length !== 1) return null;
        const chip = [...document.querySelectorAll('[data-service-id]')].find((item) => item.dataset.serviceId === rules[0].id);
        return chip ? { rules, chipCount: Number(chip.dataset.count) } : null;
      })()`,
      1
    )
  );
  const promotionDiagnostic = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get(null).then((all) => ({ entries: Object.values(all).filter((value) => value?.url?.startsWith('https://${promotionHost}/')).map((entry) => ({ id: entry.id, url: entry.url, kind: entry.kind, service: entry.service })), auto: all.serviceRules.rules.filter((rule) => rule.origin === 'auto') }))`
  );
  check(
    "u3. fifth unmatched entry auto-promotes to an independent chip",
    promotedAtFive?.rules?.length === 1 && promotedAtFive.chipCount === 5,
    `auto=${promotedAtFive?.rules?.length ?? 0} chip=${promotedAtFive?.chipCount} stored=${promotionDiagnostic?.entries?.length}`
  );

  await resetHubFixture(cdp, control.sessionId);
  const serviceEntries = [
    ...Array.from({ length: 5 }, (_, index) => fixtureEntry({
      id: `s-dev-${index}`,
      url: `https://github.com/e2e/dev-${index}`,
      service: "dev",
      title: index < 3 ? `service-e2e-hit dev ${index}` : `dev ${index}`
    })),
    ...Array.from({ length: 3 }, (_, index) => fixtureEntry({
      id: `s-ai-${index}`,
      url: `https://claude.ai/chat/${index}`,
      service: "ai",
      title: index < 2 ? `service-e2e-hit ai ${index}` : `ai ${index}`
    })),
    ...Array.from({ length: 2 }, (_, index) => fixtureEntry({
      id: `s-sheet-${index}`,
      url: `https://docs.google.com/spreadsheets/d/e2e-${index}`,
      service: "sheet",
      title: index < 1 ? `service-e2e-hit sheet ${index}` : `sheet ${index}`
    }))
  ];
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(serviceEntries))}, 'index:newtab': ${JSON.stringify(serviceEntries)} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const initialChipOrder = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const chips = [...document.querySelectorAll('[data-testid="service-chips"] .service-chip')].map((chip) => [chip.dataset.serviceId, Number(chip.dataset.count)]);
        return chips.length === 3 ? chips : null;
      })()`,
      1
    )
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const input = document.querySelector('[data-testid="hub-search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'service-e2e-hit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  const searchedChipOrder = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const chips = [...document.querySelectorAll('[data-testid="service-chips"] .service-chip')].map((chip) => [chip.dataset.serviceId, Number(chip.dataset.count)]);
        return JSON.stringify(chips) === JSON.stringify([['dev',3],['ai',2],['sheet',1]]) ? chips : null;
      })()`,
      1
    )
  );
  await evalIn(cdp, hub.sessionId, "document.querySelector('[data-testid=\"service-chip-dev\"]').click()", 1);
  const devFiltered = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const rows = [...document.querySelectorAll('[data-entry-id]')];
        return rows.length === 3 && rows.every((row) => row.dataset.kind === 'web' && row.dataset.serviceId === 'dev') ? rows.length : null;
      })()`,
      1
    )
  );
  await evalIn(cdp, hub.sessionId, "document.querySelector('[data-testid=\"service-chip-ai\"]').click()", 1);
  const orFiltered = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "document.querySelectorAll('[data-entry-id]').length === 5 ? 5 : null", 1)
  );
  check(
    "s. service chips sort, recount, AND-filter, and OR within the service axis",
    JSON.stringify(initialChipOrder) === JSON.stringify([["dev", 5], ["ai", 3], ["sheet", 2]]) &&
      JSON.stringify(searchedChipOrder) === JSON.stringify([["dev", 3], ["ai", 2], ["sheet", 1]]) &&
      devFiltered === 3 && orFiltered === 5,
    `initial=${JSON.stringify(initialChipOrder)} search=${JSON.stringify(searchedChipOrder)} dev=${devFiltered} or=${orFiltered}`
  );

  await evalIn(cdp, hub.sessionId, "document.querySelector('[data-testid=\"kind-tab-html\"]').click()", 1);
  const serviceStripGone = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "!document.querySelector('[data-testid=\"service-chips\"]')", 1)
  );
  check("t. html-only kind filter removes the service chip row from DOM", Boolean(serviceStripGone));

  await resetHubFixture(cdp, control.sessionId);
  const distinctDevHosts = [
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "developer.chrome.com"
  ];
  const devServiceGroupEntries = distinctDevHosts.map((host, index) => fixtureEntry({
    id: `x-dev-service-${index}`,
    url: `https://${host}/e2e/service-group-${index}`,
    service: "dev",
    title: `dev service group ${index}`
  }));
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(devServiceGroupEntries))}, 'index:newtab': ${JSON.stringify(devServiceGroupEntries)} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const devServiceGroupReady = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Number(document.querySelector('[data-testid="band-count-recent"]')?.textContent) === ${devServiceGroupEntries.length}`,
      1
    )
  );
  const devServiceGroupState = await evalIn(
    cdp,
    hub.sessionId,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const fixtureIds = new Set(${JSON.stringify(devServiceGroupEntries.map((entry) => entry.id))});
      const groups = [...document.querySelectorAll('[data-testid="band-recent"] .hub-group')].map((group) => ({
        name: group.querySelector('.group-title')?.textContent?.trim(),
        count: Number(group.querySelector('.group-count')?.textContent),
        ids: [...group.querySelectorAll('[data-entry-id]')].map((row) => row.dataset.entryId).filter((id) => fixtureIds.has(id))
      })).filter((group) => group.ids.length > 0);
      resolve({
        recentCount: Number(document.querySelector('[data-testid="band-count-recent"]')?.textContent ?? -1),
        layout: JSON.parse(localStorage.getItem('tabhub:layout') ?? 'null'),
        groups
      });
    })))`,
    1
  );
  check(
    "x0. five singleton dev hosts stay in one service group",
    Boolean(devServiceGroupReady) &&
      devServiceGroupState?.groups.length === 1 &&
      devServiceGroupState.groups[0].name === S.service.dev &&
      devServiceGroupState.groups[0].count === 5 &&
      devServiceGroupState.groups[0].ids.length === 5 &&
      devServiceGroupState.groups[0].name !== S.group.misc,
    JSON.stringify(devServiceGroupState)
  );

  await resetHubFixture(cdp, control.sessionId);
  const splitDevHost = "github.com";
  const devHostSplitEntries = [
    ...Array.from({ length: 4 }, (_, index) => fixtureEntry({
      id: `y-dev-host-${index}`,
      url: `https://${splitDevHost}/e2e/host-group-${index}`,
      service: "dev",
      title: `dev host group ${index}`
    })),
    fixtureEntry({
      id: "y-dev-service-gitlab",
      url: "https://gitlab.com/e2e/service-remainder",
      service: "dev",
      title: "dev service remainder gitlab"
    }),
    fixtureEntry({
      id: "y-dev-service-stackoverflow",
      url: "https://stackoverflow.com/questions/e2e-service-remainder",
      service: "dev",
      title: "dev service remainder stackoverflow"
    })
  ];
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(devHostSplitEntries))}, 'index:newtab': ${JSON.stringify(devHostSplitEntries)} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const devHostSplitReady = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `Number(document.querySelector('[data-testid="band-count-recent"]')?.textContent) === ${devHostSplitEntries.length}`,
      1
    )
  );
  const devHostSplitState = await evalIn(
    cdp,
    hub.sessionId,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const fixtureIds = new Set(${JSON.stringify(devHostSplitEntries.map((entry) => entry.id))});
      const groups = [...document.querySelectorAll('[data-testid="band-recent"] .hub-group')].map((group) => ({
        name: group.querySelector('.group-title')?.textContent?.trim(),
        count: Number(group.querySelector('.group-count')?.textContent),
        ids: [...group.querySelectorAll('[data-entry-id]')].map((row) => row.dataset.entryId).filter((id) => fixtureIds.has(id))
      })).filter((group) => group.ids.length > 0);
      resolve({
        recentCount: Number(document.querySelector('[data-testid="band-count-recent"]')?.textContent ?? -1),
        layout: JSON.parse(localStorage.getItem('tabhub:layout') ?? 'null'),
        groups
      });
    })))`,
    1
  );
  const splitHostGroup = devHostSplitState?.groups.find((group) => group.name === splitDevHost);
  const devRemainderGroup = devHostSplitState?.groups.find((group) => group.name === S.service.dev);
  const splitHostIds = devHostSplitEntries.slice(0, 4).map((entry) => entry.id).sort();
  const devRemainderIds = devHostSplitEntries.slice(4).map((entry) => entry.id).sort();
  check(
    "y0. frequent dev host splits from the service remainder",
    Boolean(devHostSplitReady) &&
      devHostSplitState?.groups.length === 2 &&
      splitHostGroup?.count === 4 &&
      JSON.stringify(splitHostGroup.ids.sort()) === JSON.stringify(splitHostIds) &&
      devRemainderGroup?.count === 2 &&
      JSON.stringify(devRemainderGroup.ids.sort()) === JSON.stringify(devRemainderIds) &&
      !devHostSplitState.groups.some((group) => group.name === S.group.misc),
    JSON.stringify(devHostSplitState)
  );

  await resetHubFixture(cdp, control.sessionId);
  const previewUrls = {
    callout: "file:///C:/e2e/preview/callout.html",
    paragraph: "file:///C:/e2e/preview/paragraph.html",
    timeout: "file:///C:/e2e/preview/timeout.html",
    guardedWeb: "https://example.com/e2e/inconsistent-kind.html",
    web: "https://example.com/e2e/preview-web",
    pdf: "https://drive.google.com/e2e/preview-document.pdf"
  };
  const calloutText = "The decisive conclusion belongs in the first readable callout.";
  const paragraphText = "This paragraph is deliberately longer than eighty characters so the preview parser selects the first substantial paragraph immediately following the heading.";
  const previewHtml = {
    [previewUrls.callout]: `<!doctype html><title>Callout fallback title</title><nav><div class="callout">Hidden navigation callout</div></nav><div class="callout">${calloutText}</div><h2>One</h2><h2>Two</h2><table><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table><span class="chip ok">A</span><span class="chip ok">B</span><span class="chip warn">C</span><span class="chip ng">D</span><svg></svg>`,
    [previewUrls.paragraph]: `<!doctype html><title>Paragraph fallback title</title><h2>Summary</h2><p>${paragraphText}</p>`
  };
  const previewEntries = [
    fixtureEntry({ id: "preview-callout", url: previewUrls.callout, kind: "html", group: "preview-case", title: "A complete preview title that is intentionally longer than the dense row can display" }),
    fixtureEntry({ id: "preview-paragraph", url: previewUrls.paragraph, kind: "html", group: "preview-case", title: "Paragraph preview" }),
    fixtureEntry({ id: "preview-timeout", url: previewUrls.timeout, kind: "html", group: "preview-case", title: "Timeout preview" }),
    fixtureEntry({ id: "preview-guarded-web", url: previewUrls.guardedWeb, kind: "html", group: "preview-case", title: "Guarded inconsistent preview" }),
    fixtureEntry({ id: "preview-web", url: previewUrls.web, kind: "web", service: "other", title: "Web preview" }),
    fixtureEntry({ id: "preview-pdf", url: previewUrls.pdf, kind: "pdf", group: "preview-case", title: "PDF preview" })
  ];
  previewEntries[0].visitCount = 7;
  previewEntries[0].pinned = true;
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(previewEntries))}, 'index:newtab': ${JSON.stringify(previewEntries)} })`
  );
  const previewInitScript = `(() => {
    const fixtures = ${JSON.stringify(previewHtml)};
    const timeoutUrl = ${JSON.stringify(previewUrls.timeout)};
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.__previewFetchState = { calls: [] };
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const call = { url, hasSignal: Boolean(init.signal), at: performance.now() };
      globalThis.__previewFetchState.calls.push(call);
      if (url === timeoutUrl) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            call.abortedAt = performance.now();
            reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (Object.hasOwn(fixtures, url)) return Promise.resolve(new Response(fixtures[url], { status: 200 }));
      return nativeFetch(input, init);
    };
  })();`;
  hub = await openHub(cdp, control, extensionId, { initScript: previewInitScript });
  await sleep(250);
  const initialPreviewFetches = await evalIn(cdp, hub.sessionId, "globalThis.__previewFetchState.calls.length", 1);
  check("x. initial render performs zero fetches", initialPreviewFetches === 0, `fetches=${initialPreviewFetches}`);

  const quickHoverReady = await hoverEntry(cdp, hub.sessionId, "preview-callout");
  await sleep(100);
  await leaveHubRows(cdp, hub.sessionId);
  const quickHoverState = await evalIn(
    cdp,
    hub.sessionId,
    "({ card: Boolean(document.querySelector('[data-testid=\"preview-card\"]')), fetches: globalThis.__previewFetchState.calls.length })",
    1
  );
  await hoverEntry(cdp, hub.sessionId, "preview-callout");
  await sleep(225);
  const sustainedHoverState = await evalIn(
    cdp,
    hub.sessionId,
    "({ card: Boolean(document.querySelector('[data-testid=\"preview-card\"]')), fetches: globalThis.__previewFetchState.calls.length })",
    1
  );
  check(
    "y. 100ms hover does not fire and 200ms hover shows the card",
    quickHoverReady && !quickHoverState.card && quickHoverState.fetches === 0 && sustainedHoverState.card && sustainedHoverState.fetches === 1,
    `quick=${JSON.stringify(quickHoverState)} sustained=${JSON.stringify(sustainedHoverState)}`
  );

  const calloutPreviewState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const excerpt = document.querySelector('[data-testid="preview-excerpt"]')?.textContent;
        const shape = document.querySelector('[data-testid="preview-shape"]')?.textContent;
        const title = document.querySelector('[data-testid="preview-title"]')?.textContent;
        const activity = document.querySelector('[data-testid="preview-activity"]')?.textContent;
        return excerpt ? { excerpt, shape, title, activity } : null;
      })()`,
      1
    )
  );
  check(
    "z. first readable callout becomes the excerpt",
    calloutPreviewState?.excerpt === calloutText &&
      calloutPreviewState.title === previewEntries[0].title &&
      calloutPreviewState.activity?.includes(S.preview.visits(7)) &&
      calloutPreviewState.activity?.includes(S.preview.pinned),
    JSON.stringify(calloutPreviewState)
  );
  const expectedShape = [
    S.preview.shapeHeadings(2),
    S.preview.shapeTables(1, 3),
    S.preview.shapeChips(2, 1, 1),
    S.preview.shapeFigures(1)
  ].join(" · ");
  check("ab. structure summary reports headings, table rows, chips, and figures", calloutPreviewState?.shape === expectedShape, calloutPreviewState?.shape ?? "missing");

  const cachedCallout = await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.get('excerpt:preview-callout').then((got) => got['excerpt:preview-callout'])`,
    1
  );
  await leaveHubRows(cdp, hub.sessionId);
  const hiddenAfterLeave = await evalIn(cdp, hub.sessionId, "!document.querySelector('[data-testid=\"preview-card\"]')", 1);
  await hoverEntry(cdp, hub.sessionId, "preview-callout");
  const cachedHoverState = await waitFor(() => evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-testid="preview-excerpt"]')?.textContent === ${JSON.stringify(calloutText)}
      ? ({ fetches: globalThis.__previewFetchState.calls.length, excerpt: document.querySelector('[data-testid="preview-excerpt"]')?.textContent })
      : null`,
    1
  )) ?? await evalIn(
    cdp,
    hub.sessionId,
    "({ fetches: globalThis.__previewFetchState.calls.length, excerpt: document.querySelector('[data-testid=\"preview-excerpt\"]')?.textContent })",
    1
  );
  check(
    "ac. second hover reads excerpt storage cache without refetching",
    hiddenAfterLeave && cachedCallout?.excerpt === calloutText && cachedHoverState.fetches === 1 && cachedHoverState.excerpt === calloutText,
    `hidden=${hiddenAfterLeave} cache=${Boolean(cachedCallout)} state=${JSON.stringify(cachedHoverState)}`
  );

  await leaveHubRows(cdp, hub.sessionId);
  await hoverEntry(cdp, hub.sessionId, "preview-paragraph");
  await sleep(225);
  const paragraphExcerpt = await waitFor(() =>
    evalIn(cdp, hub.sessionId, `document.querySelector('[data-testid="preview-excerpt"]')?.textContent === ${JSON.stringify(paragraphText)} ? ${JSON.stringify(paragraphText)} : null`, 1)
  );
  check("aa. long paragraph after the first heading becomes the excerpt", paragraphExcerpt === paragraphText, paragraphExcerpt ?? "missing");

  await leaveHubRows(cdp, hub.sessionId);
  const focusPreviewState = await evalIn(
    cdp,
    hub.sessionId,
    `new Promise((resolve) => {
      const row = document.querySelector('[data-entry-id="preview-paragraph"]');
      row?.focus();
      requestAnimationFrame(() => {
        const focused = document.activeElement === row;
        const id = document.querySelector('[data-testid="preview-card"]')?.dataset.previewEntryId;
        row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        requestAnimationFrame(() => resolve({ focused, id, arrowId: document.activeElement?.dataset.entryId, arrowPreviewId: document.querySelector('[data-testid="preview-card"]')?.dataset.previewEntryId }));
      });
    })`,
    1
  );
  check(
    "y2. keyboard focus and arrow movement show the same preview card immediately",
    focusPreviewState?.focused && focusPreviewState.id === "preview-paragraph" && focusPreviewState.arrowId === "preview-callout" && focusPreviewState.arrowPreviewId === "preview-callout",
    JSON.stringify(focusPreviewState)
  );
  await evalIn(cdp, hub.sessionId, "document.querySelector('[data-testid=\"hub-search\"]')?.focus()", 1);

  await leaveHubRows(cdp, hub.sessionId);
  await hoverEntry(cdp, hub.sessionId, "preview-guarded-web");
  await sleep(225);
  const guardedWebState = await evalIn(
    cdp,
    hub.sessionId,
    "({ id: document.querySelector('[data-testid=\"preview-card\"]')?.dataset.previewEntryId, excerpt: Boolean(document.querySelector('[data-testid=\"preview-excerpt\"]')), fetches: globalThis.__previewFetchState.calls.length })",
    1
  );
  check(
    "ad0. preview fetch boundary rejects a non-file URL even with inconsistent html kind",
    guardedWebState.id === "preview-guarded-web" && !guardedWebState.excerpt && guardedWebState.fetches === 2,
    JSON.stringify(guardedWebState)
  );

  await leaveHubRows(cdp, hub.sessionId);
  const nonHtmlStates = [];
  for (const entryId of ["preview-web", "preview-pdf"]) {
    await hoverEntry(cdp, hub.sessionId, entryId);
    await sleep(225);
    nonHtmlStates.push(await evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const card = document.querySelector('[data-testid="preview-card"]');
        return { id: card?.dataset.previewEntryId, source: card?.querySelector('[data-testid="preview-source"]')?.textContent, excerpt: Boolean(card?.querySelector('[data-testid="preview-excerpt"]')), shape: Boolean(card?.querySelector('[data-testid="preview-shape"]')), fetches: globalThis.__previewFetchState.calls.length };
      })()`,
      1
    ));
    await leaveHubRows(cdp, hub.sessionId);
  }
  check(
    "ad. web and PDF cards contain no excerpt or structure blocks",
    nonHtmlStates[0]?.id === "preview-web" &&
      nonHtmlStates[0].source?.includes("example.com") &&
      nonHtmlStates[1]?.id === "preview-pdf" &&
      nonHtmlStates[1].source?.includes(S.service.drive) &&
      nonHtmlStates[1].source?.includes("drive.google.com") &&
      nonHtmlStates.every((state) => !state.excerpt && !state.shape && state.fetches === 2),
    JSON.stringify(nonHtmlStates)
  );

  await hoverEntry(cdp, hub.sessionId, "preview-timeout");
  await sleep(225);
  const timeoutStartedState = await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const call = globalThis.__previewFetchState.calls.find((item) => item.url === ${JSON.stringify(previewUrls.timeout)});
      return { card: Boolean(document.querySelector('[data-testid="preview-card"]')), hasSignal: call?.hasSignal, startedAt: call?.at };
    })()`,
    1
  );
  await sleep(1550);
  const observedAbortElapsed = await waitFor(
    () => evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const call = globalThis.__previewFetchState.calls.find((item) => item.url === ${JSON.stringify(previewUrls.timeout)});
        return call?.abortedAt ? call.abortedAt - call.at : null;
      })()`,
      1
    ),
    3000
  );
  const timeoutState = await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const card = document.querySelector('[data-testid="preview-card"]');
      return {
        id: card?.dataset.previewEntryId,
        excerpt: Boolean(card?.querySelector('[data-testid="preview-excerpt"]')),
        shape: Boolean(card?.querySelector('[data-testid="preview-shape"]')),
        elapsed: performance.now() - ${Number(timeoutStartedState?.startedAt ?? 0)},
        abortElapsed: ${Number(observedAbortElapsed ?? 0)}
      };
    })()`,
    1
  );
  check(
    "ae. 1500ms timeout leaves a responsive metadata-only card",
    timeoutStartedState?.card &&
      timeoutStartedState.hasSignal &&
      timeoutState?.id === "preview-timeout" &&
      !timeoutState.excerpt &&
      !timeoutState.shape &&
      timeoutState.elapsed >= 1500 &&
      timeoutState.abortElapsed >= 1450 &&
      timeoutState.abortElapsed <= 1650,
    `started=${JSON.stringify(timeoutStartedState)} final=${JSON.stringify(timeoutState)}`
  );

  await resetHubFixture(cdp, control.sessionId);
  const hubSmallRoot = dirname(dirname(HUB_INDEX_SMALL_PATH));
  const duplicateRow = hubIndexSmallRows.find((row) => row.i === HUB_INDEX_FIXTURE_IDS.duplicate);
  const duplicateUrl = pathToFileURL(join(hubSmallRoot, duplicateRow.p)).href;
  const hubLedgerEntries = [
    fixtureEntry({ id: "hub-ledger-duplicate", url: duplicateUrl, kind: "html", group: "DuplicateCase", title: "dedupneedle ledger copy" }),
    fixtureEntry({ id: "hub-ledger-category", url: "file:///C:/e2e/hub-index/casefilter-ledger.html", kind: "html", group: "UnifiedCase", title: "casefilter ledger document" }),
    fixtureEntry({ id: "hub-ledger-normal", url: "file:///C:/e2e/hub-index/ledger-normal.html", kind: "html", group: "LedgerCase", title: "ledgerneedle normal document" })
  ];
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({
      ...${JSON.stringify(entryRecord(hubLedgerEntries))},
      'index:newtab': ${JSON.stringify(hubLedgerEntries)},
      [${JSON.stringify(HUB_INDEX_SETTINGS_KEY)}]: { sourceUrl: ${JSON.stringify(HUB_INDEX_SMALL_URL)} }
    })`
  );
  const hubIndexSpy = hubIndexSpyScript([HUB_INDEX_SMALL_URL, HUB_INDEX_MISSING_URL, HUB_INDEX_PERF_URL]);
  hub = await openHub(cdp, control, extensionId, { initScript: hubIndexSpy });
  await sleep(250);
  const afState = await evalIn(
    cdp,
    hub.sessionId,
    `({ fetches: globalThis.__hubIndexFetches.filter((item) => item.url === ${JSON.stringify(HUB_INDEX_SMALL_URL)}).length, band: Boolean(document.querySelector('[data-testid="band-hub-index"]')) })`,
    1
  );
  check("af. initial render does not read the hub index", afState.fetches === 0 && !afState.band, JSON.stringify(afState));

  await setSearchQuery(cdp, hub.sessionId, "descneedle");
  const agShown = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "Boolean(document.querySelector('[data-testid=\"band-hub-index\"]'))", 1)
  );
  await setSearchQuery(cdp, hub.sessionId, "");
  const agHidden = await waitFor(() =>
    evalIn(cdp, hub.sessionId, "!document.querySelector('[data-testid=\"band-hub-index\"]')", 1)
  );
  check("ag. query shows the hub band and clearing removes it from the DOM", Boolean(agShown) && Boolean(agHidden), `shown=${Boolean(agShown)} hidden=${Boolean(agHidden)}`);

  await setSearchQuery(cdp, hub.sessionId, "descneedle");
  const ahState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const row = document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.description)}]');
        return row ? { title: row.querySelector('.hub-index-title')?.textContent, fetches: globalThis.__hubIndexFetches.length } : null;
      })()`,
      1
    )
  );
  check("ah. description-only text finds a hub document", ahState?.title === "Description-only document" && !ahState.title.includes("descneedle"), JSON.stringify(ahState));

  await setSearchQuery(cdp, hub.sessionId, "tagneedle");
  const aiState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const row = document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.tag)}]');
        return row ? { title: row.querySelector('.hub-index-title')?.textContent, meta: row.querySelector('.hub-index-meta')?.textContent } : null;
      })()`,
      1
    )
  );
  check("ai. tag-only text finds a hub document", aiState?.title === "Tag-only document" && aiState.meta?.includes("tagneedle"), JSON.stringify(aiState));

  await setSearchQuery(cdp, hub.sessionId, "dedupneedle");
  const ajState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const ledger = document.querySelector('[data-entry-id="hub-ledger-duplicate"]');
        const duplicate = document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.duplicate)}]');
        const control = document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.dedupControl)}]');
        return ledger && control ? { ledger: true, duplicate: Boolean(duplicate), control: true } : null;
      })()`,
      1
    )
  );
  check("aj. ledger files are not duplicated in the hub band", ajState?.ledger && !ajState.duplicate && ajState.control, JSON.stringify(ajState));

  await setSearchQuery(cdp, hub.sessionId, "capneedle");
  const akState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const band = document.querySelector('[data-testid="band-hub-index"]');
        const rows = band?.querySelectorAll('[data-hub-index-id]');
        const count = document.querySelector('[data-testid="band-count-hub-index"]')?.textContent;
        const more = document.querySelector('[data-testid="hub-index-more"]')?.textContent;
        return rows?.length === 40 ? { rows: rows.length, count, more } : null;
      })()`,
      1
    )
  );
  check("ak. hub results stop at 40 and report the remainder", akState?.rows === 40 && akState.count === "43" && akState.more === S.hubIndex.more(3), JSON.stringify(akState));

  await setSearchQuery(cdp, hub.sessionId, "casefilter");
  const amBefore = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const unified = document.querySelector('.category-chip[data-category="UnifiedCase"]');
        const other = document.querySelector('.category-chip[data-category="OtherCase"]');
        return unified && other ? { unified: Number(unified.dataset.count), other: Number(other.dataset.count) } : null;
      })()`,
      1
    )
  );
  await evalIn(cdp, hub.sessionId, "document.querySelector('.category-chip[data-category=\"UnifiedCase\"]').click()", 1);
  const amAfter = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const hubRows = [...document.querySelectorAll('[data-testid="band-hub-index"] [data-hub-index-id]')];
        const ledger = Boolean(document.querySelector('[data-entry-id="hub-ledger-category"]'));
        const other = Boolean(document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.otherCase)}]'));
        const layout = JSON.parse(localStorage.getItem('tabhub:layout') ?? 'null');
        return hubRows.length === 2 && ledger && !other && layout?.selectedCategories?.includes('UnifiedCase')
          ? { hubRows: hubRows.length, ledger, other, selected: layout.selectedCategories }
          : null;
      })()`,
      1
    )
  );
  check("am. category chips merge ledger and hub counts and filter as an AND axis", amBefore?.unified === 3 && amBefore.other === 1 && amAfter?.hubRows === 2 && amAfter.ledger && !amAfter.other, `before=${JSON.stringify(amBefore)} after=${JSON.stringify(amAfter)}`);

  await closeHubTargets(cdp);
  hub = await openHub(cdp, control, extensionId, { initScript: hubIndexSpy });
  await setSearchQuery(cdp, hub.sessionId, "casefilter");
  const anState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-testid="band-hub-index"] [data-hub-index-id]').length;
        const selected = document.querySelector('.category-chip[data-category="UnifiedCase"]')?.getAttribute('aria-pressed');
        return rows === 2 ? { rows, selected, fetches: globalThis.__hubIndexFetches.length } : null;
      })()`,
      1
    )
  );
  check("an. a second search uses the six-hour storage cache without refetching", anState?.rows === 2 && anState.selected === "true" && anState.fetches === 0, JSON.stringify(anState));

  await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const nativeNow = Date.now.bind(Date);
      Date.now = () => nativeNow() + 6 * 60 * 60 * 1000 + 1;
    })()`,
    1
  );
  await setSearchQuery(cdp, hub.sessionId, "descneedle");
  const an2State = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(async () => {
        const call = globalThis.__hubIndexFetches.find((item) => item.url === ${JSON.stringify(HUB_INDEX_SMALL_URL)});
        const stored = (await chrome.storage.local.get(${JSON.stringify(HUB_INDEX_CACHE_KEY)}))[${JSON.stringify(HUB_INDEX_CACHE_KEY)}];
        return call?.settled && stored?.fetchedAt > ${Date.now()}
          ? { fetches: globalThis.__hubIndexFetches.length, settled: call.settled, rows: stored.rows?.length }
          : null;
      })()`,
      1
    )
  );
  check("an2. the next search refetches after the six-hour TTL", an2State?.fetches === 1 && an2State.settled && an2State.rows === hubIndexSmallRows.length, JSON.stringify(an2State));

  await closeHubTargets(cdp);
  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      await chrome.storage.local.remove(${JSON.stringify(HUB_INDEX_CACHE_KEY)});
      await chrome.storage.local.set({ [${JSON.stringify(HUB_INDEX_SETTINGS_KEY)}]: { sourceUrl: ${JSON.stringify(HUB_INDEX_MISSING_URL)} } });
      localStorage.removeItem('tabhub:layout');
    })()`
  );
  hub = await openHub(cdp, control, extensionId, { initScript: hubIndexSpy });
  await waitFor(() =>
    evalIn(cdp, hub.sessionId, "Boolean(document.querySelector('[data-entry-id=\"hub-ledger-normal\"]'))", 1)
  );
  await setSearchQuery(cdp, hub.sessionId, "ledgerneedle");
  await evalIn(
    cdp,
    hub.sessionId,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    1
  );
  const alState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const ledger = Boolean(document.querySelector('[data-entry-id="hub-ledger-normal"]'));
        const calls = globalThis.__hubIndexFetches.filter((item) => item.url === ${JSON.stringify(HUB_INDEX_MISSING_URL)});
        if (!ledger || calls.length !== 1 || !calls[0].settled) return null;
        document.querySelector('[data-testid="kind-tab-html"]')?.click();
        return true;
      })()`,
      1
    ),
    30000
  );
  const alSettledState = alState && await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const selected = document.querySelector('[data-testid="kind-tab-html"]')?.getAttribute('aria-selected');
        const ledger = Boolean(document.querySelector('[data-entry-id="hub-ledger-normal"]'));
        return selected === 'true' && ledger ? {
          ledger,
          fetches: globalThis.__hubIndexFetches.filter((item) => item.url === ${JSON.stringify(HUB_INDEX_MISSING_URL)}).length,
          settled: globalThis.__hubIndexFetches.find((item) => item.url === ${JSON.stringify(HUB_INDEX_MISSING_URL)})?.settled,
          band: Boolean(document.querySelector('[data-testid="band-hub-index"]')),
          ready: document.querySelector('[data-testid="hub-shell"]')?.dataset.ready,
          errors: globalThis.__hubIndexErrors.length
        } : null;
      })()`,
      1
    )
  );
  const alDiagnostic = alSettledState ?? await evalIn(
    cdp,
    hub.sessionId,
    `({
      ledger: Boolean(document.querySelector('[data-entry-id="hub-ledger-normal"]')),
      query: document.querySelector('[data-testid="hub-search"]')?.value,
      fetches: globalThis.__hubIndexFetches.filter((item) => item.url === ${JSON.stringify(HUB_INDEX_MISSING_URL)}),
      band: Boolean(document.querySelector('[data-testid="band-hub-index"]')),
      ready: document.querySelector('[data-testid="hub-shell"]')?.dataset.ready,
      errors: globalThis.__hubIndexErrors
    })`,
    1
  );
  check("al. a missing index silently omits only the hub band", alSettledState?.ledger && alSettledState.fetches === 1 && alSettledState.settled && !alSettledState.band && alSettledState.ready === "true" && alSettledState.errors === 0, JSON.stringify(alDiagnostic));

  await resetHubFixture(cdp, control.sessionId);
  const v151At = Date.now();
  const v151Pdf = fixtureEntry({
    id: "v151-pdf",
    url: "file:///C:/e2e/type-icons/Short.Report.PDF",
    kind: "pdf",
    title: "Short report",
    at: v151At
  });
  const v151Html = fixtureEntry({
    id: "v151-html",
    url: "file:///C:/e2e/type-icons/long-document.HTML",
    kind: "html",
    title: "A deliberately extreme title ".repeat(24),
    at: v151At - 1
  });
  const v151Web = fixtureEntry({
    id: "v151-web",
    url: `https://example.com/v151-favicon-${v151At}`,
    kind: "web",
    title: "Web fallback fixture",
    at: v151At - 2
  });
  const v151Entries = [v151Pdf, v151Html, v151Web];
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({
      ...${JSON.stringify(entryRecord(v151Entries))},
      'index:newtab': ${JSON.stringify(v151Entries)},
      [${JSON.stringify(HUB_INDEX_SETTINGS_KEY)}]: { sourceUrl: ${JSON.stringify(HUB_INDEX_SMALL_URL)} }
    })`
  );
  hub = await openHub(cdp, control, extensionId, { initScript: hubIndexSpyScript([HUB_INDEX_SMALL_URL]) });
  const v151IconState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const pdf = document.querySelector('[data-entry-id="v151-pdf"]');
        const html = document.querySelector('[data-entry-id="v151-html"]');
        const web = document.querySelector('[data-entry-id="v151-web"]');
        if (!pdf || !html || !web) return null;
        const pdfSvg = pdf.querySelector('svg[data-type-icon="pdf"]');
        const htmlSvg = html.querySelector('svg[data-type-icon="html"]');
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        return {
          pdfIcon: Boolean(pdfSvg),
          pdfSize: pdfSvg ? [pdfSvg.getBoundingClientRect().width, pdfSvg.getBoundingClientRect().height] : null,
          pdfViewBox: pdfSvg?.getAttribute('viewBox'),
          pdfPaths: pdfSvg ? [...pdfSvg.querySelectorAll('path')].map((path) => [path.getAttribute('d'), path.getAttribute('fill')]) : [],
          pdfText: pdfSvg?.querySelector('text')?.textContent,
          pdfTextSize: pdfSvg?.querySelector('text')?.getAttribute('font-size'),
          pdfFavicon: Boolean(pdf.querySelector('img[src*="/_favicon/"]')),
          htmlIcon: Boolean(htmlSvg),
          htmlSize: htmlSvg ? [htmlSvg.getBoundingClientRect().width, htmlSvg.getBoundingClientRect().height] : null,
          htmlViewBox: htmlSvg?.getAttribute('viewBox'),
          htmlPaths: htmlSvg ? [...htmlSvg.querySelectorAll('path')].map((path) => ({ d: path.getAttribute('d'), fill: path.getAttribute('fill'), stroke: path.getAttribute('stroke'), strokeWidth: path.getAttribute('stroke-width') })) : [],
          htmlFavicon: Boolean(html.querySelector('img[src*="/_favicon/"]')),
          localFaviconRequests: resources.filter((name) => name.includes('/_favicon/') && (name.includes(encodeURIComponent(${JSON.stringify(v151Pdf.url)})) || name.includes(encodeURIComponent(${JSON.stringify(v151Html.url)})))).length,
          webFavicon: Boolean(web.querySelector('img[src*="/_favicon/"]'))
        };
      })()`,
      1
    )
  );
  check(
    "ao. pdf rows use the inline PDF document icon without _favicon",
    v151IconState?.pdfIcon &&
      stableStringify(v151IconState.pdfSize) === stableStringify([15, 15]) &&
      v151IconState.pdfViewBox === "0 0 16 16" &&
      stableStringify(v151IconState.pdfPaths) === stableStringify([
        ["M3.2 1h5.4L13 5.4v9.1a.9.9 0 0 1-.9.9H3.2a.9.9 0 0 1-.9-.9V1.9a.9.9 0 0 1 .9-.9z", "#d93025"],
        ["M8.6 1v3.5a.9.9 0 0 0 .9.9H13z", "#f6aea9"]
      ]) &&
      v151IconState.pdfText === "PDF" && v151IconState.pdfTextSize === "5.2" &&
      !v151IconState.pdfFavicon && v151IconState.localFaviconRequests === 0,
    JSON.stringify(v151IconState)
  );
  check(
    "ap. html rows use the inline HTML document icon without _favicon",
    v151IconState?.htmlIcon &&
      stableStringify(v151IconState.htmlSize) === stableStringify([15, 15]) &&
      v151IconState.htmlViewBox === "0 0 16 16" &&
      v151IconState.htmlPaths[0]?.fill === "#12b5cb" &&
      v151IconState.htmlPaths[1]?.fill === "#a1e4ed" &&
      v151IconState.htmlPaths[2]?.d === "M6.1 8.3 4.7 10l1.4 1.7M9.5 8.3 10.9 10l-1.4 1.7" &&
      v151IconState.htmlPaths[2]?.stroke === "#fff" && v151IconState.htmlPaths[2]?.strokeWidth === "1.15" &&
      !v151IconState.htmlFavicon && v151IconState.localFaviconRequests === 0,
    JSON.stringify(v151IconState)
  );

  await evalIn(
    cdp,
    hub.sessionId,
    `document.querySelector('[data-entry-id="v151-web"] img.favicon')?.dispatchEvent(new Event('error'))`,
    1
  );
  const aqState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const globe = document.querySelector('[data-entry-id="v151-web"] svg[data-type-icon="web-fallback"]');
        const circle = globe?.querySelector('circle');
        const ellipse = globe?.querySelector('ellipse');
        const path = globe?.querySelector('path');
        const rect = globe?.getBoundingClientRect();
        return globe ? {
          size: [rect.width, rect.height],
          viewBox: globe.getAttribute('viewBox'),
          circle: [circle?.getAttribute('cx'), circle?.getAttribute('cy'), circle?.getAttribute('r'), circle?.getAttribute('stroke')],
          ellipse: [ellipse?.getAttribute('cx'), ellipse?.getAttribute('cy'), ellipse?.getAttribute('rx'), ellipse?.getAttribute('ry')],
          path: [path?.getAttribute('d'), path?.getAttribute('stroke'), path?.getAttribute('stroke-width')]
        } : null;
      })()`,
      1
    )
  );
  check(
    "aq. failed web favicons fall back to the inline globe",
    stableStringify(aqState?.size) === stableStringify([15, 15]) &&
      aqState?.viewBox === "0 0 16 16" &&
      stableStringify(aqState.circle) === stableStringify(["8", "8", "6.6", "#5f6368"]) &&
      stableStringify(aqState.ellipse) === stableStringify(["8", "8", "2.9", "6.6"]) &&
      stableStringify(aqState.path) === stableStringify(["M1.7 6h12.6M1.7 10h12.6", "#5f6368", "1.2"]),
    JSON.stringify(aqState)
  );

  const extensionState = await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const pdf = document.querySelector('[data-entry-id="v151-pdf"]');
      const html = document.querySelector('[data-entry-id="v151-html"]');
      const web = document.querySelector('[data-entry-id="v151-web"]');
      const title = html.querySelector('.row-title');
      const ext = html.querySelector('.row-ext');
      const body = html.querySelector('.row-body');
      const titleRect = title.getBoundingClientRect();
      const extRect = ext.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const pdfTitleRect = pdf.querySelector('.row-title').getBoundingClientRect();
      const pdfExtRect = pdf.querySelector('.row-ext').getBoundingClientRect();
      return {
        pdf: pdf.querySelector('.row-ext')?.textContent,
        html: ext?.textContent,
        web: web.querySelector('.row-ext')?.textContent ?? null,
        longTitleClipped: title.scrollWidth > title.clientWidth,
        extWidth: extRect.width,
        extInside: extRect.right <= bodyRect.right + 0.5,
        shortTitleGap: pdfExtRect.left - pdfTitleRect.right
      };
    })()`
  );
  check("ar. only html and pdf rows show lowercase file extensions", extensionState?.pdf === ".pdf" && extensionState.html === ".html" && extensionState.web === null, JSON.stringify(extensionState));
  check("as. long titles ellipsize while the adjacent extension remains visible", extensionState?.longTitleClipped && extensionState.extWidth > 0 && extensionState.extInside && extensionState.shortTitleGap >= 3.5 && extensionState.shortTitleGap <= 4.5, JSON.stringify(extensionState));

  await setSearchQuery(cdp, hub.sessionId, "descneedle");
  const atState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const row = document.querySelector('[data-hub-index-id=${JSON.stringify(HUB_INDEX_FIXTURE_IDS.description)}]');
        const icon = row?.querySelector('svg[data-type-icon="html"]');
        const rect = icon?.getBoundingClientRect();
        return row ? { htmlIcon: Boolean(icon), size: rect ? [rect.width, rect.height] : null, fill: icon?.querySelector('path')?.getAttribute('fill'), favicon: Boolean(row.querySelector('img[src*="/_favicon/"]')) } : null;
      })()`,
      1
    )
  );
  check("at. hub-index rows use the inline HTML icon", atState?.htmlIcon && stableStringify(atState.size) === stableStringify([15, 15]) && atState.fill === "#12b5cb" && !atState.favicon, JSON.stringify(atState));

  const tokenState = await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const root = getComputedStyle(document.documentElement);
      const css = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\\n').toLowerCase();
      return {
        html: root.getPropertyValue('--kind-html').trim().toLowerCase(),
        htmlLight: root.getPropertyValue('--kind-html-light').trim().toLowerCase(),
        pdfLight: root.getPropertyValue('--kind-pdf-light').trim().toLowerCase(),
        internal: root.getPropertyValue('--svc-internal').trim().toLowerCase(),
        oldHtmlCount: (css.match(/#1e8e3e/g) ?? []).length,
        htmlReferences: (css.match(/var\\(--kind-html\\)/g) ?? []).length
      };
    })()`
  );
  check("au. the HTML kind token is cyan with no rejected green left in CSS", tokenState?.html === "#12b5cb" && tokenState.oldHtmlCount === 0 && tokenState.htmlReferences >= 3, JSON.stringify(tokenState));
  check("av. internal service cyan is distinct and both light kind tokens exist", tokenState?.internal === "#00838f" && tokenState.internal !== tokenState.html && tokenState.htmlLight === "#a1e4ed" && tokenState.pdfLight === "#f6aea9", JSON.stringify(tokenState));

  await resetHubFixture(cdp, control.sessionId);
  const shortcutPinned = fixtureEntry({
    id: "v151-shortcut-pin",
    url: "file:///C:/e2e/type-icons/pinned.html",
    kind: "html",
    title: "Pinned shortcut",
    at: Date.now()
  });
  shortcutPinned.pinned = true;
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord([shortcutPinned]))}, 'index:newtab': ${JSON.stringify([shortcutPinned])} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const shortcutState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="shortcut-strip"]');
        const bookmarks = document.querySelector('[data-testid="bookmark-strip"]');
        const pinned = document.querySelector('[data-testid="pinned-strip"]');
        if (!row || !bookmarks || !pinned) return null;
        const relation = bookmarks.compareDocumentPosition(pinned);
        return {
          sameParent: bookmarks.parentElement === row && pinned.parentElement === row,
          bookmarkBeforePinned: Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING),
          sameTop: Math.abs(bookmarks.getBoundingClientRect().top - pinned.getBoundingClientRect().top) < 1,
          height: row.getBoundingClientRect().height,
          gap: getComputedStyle(row).gap,
          bookmarkMaxWidth: getComputedStyle(bookmarks).maxWidth,
          bookmarkFlexGrow: getComputedStyle(bookmarks).flexGrow,
          pinnedFlexGrow: getComputedStyle(pinned).flexGrow,
          bookmarkOverflow: getComputedStyle(bookmarks.querySelector('[data-testid="bookmark-chips"]')).overflowX,
          pinnedOverflow: getComputedStyle(pinned.querySelector('.pinned-list')).overflowX,
          bookmarkHeading: bookmarks.querySelector('h2')?.textContent.trim(),
          pinnedHeading: pinned.querySelector('h1')?.textContent.trim()
        };
      })()`,
      1
    )
  );
  check("aw. bookmarks and pinned shortcuts share one row in that DOM order", shortcutState?.sameParent && shortcutState.bookmarkBeforePinned && shortcutState.sameTop && shortcutState.height === 28 && shortcutState.gap === "16px" && shortcutState.bookmarkMaxWidth === "45%" && shortcutState.bookmarkFlexGrow === "0" && shortcutState.pinnedFlexGrow === "1" && shortcutState.bookmarkOverflow === "auto" && shortcutState.pinnedOverflow === "auto" && shortcutState.bookmarkHeading === "⭐" && shortcutState.pinnedHeading === "📌", JSON.stringify(shortcutState));

  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      const [root] = await chrome.bookmarks.getTree();
      const other = root.children?.find((node) => node.id === '2') ?? root.children?.find((node) => node.id !== '1' && !node.url);
      if (!other) throw new Error('other bookmarks folder not found');
      await chrome.bookmarks.move(${JSON.stringify(bookmarkFixture.folderId)}, { parentId: other.id });
      await chrome.bookmarks.move(${JSON.stringify(bookmarkFixture.directId)}, { parentId: other.id });
      return true;
    })()`
  );
  const axPinnedOnly = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `!document.querySelector('[data-testid="bookmark-strip"]') && Boolean(document.querySelector('[data-testid="pinned-strip"]')) && Boolean(document.querySelector('[data-testid="shortcut-strip"]'))`,
      1
    )
  );
  shortcutPinned.pinned = false;
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord([shortcutPinned]))}, 'index:newtab': ${JSON.stringify([shortcutPinned])} })`
  );
  const axEmpty = await waitFor(() =>
    evalIn(cdp, hub.sessionId, `!document.querySelector('[data-testid="shortcut-strip"]')`, 1)
  );
  check("ax. empty shortcut blocks and the empty combined row are omitted", Boolean(axPinnedOnly) && Boolean(axEmpty), `pinnedOnly=${Boolean(axPinnedOnly)} empty=${Boolean(axEmpty)}`);
  await evalIn(
    cdp,
    control.sessionId,
    `(async () => {
      await chrome.bookmarks.move(${JSON.stringify(bookmarkFixture.folderId)}, { parentId: '1' });
      await chrome.bookmarks.move(${JSON.stringify(bookmarkFixture.directId)}, { parentId: '1' });
      return true;
    })()`
  );

  await resetHubFixture(cdp, control.sessionId);
  const actionOpenUrl = `https://example.com/v151-open-${Date.now()}`;
  await openTab(cdp, control.sessionId, actionOpenUrl);
  const actionOpen = await waitForEntry(cdp, control.sessionId, actionOpenUrl);
  const actionAt = Date.now();
  const actionRecent = fixtureEntry({
    id: "v151-action-recent",
    url: "file:///C:/e2e/actions/recent.html",
    kind: "html",
    title: "Recent action row",
    at: actionAt
  });
  const actionLater = fixtureEntry({
    id: "v151-action-later",
    url: "file:///C:/e2e/actions/later.pdf",
    kind: "pdf",
    title: "Later action row",
    at: actionAt - 30 * 24 * 60 * 60 * 1000
  });
  actionLater.visitCount = 1;
  actionLater.later = true;
  actionLater.laterAt = actionAt;
  const actionEntries = [actionRecent, actionLater];
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({ ...${JSON.stringify(entryRecord(actionEntries))}, 'index:newtab': ${JSON.stringify(actionEntries)} })`
  );
  hub = await openHub(cdp, control, extensionId);
  const actionIds = {
    open: actionOpen?.entry.id,
    recent: actionRecent.id,
    later: actionLater.id
  };
  const ayState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const ids = ${JSON.stringify(actionIds)};
        const state = {};
        for (const band of ['open', 'recent', 'later']) {
          const id = ids[band];
          const row = document.querySelector('[data-testid="row-' + band + '-' + id + '"]');
          const buttons = row ? [...row.querySelectorAll('.row-actions button')] : [];
          const actions = row?.querySelector('.row-actions');
          state[band] = {
            count: buttons.length,
            labels: buttons.map((button) => button.textContent.trim()),
            titles: buttons.map((button) => button.title),
            widths: buttons.map((button) => getComputedStyle(button).width),
            heights: buttons.map((button) => getComputedStyle(button).height),
            gap: actions ? getComputedStyle(actions).gap : null
          };
        }
        return Object.values(state).every((item) => item.count === 3) ? state : null;
      })()`,
      1
    )
  );
  check(
    "ay. every band renders clock, pin, and remove row actions",
    ayState &&
      Object.values(ayState).every((item) =>
        JSON.stringify(item.labels) === JSON.stringify(["🕐", "📌", "×"]) &&
        item.titles[1] === S.action.pin && item.titles[2] === S.action.remove &&
        item.widths.every((width) => width === "20px") && item.heights.every((height) => height === "20px") && item.gap === "0px"
      ) &&
      ayState.open.titles[0] === S.action.later && ayState.recent.titles[0] === S.action.later && ayState.later.titles[0] === S.action.laterUndo,
    JSON.stringify(ayState)
  );

  const tabsBeforeRecentLater = await evalIn(cdp, control.sessionId, "chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id).sort((a, b) => a - b))");
  await evalIn(cdp, hub.sessionId, `document.querySelector('[data-testid="later-${actionRecent.id}"]').click()`, 1);
  const azState = await waitFor(async () => {
    const stored = await evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get('entry:${actionRecent.id}').then((got) => got['entry:${actionRecent.id}'])`,
      1
    );
    const moved = await evalIn(cdp, hub.sessionId, `Boolean(document.querySelector('[data-testid="row-later-${actionRecent.id}"]'))`, 1);
    return stored?.later && moved ? { stored, moved } : null;
  });
  const tabsAfterRecentLater = await evalIn(cdp, control.sessionId, "chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id).sort((a, b) => a - b))");
  check("az. recent clock moves the ledger row to later without closing a tab", azState?.stored.laterAt > 0 && stableStringify(tabsBeforeRecentLater) === stableStringify(tabsAfterRecentLater), `state=${JSON.stringify(azState)} before=${JSON.stringify(tabsBeforeRecentLater)} after=${JSON.stringify(tabsAfterRecentLater)}`);

  await evalIn(cdp, hub.sessionId, `document.querySelector('[data-testid="later-${actionLater.id}"]').click()`, 1);
  const baState = await waitFor(async () => {
    const stored = await evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get('entry:${actionLater.id}').then((got) => got['entry:${actionLater.id}'])`,
      1
    );
    const recent = await evalIn(cdp, hub.sessionId, `Boolean(document.querySelector('[data-testid="row-recent-${actionLater.id}"]'))`, 1);
    return stored && !stored.later && stored.laterAt === null && stored.visitCount >= 2 && stored.lastSeenAt > actionAt && recent
      ? { later: stored.later, laterAt: stored.laterAt, visitCount: stored.visitCount, lastSeenAt: stored.lastSeenAt, recent }
      : null;
  });
  check("ba. later clock restores even a one-visit old row to recent", Boolean(baState), JSON.stringify(baState));

  await evalIn(cdp, hub.sessionId, `document.querySelector('[data-testid="pin-${actionLater.id}"]').click()`, 1);
  const bbPinned = await waitFor(async () => {
    const stored = await evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get('entry:${actionLater.id}').then((got) => got['entry:${actionLater.id}'])`,
      1
    );
    const visible = await evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        document.querySelector('[data-testid="hub-search"]')?.focus();
        const row = document.querySelector('[data-testid="row-recent-${actionLater.id}"]');
        const button = row?.querySelector('[data-testid="pin-${actionLater.id}"]');
        if (!row || !button) return null;
        const actions = button.closest('.row-actions');
        const rect = button.getBoundingClientRect();
        return {
          active: button.classList.contains('is-active'),
          pressed: button.getAttribute('aria-pressed'),
          title: button.title,
          opacity: getComputedStyle(button).opacity,
          visibility: getComputedStyle(button).visibility,
          parentOpacity: getComputedStyle(actions).opacity,
          parentVisibility: getComputedStyle(actions).visibility,
          rect: [rect.width, rect.height],
          hovered: row.matches(':hover'),
          focused: row.contains(document.activeElement)
        };
      })()`,
      1
    );
    return stored?.pinned && visible?.active && visible.pressed === "true" && visible.title === S.action.unpin && Number(visible.opacity) > 0 && Number(visible.parentOpacity) > 0 && visible.visibility === "visible" && visible.parentVisibility === "visible" && visible.rect[0] > 0 && visible.rect[1] > 0 && !visible.hovered && !visible.focused ? visible : null;
  });
  await evalIn(cdp, hub.sessionId, `document.querySelector('[data-testid="pin-${actionLater.id}"]').click()`, 1);
  const bbUnpinned = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `chrome.storage.local.get('entry:${actionLater.id}').then((got) => got['entry:${actionLater.id}']?.pinned === false)`,
      1
    )
  );
  check("bb. pin toggles ledger state and an active pin remains visible without hover", Boolean(bbPinned) && Boolean(bbUnpinned), `pinned=${JSON.stringify(bbPinned)} unpinned=${Boolean(bbUnpinned)}`);

  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.remove(${JSON.stringify([HUB_INDEX_CACHE_KEY, HUB_INDEX_SETTINGS_KEY])})`
  );
  await resetHubFixture(cdp, control.sessionId);
  const groupCloseUrls = [
    `https://example.com/v-group-a-${Date.now()}`,
    `https://example.com/v-group-b-${Date.now()}`
  ];
  const groupCloseTabIds = [];
  for (const url of groupCloseUrls) groupCloseTabIds.push(await openTab(cdp, control.sessionId, url));
  const groupCloseEntries = [];
  for (const url of groupCloseUrls) {
    groupCloseEntries.push(await waitForEntry(cdp, control.sessionId, url));
  }
  hub = await openHub(cdp, control, extensionId);
  const faviconState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const row = document.querySelector('[data-entry-id=${JSON.stringify(groupCloseEntries[0]?.entry.id)}]');
        const img = row?.querySelector('img.favicon');
        if (!img) return null;
        const src = new URL(img.src);
        const size = getComputedStyle(img);
        return { protocol: src.protocol, host: src.host, path: src.pathname, pageUrl: src.searchParams.get('pageUrl'), requestedSize: src.searchParams.get('size'), width: size.width, height: size.height };
      })()`,
      1
    )
  );
  check(
    "w. web favicon uses the extension _favicon API at size 32 and renders at 15px",
    faviconState?.protocol === "chrome-extension:" &&
      faviconState.host === extensionId &&
      faviconState.path === "/_favicon/" &&
      faviconState.pageUrl === groupCloseUrls[0] &&
      faviconState.requestedSize === "32" &&
      faviconState.width === "15px" &&
      faviconState.height === "15px",
    JSON.stringify(faviconState)
  );
  const undoBeforeGroupClose = await evalIn(
    cdp,
    control.sessionId,
    "chrome.storage.local.get('undo:lastClosed').then((got) => got['undo:lastClosed']?.ts ?? 0)"
  );
  await evalIn(
    cdp,
    hub.sessionId,
    `(() => {
      const row = document.querySelector('[data-entry-id=${JSON.stringify(groupCloseEntries[0]?.entry.id)}]');
      const group = row?.closest('.hub-group');
      const peer = group?.querySelector('[data-entry-id=${JSON.stringify(groupCloseEntries[1]?.entry.id)}]');
      if (!group || !peer) throw new Error('group-close fixture rows are not in one group');
      group.querySelector('.group-close-action').click();
    })()`
  );
  const groupClosed = await waitFor(() =>
    evalIn(
      cdp,
      control.sessionId,
      `(async () => {
        const gone = await Promise.all(${JSON.stringify(groupCloseTabIds)}.map((id) => chrome.tabs.get(id).then(() => false).catch(() => true)));
        const undo = (await chrome.storage.local.get('undo:lastClosed'))['undo:lastClosed'];
        return gone.every(Boolean) && undo?.ts > ${undoBeforeGroupClose} && undo.urls?.length === 2
          ? { urls: [...undo.urls].sort(), ts: undo.ts }
          : null;
      })()`,
      1
    )
  );
  check(
    "v. group close removes every tab after saving an undo snapshot",
    JSON.stringify(groupClosed?.urls) === JSON.stringify([...groupCloseUrls].sort()),
    JSON.stringify(groupClosed)
  );

  await resetHubFixture(cdp, control.sessionId);
  const densityAt = Date.now();
  const densityEntries = Array.from({ length: 140 }, (_, index) =>
    fixtureEntry({
      id: `q-density-${String(index).padStart(3, "0")}`,
      url: `file:///C:/e2e/density/group-${String(Math.floor(index / 7)).padStart(2, "0")}/item-${index}.html`,
      kind: "html",
      service: "other",
      group: `density-group-${String(Math.floor(index / 7)).padStart(2, "0")}`,
      title: `density item ${index}`,
      at: densityAt - index
    })
  );
  await evalIn(
    cdp,
    control.sessionId,
    `chrome.storage.local.set({
      ...${JSON.stringify(entryRecord(densityEntries))},
      'index:newtab': ${JSON.stringify(densityEntries)},
      [${JSON.stringify(HUB_INDEX_SETTINGS_KEY)}]: { sourceUrl: ${JSON.stringify(HUB_INDEX_PERF_URL)} }
    })`
  );
  hub = await openHub(cdp, control, extensionId, { initScript: hubIndexSpyScript([HUB_INDEX_PERF_URL]) });
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false },
    hub.sessionId
  );
  const densityState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const fixtureIds = new Set(${JSON.stringify(densityEntries.map((entry) => entry.id))});
        const rows = [...document.querySelectorAll('[data-entry-id]')].filter((row) => fixtureIds.has(row.dataset.entryId));
        if (rows.length !== 140) return null;
        const within = rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
        }).length;
        return { innerWidth, innerHeight, total: rows.length, within, groups: document.querySelectorAll('[data-testid="band-recent"] .hub-group').length, renderMs: performance.now() };
      })()`,
      1
    )
  );
  check(
    "q. dense layout and initial render timing stay within the v0.13 baseline",
    densityState?.innerWidth === 1680 &&
      densityState?.innerHeight === 1000 &&
      densityState.within >= 100 &&
      densityState.groups === 20 &&
      densityState.renderMs < V013_DENSE_RENDER_BASELINE_MS * 1.1,
    `${JSON.stringify(densityState)} baselineMs=${V013_DENSE_RENDER_BASELINE_MS} limitMs=${(V013_DENSE_RENDER_BASELINE_MS * 1.1).toFixed(1)}`
  );

  const perfInitialFetches = await evalIn(cdp, hub.sessionId, "globalThis.__hubIndexFetches.length", 1);
  await setSearchQuery(cdp, hub.sessionId, "perfcommon");
  const hubIndexPerfState = await waitFor(() =>
    evalIn(
      cdp,
      hub.sessionId,
      `(() => {
        const band = document.querySelector('[data-testid="band-hub-index"]');
        const rows = band?.querySelectorAll('[data-hub-index-id]').length;
        const total = Number(document.querySelector('[data-testid="band-count-hub-index"]')?.textContent);
        const more = document.querySelector('[data-testid="hub-index-more"]')?.textContent;
        const fetches = globalThis.__hubIndexFetches.length;
        return rows === 40 && total === 4000 ? { rows, total, more, fetches } : null;
      })()`,
      1
    ),
    30000
  );
  check(
    "q2. 4000-row hub fixture adds no initial read or v0.14 render regression",
    perfInitialFetches === 0 &&
      hubIndexPerfState?.rows === 40 &&
      hubIndexPerfState.total === 4000 &&
      hubIndexPerfState.more === S.hubIndex.more(3960) &&
      hubIndexPerfState.fetches === 1 &&
      densityState?.renderMs < V014_HUB_INDEX_RENDER_BASELINE_MS * 1.1,
    `render=${densityState?.renderMs} baselineMs=${V014_HUB_INDEX_RENDER_BASELINE_MS} limitMs=${(V014_HUB_INDEX_RENDER_BASELINE_MS * 1.1).toFixed(1)} initialFetches=${perfInitialFetches} search=${JSON.stringify(hubIndexPerfState)}`
  );

  if (openedBookmarkTabs?.length) {
    await evalIn(cdp, control.sessionId, `chrome.tabs.remove(${JSON.stringify(openedBookmarkTabs)}).catch(() => undefined)`);
  }

  console.log(JSON.stringify({ ok: results.every((result) => result.ok), extensionId, results }, null, 2));
} catch (error) {
  console.error(error);
  check("unhandled E2E error", false, String(error));
} finally {
  await stopProcessTree(chrome);
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
