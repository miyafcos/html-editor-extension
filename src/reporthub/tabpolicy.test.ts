const { default: assert } = await import("node:" + "assert/strict");
const { default: test } = await import("node:" + "test");

const policy: typeof import("./tabpolicy") = await import(new URL("./tabpolicy.ts", import.meta.url).href);

const {
  TAB_GROUP_ID_NONE,
  addChanged,
  addFailure,
  addSkip,
  classifyKind,
  closeProtectionReason,
  duplicateLooseKey,
  duplicateStrictKey,
  emptyResult,
  hubGroupTitle,
  ownedGroupIds,
  parseHubGroupTitle,
  planGroupAssignment,
  planDuplicateClose,
  reconcileRegistry
} = policy;

type CloseCandidateTab = import("./tabpolicy").CloseCandidateTab;

function tab(id: number, url: string, overrides: Partial<CloseCandidateTab> = {}): CloseCandidateTab {
  return {
    id,
    url,
    active: false,
    pinned: false,
    windowId: 1,
    groupId: TAB_GROUP_ID_NONE,
    lastAccessed: id,
    ...overrides
  };
}

function context(overrides: Partial<Parameters<typeof planDuplicateClose>[1]> = {}) {
  return {
    hubTabId: 999,
    ownedGroupIds: new Set<number>(),
    editingByTabId: new Map<number, "yes" | "no" | "unknown">(),
    kindScope: "all" as const,
    ...overrides
  };
}

test("classifyKind classifies only supported URL spellings", () => {
  assert.equal(classifyKind("file:///C:/report.HTML"), "html");
  assert.equal(classifyKind("file:///C:/report.pdf"), "pdf");
  assert.equal(classifyKind("https://x.test/report.pdf?download=1"), "pdf");
  assert.equal(classifyKind("https://x.test/report"), "web");
  assert.equal(classifyKind("blob:https://x.test/id"), null);
  assert.equal(classifyKind("chrome://settings/"), null);
});

const URL_CASES = [
  ["https://x.test/app#/orders", "https://x.test/app#/users", false, false],
  ["https://x.test/doc#section-3", "https://x.test/doc#section-9", false, false],
  ["file:///C:/r/a.html?view=table", "file:///C:/r/a.html?view=chart", false, false],
  ["https://x.test/Doc", "https://x.test/doc", false, false],
  ["https://x.test/foo", "https://x.test/foo/", false, false],
  ["https://X.TEST/foo", "https://x.test/foo", true, true],
  ["https://x.test/a?utm_source=x", "https://x.test/a", false, true],
  ["https://x.test/a?b=1&c=2", "https://x.test/a?c=2&b=1", false, false]
] as const;

test("duplicate keys preserve destructive-operation distinctions", () => {
  for (const [left, right, sameStrict, sameLoose] of URL_CASES) {
    assert.equal(duplicateStrictKey(left) === duplicateStrictKey(right), sameStrict, `strict: ${left} / ${right}`);
    assert.equal(duplicateLooseKey(left) === duplicateLooseKey(right), sameLoose, `loose: ${left} / ${right}`);
  }
  assert.equal(duplicateStrictKey("chrome://settings/"), null);
  assert.equal(duplicateLooseKey("data:text/plain,test"), null);
});

test("closeProtectionReason protects every unsafe condition", () => {
  const safe = tab(1, "https://x.test/a");
  const base = { hubTabId: 99, ownedGroupIds: new Set([7]), editing: "no" as const };
  assert.equal(closeProtectionReason(safe, base), null);
  assert.equal(closeProtectionReason(tab(2, safe.url, { active: true }), base), "active");
  assert.equal(closeProtectionReason(tab(3, safe.url, { pinned: true }), base), "pinned");
  assert.equal(closeProtectionReason(tab(4, safe.url, { audible: true }), base), "audible");
  assert.equal(closeProtectionReason(tab(5, safe.url, { pendingUrl: "https://x.test/b" }), base), "navigating");
  assert.equal(closeProtectionReason(tab(99, safe.url), base), "hub-tab");
  assert.equal(closeProtectionReason(tab(6, safe.url, { groupId: 8 }), base), "foreign-group");
  assert.equal(closeProtectionReason(safe, { ...base, editing: "yes" }), "editing");
  assert.equal(closeProtectionReason(safe, { ...base, editing: "unknown" }), "editing-unknown");
});

