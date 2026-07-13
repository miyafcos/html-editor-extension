const ALLOWED_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "background",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-align",
  "vertical-align",
  "padding",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-bottom",
  "border",
  "border-radius",
  "width",
  "height",
  "display",
  "list-style"
]);

function filterStyle(value: string): string {
  return value
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      if (!d) return false;
      const [keyRaw] = d.split(":");
      if (!keyRaw) return false;
      const key = keyRaw.trim().toLowerCase();
      if (key.startsWith("mso-")) return false;
      return ALLOWED_STYLE_PROPS.has(key);
    })
    .join("; ");
}

const OFFICE_TAG_PREFIXES = ["o:", "w:", "v:", "x:", "m:"];

function isOfficeTag(tag: string): boolean {
  return OFFICE_TAG_PREFIXES.some((p) => tag.startsWith(p));
}

export function shouldClean(html: string): boolean {
  return /mso-|<o:|<w:|<v:|class="?Mso|font-family:[^;"]*Calibri|font-family:[^;"]*"Times New Roman"/i.test(
    html
  );
}

export function cleanPastedHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;

  const toRemove: Element[] = [];
  body.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (isOfficeTag(tag) || tag === "meta" || tag === "link" || tag === "style" || tag === "script") {
      toRemove.push(el);
      return;
    }
    if (tag === "font") {
      const parent = el.parentNode;
      while (el.firstChild) parent?.insertBefore(el.firstChild, el);
      el.remove();
      return;
    }
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (
        name === "class" ||
        name === "lang" ||
        name === "id" ||
        name.startsWith("mso-") ||
        name.startsWith("v:") ||
        name.startsWith("o:") ||
        name.startsWith("xml:") ||
        name.startsWith("data-mce-")
      ) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const filtered = filterStyle(attr.value);
        if (filtered) el.setAttribute("style", filtered);
        else el.removeAttribute("style");
      }
    }
  });
  toRemove.forEach((el) => el.remove());

  // remove HTML comments
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let c: Node | null;
  while ((c = walker.nextNode())) comments.push(c);
  comments.forEach((node) => node.parentNode?.removeChild(node));

  return body.innerHTML.trim();
}
