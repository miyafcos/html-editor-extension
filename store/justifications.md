# Chrome Web Store — Permission justifications

Paste each block into the matching field of the **Privacy practices** tab in the
Developer Dashboard. Keep the wording; the review team reads these verbatim.

---

## Single purpose description

HTML Hub is a workspace for local HTML documents. It keeps a catalog of the HTML
files the user opens, lets them find and reopen those files from the new tab
page, organizes the corresponding browser tabs into a single collapsible group,
and lets the user edit any of those documents in place and save the result back
to disk. Every feature serves that one purpose: working with the HTML files that
live on the user's own machine.

---

## Why the new tab page is overridden

The catalog IS the extension's primary interface, and the new tab page is where
the user reaches for it. Replacing the new tab page with the catalog is the
feature, not a side effect of another feature.

Three things this override deliberately does NOT do:

1. **It does not change the default search engine.** The search box calls
   `chrome.search.query({ text, disposition: "CURRENT_TAB" })`, which hands the
   query to whichever search engine the user has already configured in Chrome.
   The extension never sees or records results.
2. **It does not remove existing shortcuts.** The user's bookmark bar is
   rendered on the page (read-only, via `chrome.bookmarks.getTree()`), so
   replacing the new tab page does not take away access the user already had.
3. **It shows no ads, no sponsored links, and no remote content.** The page is
   rendered entirely from data in `chrome.storage.local`. It makes no request to
   any server operated by the developer or by a third party.

---

## Host permission justification — `<all_urls>`

The editor and the catalog have to work on whatever HTML document the user
chooses to open. In practice that means `file:///` paths on the user's own disk,
plus HTML pages served from arbitrary hosts — local dev servers, intranet
report servers, static site previews. There is no fixed list of hosts that would
cover this, because the whole point is that the user decides which document to
work on.

The extension acts only on documents the user explicitly opens or explicitly
chooses to edit. It does not read, collect, or transmit page content from sites
the user is merely browsing, and it sends nothing to any server.

The content script is already narrowed beyond `<all_urls>`: it is injected only
into `file:///*`, `*://*/*.html*` and `*://*/*.htm*`.

---

## `storage`

Stores the catalog of HTML documents the user has opened (URL, title, a short
excerpt for the preview), their grouping rules, display settings, and saved tab
sets. Written to `chrome.storage.local` on the user's device only. Nothing is
synced or transmitted.

## `activeTab`

Lets the user start editing the HTML document in the tab they are currently
viewing, triggered by an explicit action (toolbar button or keyboard command).

## `sidePanel`

The catalog list and the editing controls are presented in Chrome's side panel.

## `downloads`

Saves the edited HTML back to disk. Extensions cannot write to `file://`
directly, so the edited document is delivered through the downloads API.

## `scripting`

Injects the in-place editing toolbar into the HTML document the user chose to
edit.

## `tabs`

Reads which HTML documents are currently open so the catalog reflects the real
state of the window and so tabs can be grouped correctly. URLs are read locally
and are never transmitted.

## `tabGroups`

Powers the core "gather and collapse" feature: the user's HTML document tabs are
collected into a single tab group that can be collapsed and expanded
(Ctrl+Shift+9 / Ctrl+Shift+8).

## `history`

Used once, on install, to backfill the catalog with local HTML documents the
user had already opened before installing the extension — otherwise the catalog
starts empty and the extension appears broken. Read-only via
`chrome.history.search()` and `chrome.history.getVisits()`. History entries are
never created, modified, or deleted, and history data is never transmitted.

## `webNavigation`

Detects when a `file://` document fails to load, so the catalog can mark that
entry as missing (the file was moved or deleted) instead of leaving a dead link
in the list.

## `alarms`

Schedules the periodic, low-frequency liveness check that verifies catalogued
files still exist on disk.

## `search`

Provides the search box on the new tab page. It calls `chrome.search.query()`,
which delegates to the user's own configured search engine. The extension does
not change, proxy, or record searches.

## `bookmarks`

Renders the user's existing bookmarks on the new tab page so that replacing the
new tab page does not remove shortcut access they previously had. Read-only via
`chrome.bookmarks.getTree()`; bookmarks are never created, modified, or deleted.

## `favicon`

Displays each catalogued document's own icon in the catalog list.

---

## Data usage disclosures (checkbox section)

Declare the following:

- **Personally identifiable information** — No
- **Health information** — No
- **Financial and payment information** — No
- **Authentication information** — No
- **Personal communications** — No
- **Location** — No
- **Web history** — **Yes.** The extension reads browsing history once at
  install time to backfill its catalog with local HTML documents, and stores the
  URLs of documents the user opens. All of it stays in `chrome.storage.local` on
  the user's device and is never transmitted.
- **User activity** — No
- **Website content** — **Yes.** A short text excerpt of each catalogued HTML
  document is stored locally to render its preview. It is never transmitted.

Then check all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Note to reviewer (optional field)

The full source is available at
https://github.com/miyafcos/html-editor-extension — the uploaded package is the
output of `npm run build` (Vite + @crxjs) from the tagged commit. The bundle is
minified but not obfuscated, and contains no remotely hosted code.
