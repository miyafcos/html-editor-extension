/**
 * Claude Ops dashboard bridge.
 *
 * The dashboard (file:///C:/Users/miyaz/claude-ops/dashboard/index.html) is a
 * generated, self-contained page with 👍/❌/📝 buttons. It cannot write to disk
 * itself, so it dispatches a DOM CustomEvent with a JSON-string detail; this
 * content script forwards it to the service worker, which drops a decision
 * file into Downloads/claude-ops-decisions/ for the ops watcher to ingest.
 * On success we dispatch an ack event so the page can show optimistic state
 * (without the ack the page falls back to copying a CLI command).
 */

const DECISION_EVENT = "claudeops-decision";
const ACK_EVENT = "claudeops-decision-ack";
const QID_RE = /^q-\d{8}-\d{6}-[0-9a-f]{4}$/;
const ACTIONS = new Set(["done", "dismissed", "note"]);

// Isolated-world marker so E2E/diagnostics (chrome.scripting) can verify injection.
(window as unknown as Record<string, unknown>).__claudeopsBridge = true;

document.addEventListener(DECISION_EVENT, (event) => {
  const detail = (event as CustomEvent).detail as unknown;
  let payload: Record<string, unknown>;
  try {
    payload = typeof detail === "string" ? JSON.parse(detail) : ((detail ?? {}) as Record<string, unknown>);
  } catch {
    return;
  }
  const qid = String(payload.qid ?? "");
  const action = String(payload.action ?? "");
  if (!QID_RE.test(qid) || !ACTIONS.has(action)) return;
  chrome.runtime.sendMessage(
    {
      type: "claudeops-decision",
      qid,
      action,
      note: String(payload.note ?? ""),
      ts: String(payload.ts ?? "")
    },
    (res?: { ok?: boolean }) => {
      if (chrome.runtime.lastError || !res?.ok) return;
      // qid を ack に載せる (ページ側は qid 単位で待つ — 連打時の混線防止)
      document.dispatchEvent(new CustomEvent(ACK_EVENT, { detail: JSON.stringify({ qid }) }));
    }
  );
});
