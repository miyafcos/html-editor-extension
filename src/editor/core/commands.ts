export type EditorCommand = (doc: Document, win: Window) => void;

const exec = (cmd: string, value?: string): EditorCommand => (doc) => {
  doc.execCommand(cmd, false, value);
};

export const commands = {
  bold: exec("bold"),
  italic: exec("italic"),
  underline: exec("underline"),
  strikethrough: exec("strikeThrough"),
  h1: exec("formatBlock", "H1"),
  h2: exec("formatBlock", "H2"),
  h3: exec("formatBlock", "H3"),
  h4: exec("formatBlock", "H4"),
  paragraph: exec("formatBlock", "P"),
  ul: exec("insertUnorderedList"),
  ol: exec("insertOrderedList"),
  alignLeft: exec("justifyLeft"),
  alignCenter: exec("justifyCenter"),
  alignRight: exec("justifyRight"),
  undo: exec("undo"),
  redo: exec("redo"),
  removeFormat: exec("removeFormat"),
  color: (c: string): EditorCommand => exec("foreColor", c),
  bgColor: (c: string): EditorCommand => exec("backColor", c),
  link: (url: string): EditorCommand => exec("createLink", url),
  unlink: exec("unlink")
};

function getFrameContext(iframe: HTMLIFrameElement | null): { doc: Document; win: Window } | null {
  if (!iframe) return null;
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return null;
  return { doc, win };
}

export function runCommand(iframe: HTMLIFrameElement | null, cmd: EditorCommand) {
  const ctx = getFrameContext(iframe);
  if (!ctx) return;
  ctx.win.focus();
  (ctx.doc.body as HTMLElement).focus({ preventScroll: true });
  cmd(ctx.doc, ctx.win);
}

export function insertHtmlAtSelection(iframe: HTMLIFrameElement | null, html: string) {
  const ctx = getFrameContext(iframe);
  if (!ctx) return;
  ctx.win.focus();
  (ctx.doc.body as HTMLElement).focus({ preventScroll: true });
  const sel = ctx.win.getSelection();
  if (!sel || sel.rangeCount === 0) {
    ctx.doc.body.insertAdjacentHTML("beforeend", html);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const template = ctx.doc.createElement("template");
  template.innerHTML = html;
  const frag = template.content;
  const lastChild = frag.lastChild;
  range.insertNode(frag);
  if (lastChild) {
    const newRange = ctx.doc.createRange();
    newRange.setStartAfter(lastChild);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

export function findAncestor<T extends HTMLElement>(
  iframe: HTMLIFrameElement | null,
  selector: string
): T | null {
  const ctx = getFrameContext(iframe);
  if (!ctx) return null;
  const sel = ctx.win.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
  while (node && node !== ctx.doc.body) {
    if (node.nodeType === 1 && (node as Element).matches(selector)) return node as T;
    node = node.parentNode;
  }
  return null;
}