test("duplicate plans retain protected tabs and only close unprotected duplicates", () => {
  const tabs = [
    tab(1, "https://x.test/a", { pinned: true, lastAccessed: 1 }),
    tab(2, "https://x.test/a", { audible: true, lastAccessed: 4 }),
    tab(3, "https://x.test/a", { lastAccessed: 3 })
  ];
  const plan = planDuplicateClose(tabs, context({ editingByTabId: new Map([[1, "no"], [2, "no"], [3, "no"]]) }));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].match, "strict");
  assert.deepEqual(plan[0].protectedTabs.map(({ tab: protectedTab }) => protectedTab.id), [1, 2]);
  assert.deepEqual(plan[0].close.map((candidate) => candidate.id), [3]);
});

test("every protected condition remains out of a duplicate close plan", () => {
  const normalEditing = () => new Map<number, "yes" | "no" | "unknown">([[1, "no"], [2, "no"]]);
  const cases: Array<{
    label: string;
    protectedTab: CloseCandidateTab;
    ctx: ReturnType<typeof context>;
  }> = [
    { label: "pinned", protectedTab: tab(1, "https://x.test/a", { pinned: true }), ctx: context({ editingByTabId: normalEditing() }) },
    { label: "audible", protectedTab: tab(1, "https://x.test/a", { audible: true }), ctx: context({ editingByTabId: normalEditing() }) },
    { label: "navigating", protectedTab: tab(1, "https://x.test/a", { pendingUrl: "https://x.test/next" }), ctx: context({ editingByTabId: normalEditing() }) },
    { label: "hub tab", protectedTab: tab(1, "https://x.test/a"), ctx: context({ hubTabId: 1, editingByTabId: normalEditing() }) },
    { label: "foreign group", protectedTab: tab(1, "https://x.test/a", { groupId: 7 }), ctx: context({ editingByTabId: normalEditing() }) },
    {
      label: "unknown editing",
      protectedTab: tab(1, "https://x.test/a"),
      ctx: context({ editingByTabId: new Map([[1, "unknown"], [2, "no"]]) })
    }
  ];
  for (const { label, protectedTab, ctx } of cases) {
    const plan = planDuplicateClose([protectedTab, tab(2, protectedTab.url)], ctx);
    assert.ok(plan[0].protectedTabs.some(({ tab: candidate }) => candidate.id === 1), label);
    assert.ok(!plan[0].close.some((candidate) => candidate.id === 1), label);
  }
});

test("duplicate plans keep the most recently accessed tab, then the smallest id", () => {
  const recent = planDuplicateClose(
    [tab(3, "https://x.test/a", { lastAccessed: 10 }), tab(2, "https://x.test/a", { lastAccessed: 20 })],
    context({ editingByTabId: new Map([[2, "no"], [3, "no"]]) })
  )[0];
  assert.equal(recent.keep.id, 2);

  const tied = planDuplicateClose(
    [tab(4, "https://x.test/b", { lastAccessed: 10 }), tab(1, "https://x.test/b", { lastAccessed: 10 })],
    context({ editingByTabId: new Map([[1, "no"], [4, "no"]]) })
  )[0];
  assert.equal(tied.keep.id, 1);
});

test("duplicate plans respect kind scope and never combine kinds", () => {
  const tabs = [
    tab(1, "https://x.test/a.html"),
    tab(2, "https://x.test/a.html"),
    tab(3, "file:///C:/a.html"),
    tab(4, "file:///C:/a.html"),
    tab(5, "https://x.test/a.pdf"),
    tab(6, "https://x.test/a.pdf")
  ];
  const editingByTabId = new Map(tabs.map((candidate) => [candidate.id, "no" as const]));
  const all = planDuplicateClose(tabs, context({ editingByTabId }));
  assert.deepEqual(all.map((group) => group.kind), ["web", "html", "pdf"]);
  const pdf = planDuplicateClose(tabs, context({ editingByTabId, kindScope: "pdf" }));
  assert.deepEqual(pdf.map((group) => group.kind), ["pdf"]);
});

