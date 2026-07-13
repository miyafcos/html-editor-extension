function fileExtFromMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  return ".bin";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function saveToAssetsDir(
  blob: Blob,
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  const buf = new ArrayBuffer(blob.size);
  const view = new Uint8Array(buf);
  view.set(new Uint8Array(await blob.arrayBuffer()));
  await writable.write(buf);
  await writable.close();
}

function genFilename(mime: string): string {
  const ext = fileExtFromMime(mime);
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `img_${ts}_${rand}${ext}`;
}

export interface InsertImageContext {
  assetsDir: FileSystemDirectoryHandle | null;
}

export async function buildImageHtml(
  blob: Blob,
  ctx: InsertImageContext
): Promise<string> {
  let src: string;
  let originalSrc: string | undefined;
  if (ctx.assetsDir) {
    try {
      const filename = genFilename(blob.type);
      await saveToAssetsDir(blob, ctx.assetsDir, filename);
      src = URL.createObjectURL(blob);
      originalSrc = `./${filename}`;
    } catch (e) {
      console.warn("saveToAssetsDir failed, fallback to base64", e);
      src = await blobToBase64(blob);
    }
  } else {
    src = await blobToBase64(blob);
  }
  if (originalSrc) {
    return `<img src="${src}" data-orig-src="${originalSrc}" alt="" style="max-width:100%;" />`;
  }
  return `<img src="${src}" alt="" style="max-width:100%;" />`;
}

export async function extractImageFromPaste(e: ClipboardEvent): Promise<File | null> {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function extractImagesFromDrop(e: DragEvent): File[] {
  const out: File[] = [];
  const files = e.dataTransfer?.files;
  if (!files) return out;
  for (const f of files) {
    if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}
