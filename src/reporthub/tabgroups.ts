import type { HubGroupRegistry, HubKind } from "./tabpolicy";

const STORAGE_KEY_PREFIX = "hubGroups:";
const HUB_KINDS: readonly HubKind[] = ["web", "html", "pdf"];

function registryFromStorage(value: unknown): HubGroupRegistry {
  const stored = value as { groups?: unknown; lastOrganizedAt?: unknown } | undefined;
  const groups: Partial<Record<HubKind, number>> = {};
  const lastOrganizedAt: Partial<Record<HubKind, number>> = {};

  for (const kind of HUB_KINDS) {
    const groupId = (stored?.groups as Record<string, unknown> | undefined)?.[kind];
    if (typeof groupId === "number" && Number.isInteger(groupId)) groups[kind] = groupId;

    const organizedAt = (stored?.lastOrganizedAt as Record<string, unknown> | undefined)?.[kind];
    if (typeof organizedAt === "number" && Number.isFinite(organizedAt)) lastOrganizedAt[kind] = organizedAt;
  }

  return { groups, lastOrganizedAt };
}

function storageKey(windowId: number): string {
  return `${STORAGE_KEY_PREFIX}${windowId}`;
}

export async function loadRegistry(windowId: number): Promise<HubGroupRegistry> {
  const key = storageKey(windowId);
  const stored = await chrome.storage.session.get(key);
  return registryFromStorage(stored[key]);
}

export async function saveRegistry(windowId: number, registry: HubGroupRegistry): Promise<void> {
  await chrome.storage.session.set({ [storageKey(windowId)]: registry });
}

export async function markOrganized(windowId: number, kind: HubKind, at: number): Promise<void> {
  const registry = await loadRegistry(windowId);
  await saveRegistry(windowId, {
    groups: { ...registry.groups },
    lastOrganizedAt: { ...registry.lastOrganizedAt, [kind]: at }
  });
}
