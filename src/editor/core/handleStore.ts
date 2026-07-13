import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "html-editor";
const STORE = "files";
const VERSION = 1;

export interface StoredHandle {
  id: string;
  name: string;
  handle: FileSystemFileHandle;
  lastOpened: number;
  sourceUrl?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "id" });
        }
      }
    });
  }
  return dbPromise;
}

export async function saveHandle(input: {
  name: string;
  handle: FileSystemFileHandle;
  sourceUrl?: string;
  id?: string;
}): Promise<string> {
  const d = await db();
  const existingByName = (await d.getAll(STORE)) as StoredHandle[];
  const existing = existingByName.find((h) => h.name === input.name);
  const id = input.id ?? existing?.id ?? crypto.randomUUID();
  const stored: StoredHandle = {
    id,
    name: input.name,
    handle: input.handle,
    sourceUrl: input.sourceUrl,
    lastOpened: Date.now()
  };
  await d.put(STORE, stored);
  return id;
}

export async function listRecent(limit = 10): Promise<StoredHandle[]> {
  const d = await db();
  const all = (await d.getAll(STORE)) as StoredHandle[];
  return all.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, limit);
}

export async function touchHandle(id: string): Promise<void> {
  const d = await db();
  const item = (await d.get(STORE, id)) as StoredHandle | undefined;
  if (item) {
    item.lastOpened = Date.now();
    await d.put(STORE, item);
  }
}

export async function removeHandle(id: string): Promise<void> {
  const d = await db();
  await d.delete(STORE, id);
}

interface PermissionDesc {
  mode: "read" | "readwrite";
}

interface HandleWithPermission {
  queryPermission(desc: PermissionDesc): Promise<PermissionState>;
  requestPermission(desc: PermissionDesc): Promise<PermissionState>;
}

export async function verifyPermission(
  handle: FileSystemFileHandle,
  write: boolean
): Promise<boolean> {
  const desc: PermissionDesc = { mode: write ? "readwrite" : "read" };
  const h = handle as unknown as HandleWithPermission;
  if ((await h.queryPermission(desc)) === "granted") return true;
  if ((await h.requestPermission(desc)) === "granted") return true;
  return false;
}
