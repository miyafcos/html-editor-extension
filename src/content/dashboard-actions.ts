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
const STAFFOPS_EVENT = "staffops-task-action";
const STAFFOPS_ACK_EVENT = "staffops-task-action-ack";
const STAFFOPS_REF_RE = /^T-[A-Z2-7]{8,52}(?:-\d+)?$/;
const STAFFOPS_ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const STAFFOPS_ACTIONS = new Set(["complete", "append_memo"]);
const STAFFOPS_SOURCES = new Set(["claude-chat", "dashboard", "slack"]);

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
  try {
    chrome.runtime.sendMessage(
      {
        type: "claudeops-decision",
        qid,
        action,
        note: String(payload.note ?? ""),
        ts: String(payload.ts ?? "")
      },
      () => {
        // consume lastError so Chrome doesn't log an unchecked-error warning
        if (chrome.runtime.lastError) {
          console.warn("claudeops decision delivery failed", chrome.runtime.lastError.message);
        }
      }
    );
  } catch (e) {
    // extension context invalidated (e.g. reloaded) — no ack, page shows fallback
    console.warn("claudeops decision sendMessage threw", e);
    return;
  }
  // ack immediately: the payload is validated here and Chrome queues the message
  // (waking the SW) — waiting for the SW's reply raced its cold start and lost
  // acks (probe7: ackLog stayed empty while the file was still written). The
  // SW's ok-reply never meant "file written" anyway; the watcher-rendered queue
  // remains the source of truth.
  document.dispatchEvent(new CustomEvent(ACK_EVENT, { detail: JSON.stringify({ qid }) }));
});

document.addEventListener(STAFFOPS_EVENT, (event) => {
  const detail = (event as CustomEvent).detail as unknown;
  let payload: Record<string, unknown>;
  try {
    payload = typeof detail === "string" ? JSON.parse(detail) : ((detail ?? {}) as Record<string, unknown>);
  } catch {
    return;
  }
  const ref = payload.ref;
  const actionId = payload.actionId;
  const action = payload.action;
  const note = payload.note ?? "";
  const source = payload.source;
  const dryRun = payload.dryRun ?? false;
  if (
    typeof ref !== "string" || !STAFFOPS_REF_RE.test(ref) ||
    typeof actionId !== "string" || !STAFFOPS_ACTION_ID_RE.test(actionId) ||
    typeof action !== "string" || !STAFFOPS_ACTIONS.has(action) ||
    typeof note !== "string" || note.length > 1000 ||
    (action === "append_memo" && !note.trim()) ||
    typeof source !== "string" || !STAFFOPS_SOURCES.has(source) ||
    typeof dryRun !== "boolean"
  ) return;
  try {
    chrome.runtime.sendMessage(
      {
        type: "staffops-task-action", ref, actionId, action, note: note.trim(), source,
        dryRun, ts: typeof payload.ts === "string" ? payload.ts : ""
      },
      (response?: { ok?: boolean; error?: string }) => {
        const error = chrome.runtime.lastError?.message || response?.error || "";
        const ack = { actionId, ok: response?.ok === true && !error, error };
        document.dispatchEvent(new CustomEvent(STAFFOPS_ACK_EVENT, { detail: JSON.stringify(ack) }));
      }
    );
  } catch (e) {
    document.dispatchEvent(new CustomEvent(STAFFOPS_ACK_EVENT, {
      detail: JSON.stringify({ actionId, ok: false, error: String(e) })
    }));
  }
});
