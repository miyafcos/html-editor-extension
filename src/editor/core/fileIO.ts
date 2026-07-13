export interface OpenResult {
  handle: FileSystemFileHandle;
  buffer: ArrayBuffer;
  name: string;
}

export async function openHtmlFile(): Promise<OpenResult | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }],
      multiple: false,
      excludeAcceptAllOption: false
    });
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    return { handle, buffer, name: file.name };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function saveHtmlFile(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const writable = await handle.createWritable();
  await writable.write(buf);
  await writable.close();
}

export async function saveAsHtmlFile(
  bytes: Uint8Array,
  suggestedName: string
): Promise<FileSystemFileHandle | null> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }]
    });
    await saveHtmlFile(handle, bytes);
    return handle;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function pickAssetsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker({ mode: "read" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function readDirectoryFile(
  dir: FileSystemDirectoryHandle,
  relativePath: string
): Promise<File | null> {
  const cleaned = relativePath.replace(/^\.\//, "").replace(/^\//, "");
  const parts = cleaned.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) return null;
  let current: FileSystemDirectoryHandle = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "..") return null;
    try {
      current = await current.getDirectoryHandle(parts[i]);
    } catch {
      return null;
    }
  }
  try {
    const fileHandle = await current.getFileHandle(parts[parts.length - 1]);
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}
