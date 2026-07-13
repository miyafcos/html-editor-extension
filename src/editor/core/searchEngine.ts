export const MARK_CLASS = "he-search-mark";

export function clearMarks(root: Element): void {
  root.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}`).forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
  });
  root.normalize();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightMatches(
  root: Element,
  query: string,
  caseSensitive = false
): HTMLElement[] {
  clearMarks(root);
  if (!query) return [];
  const marks: HTMLElement[] = [];
  const flags = caseSensitive ? "g" : "gi";
  const re = new RegExp(escapeRegex(query), flags);
  const doc = root.ownerDocument!;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest(`mark.${MARK_CLASS}`)) return NodeFilter.FILTER_REJECT;
      if (p.closest("script,style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const texts: Text[] = [];
  let t: Node | null;
  while ((t = walker.nextNode())) texts.push(t as Text);

  for (const text of texts) {
    const str = text.nodeValue ?? "";
    re.lastIndex = 0;
    const parts: { s: number; e: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null) {
      parts.push({ s: m.index, e: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (parts.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let cursor = 0;
    for (const p of parts) {
      if (p.s > cursor) frag.appendChild(doc.createTextNode(str.slice(cursor, p.s)));
      const mark = doc.createElement("mark");
      mark.className = MARK_CLASS;
      mark.setAttribute(
        "style",
        "background:#fde68a;color:inherit;border-radius:2px;padding:0 1px;"
      );
      mark.textContent = str.slice(p.s, p.e);
      frag.appendChild(mark);
      marks.push(mark);
      cursor = p.e;
    }
    if (cursor < str.length) frag.appendChild(doc.createTextNode(str.slice(cursor)));
    text.parentNode?.replaceChild(frag, text);
  }
  return marks;
}

export function focusMark(mark: HTMLElement): void {
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.style.background = "#fb923c";
  setTimeout(() => {
    mark.style.background = "#fde68a";
  }, 700);
}

export function replaceMatches(
  root: Element,
  query: string,
  replacement: string,
  caseSensitive = false,
  onlyFirst = false
): number {
  const marks = highlightMatches(root, query, caseSensitive);
  const targets = onlyFirst ? marks.slice(0, 1) : marks;
  for (const m of targets) {
    m.replaceWith(root.ownerDocument!.createTextNode(replacement));
  }
  if (!onlyFirst) clearMarks(root);
  root.normalize();
  return targets.length;
}
