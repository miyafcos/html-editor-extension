export interface HtmlSplit {
  headOuter: string;
  bodyInner: string;
  tailOuter: string;
  newline: "\r\n" | "\n";
  bom: boolean;
}

export function decodeHtml(buf: ArrayBuffer): { text: string; bom: boolean; newline: "\r\n" | "\n" } {
  const bytes = new Uint8Array(buf);
  let offset = 0;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    offset = 3;
  }
  const text = new TextDecoder("utf-8").decode(bytes.subarray(offset));
  const newline: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
  return { text, bom, newline };
}

export function splitHtml(rawText: string, bom: boolean, newline: "\r\n" | "\n"): HtmlSplit {
  const bodyOpen = /<body\b[^>]*>/i.exec(rawText);
  if (!bodyOpen) throw new Error("HTML に <body> タグが見つかりません");
  const openEnd = bodyOpen.index + bodyOpen[0].length;

  const bodyCloseRegex = /<\/body\s*>/gi;
  bodyCloseRegex.lastIndex = openEnd;
  let lastClose: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = bodyCloseRegex.exec(rawText)) !== null) lastClose = m;
  if (!lastClose) throw new Error("HTML に </body> タグが見つかりません");

  return {
    headOuter: rawText.slice(0, openEnd),
    bodyInner: rawText.slice(openEnd, lastClose.index),
    tailOuter: rawText.slice(lastClose.index),
    newline,
    bom
  };
}

export function assembleHtml(split: HtmlSplit, newBodyInner: string): Uint8Array {
  const normalized = split.newline === "\r\n"
    ? newBodyInner.replace(/\r\n|\r|\n/g, "\r\n")
    : newBodyInner.replace(/\r\n|\r/g, "\n");
  const text = split.headOuter + normalized + split.tailOuter;
  const body = new TextEncoder().encode(text);
  if (!split.bom) return body;
  const out = new Uint8Array(3 + body.length);
  out[0] = 0xef; out[1] = 0xbb; out[2] = 0xbf;
  out.set(body, 3);
  return out;
}