test("loose plans are separate from strict plans and require distinct strict keys", () => {
  const tabs = [
    tab(1, "https://x.test/a?utm_source=one"),
    tab(2, "https://x.test/a"),
    tab(3, "https://x.test/a?utm_source=one")
  ];
  const plan = planDuplicateClose(tabs, context({ editingByTabId: new Map(tabs.map(({ id }) => [id, "no" as const])) }));
  assert.deepEqual(plan.map((group) => group.match), ["strict", "loose"]);
  assert.deepEqual(plan[0].close.map(({ id }) => id), [1]);
  assert.equal(plan[1].close.length, 2);
});

test("operation result helpers preserve structured partial results", () => {
  const result = emptyResult();
  addChanged(result, 2);
  addSkip(result, "pinned");
  addSkip(result, "pinned", 2);
  addFailure(result, 41, "gone");
  assert.deepEqual(result, {
    changed: 2,
    skipped: [{ reason: "pinned", count: 3 }],
    failed: [{ tabId: 41, reason: "gone" }]
  });
});

test("hub group titles are namespaced and parse only exact managed titles", () => {
  assert.equal(hubGroupTitle("web"), "Hub · Web");
  assert.equal(parseHubGroupTitle("Hub · Web"), "web");
  assert.equal(parseHubGroupTitle("Web"), null);
  assert.equal(parseHubGroupTitle("Hub · web"), null);
});

test("reconcileRegistry drops gone and renamed group records", () => {
  const registry = {
    groups: { web: 11, html: 12, pdf: 13 },
    lastOrganizedAt: { web: 1, html: 2, pdf: 3 }
  };
  const result = reconcileRegistry(registry, [
    { id: 11, title: "Hub · Web", collapsed: true },
    { id: 12, title: "Manual HTML", collapsed: false }
  ]);

  assert.deepEqual(result.registry, {
    groups: { web: 11 },
    lastOrganizedAt: { web: 1 }
  });
  assert.deepEqual(result.dropped, [
    { kind: "html", groupId: 12, reason: "renamed" },
    { kind: "pdf", groupId: 13, reason: "gone" }
  ]);
  assert.deepEqual(ownedGroupIds(result.registry), new Set([11]));
});

test("group assignment protects non-managed tabs and respects kind scope", () => {
  const registry = {
    groups: { web: 11, html: 12 },
    lastOrganizedAt: {}
  };
  const plan = planGroupAssignment(
    [
      { id: 1, url: "https://x.test/a", pinned: true, groupId: -1 },
      { id: 2, url: "https://x.test/hub", pinned: false, groupId: -1 },
      { id: 3, url: "chrome://settings/", pinned: false, groupId: -1 },
      { id: 4, url: "https://x.test/manual", pinned: false, groupId: 44 },
      { id: 5, url: "https://x.test/already", pinned: false, groupId: 11 },
      { id: 6, url: "file:///C:/report.html", pinned: false, groupId: 12 },
      { id: 7, url: "https://x.test/move", pinned: false, groupId: -1 },
      { id: 8, url: "https://x.test/file.pdf", pinned: false, groupId: -1 },
      { id: 9, url: "https://x.test/reassign", pinned: false, groupId: 12 }
    ],
    { hubTabId: 2, registry, kindScope: "web" }
  );

  assert.deepEqual(plan.assign, { web: [7, 9], html: [], pdf: [] });
  assert.deepEqual(plan.skipped, [
    { tabId: 1, reason: "pinned" },
    { tabId: 2, reason: "hub-tab" },
    { tabId: 3, reason: "unsupported" },
    { tabId: 4, reason: "foreign-group" },
    { tabId: 5, reason: "already" },
    { tabId: 6, reason: "out-of-scope" },
    { tabId: 8, reason: "out-of-scope" }
  ]);
});
