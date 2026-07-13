export type Msg =
  | { type: "organize-tabs"; collapse?: boolean }
  | { type: "toggle-collapse" }
  | { type: "close-duplicate-tabs" }
  | { type: "close-report-tabs" }
  | { type: "open-entries"; urls: string[] }
  | { type: "save-tabset"; name: string }
  | { type: "open-tabset"; id: string }
  | { type: "run-backfill" };

export interface MsgResponse {
  ok: boolean;
  count?: number;
  error?: string;
}

export function sendMsg(msg: Msg): Promise<MsgResponse> {
  return chrome.runtime.sendMessage(msg);
}
