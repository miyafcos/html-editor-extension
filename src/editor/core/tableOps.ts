export interface TableContext {
  table: HTMLTableElement;
  cell: HTMLTableCellElement;
  row: HTMLTableRowElement;
  rowIndex: number;
  colIndex: number;
}

export function findCell(node: Node | null): TableContext | null {
  let n: Node | null = node;
  while (n && n.nodeType !== 1) n = n.parentNode;
  let el = n as Element | null;
  while (el) {
    if (el.tagName === "TD" || el.tagName === "TH") break;
    el = el.parentElement;
  }
  if (!el) return null;
  const cell = el as HTMLTableCellElement;
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!row) return null;
  const table = cell.closest("table") as HTMLTableElement | null;
  if (!table) return null;
  const cells = Array.from(row.children);
  const colIndex = cells.indexOf(cell);
  const rows = Array.from(row.parentElement!.children);
  const rowIndex = rows.indexOf(row);
  return { table, cell, row, rowIndex, colIndex };
}

export function placeCaretIn(cell: HTMLElement, win: Window): void {
  const range = win.document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = win.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function emptyCell(c: Element): void {
  (c as HTMLElement).innerHTML = "";
}

export function moveCell(ctx: TableContext, dir: "next" | "prev"): HTMLTableCellElement | null {
  const cells = Array.from(ctx.row.children) as HTMLTableCellElement[];
  if (dir === "next") {
    if (ctx.colIndex + 1 < cells.length) return cells[ctx.colIndex + 1];
    const next = ctx.row.nextElementSibling as HTMLTableRowElement | null;
    if (next) return next.children[0] as HTMLTableCellElement;
    const tbody = ctx.row.parentElement;
    if (!tbody) return null;
    const newRow = ctx.row.cloneNode(true) as HTMLTableRowElement;
    newRow.querySelectorAll("th,td").forEach(emptyCell);
    tbody.appendChild(newRow);
    return newRow.children[0] as HTMLTableCellElement;
  } else {
    if (ctx.colIndex > 0) return cells[ctx.colIndex - 1];
    const prev = ctx.row.previousElementSibling as HTMLTableRowElement | null;
    if (prev) return prev.children[prev.children.length - 1] as HTMLTableCellElement;
    return null;
  }
}

export function addRowAfter(ctx: TableContext): HTMLTableRowElement {
  const tbody = ctx.row.parentElement!;
  const newRow = ctx.row.cloneNode(true) as HTMLTableRowElement;
  newRow.querySelectorAll("th,td").forEach(emptyCell);
  // clone may have th instead of td; convert to td for body rows
  if (tbody.tagName === "TBODY") {
    newRow.querySelectorAll("th").forEach((th) => {
      const td = th.ownerDocument!.createElement("td");
      Array.from(th.attributes).forEach((a) => td.setAttribute(a.name, a.value));
      td.innerHTML = th.innerHTML;
      th.replaceWith(td);
    });
  }
  tbody.insertBefore(newRow, ctx.row.nextSibling);
  return newRow;
}

export function addRowBefore(ctx: TableContext): HTMLTableRowElement {
  const tbody = ctx.row.parentElement!;
  const newRow = ctx.row.cloneNode(true) as HTMLTableRowElement;
  newRow.querySelectorAll("th,td").forEach(emptyCell);
  tbody.insertBefore(newRow, ctx.row);
  return newRow;
}

export function deleteRow(ctx: TableContext): void {
  if (ctx.table.querySelectorAll("tr").length <= 1) return;
  ctx.row.remove();
}

export function addColumnAfter(ctx: TableContext): void {
  const rows = ctx.table.querySelectorAll("tr");
  rows.forEach((r) => {
    const cells = r.children;
    if (cells.length === 0) return;
    const refIndex = Math.min(ctx.colIndex, cells.length - 1);
    const ref = cells[refIndex] as HTMLTableCellElement;
    const newCell = ref.cloneNode(false) as HTMLTableCellElement;
    newCell.innerHTML = "";
    if (cells.length > ctx.colIndex + 1) {
      r.insertBefore(newCell, cells[ctx.colIndex + 1]);
    } else {
      r.appendChild(newCell);
    }
  });
}

export function addColumnBefore(ctx: TableContext): void {
  const rows = ctx.table.querySelectorAll("tr");
  rows.forEach((r) => {
    const cells = r.children;
    if (cells.length === 0) return;
    const refIndex = Math.min(ctx.colIndex, cells.length - 1);
    const ref = cells[refIndex] as HTMLTableCellElement;
    const newCell = ref.cloneNode(false) as HTMLTableCellElement;
    newCell.innerHTML = "";
    r.insertBefore(newCell, cells[ctx.colIndex] ?? null);
  });
}

export function deleteColumn(ctx: TableContext): void {
  const rows = ctx.table.querySelectorAll("tr");
  let removedAny = false;
  rows.forEach((r) => {
    if (r.children.length <= 1) return;
    const cell = r.children[ctx.colIndex];
    if (cell) {
      cell.remove();
      removedAny = true;
    }
  });
  if (!removedAny) return;
}

export function handleTableKeydown(e: KeyboardEvent, win: Window): boolean {
  const sel = win.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const ctx = findCell(sel.getRangeAt(0).startContainer);
  if (!ctx) return false;
  if (e.key === "Tab") {
    e.preventDefault();
    const next = moveCell(ctx, e.shiftKey ? "prev" : "next");
    if (next) placeCaretIn(next, win);
    return true;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
    // セル内では <br> 改行に統一(<div> ラップを防ぐ)
    e.preventDefault();
    win.document.execCommand("insertLineBreak");
    return true;
  }
  return false;
}
