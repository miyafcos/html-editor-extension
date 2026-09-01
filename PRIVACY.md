# Privacy Policy — HTML Hub

**Last updated: 2026-09-01**

## Summary

HTML Hub does not collect, transmit, or sell any user data.
Everything the extension stores stays in the browser's local storage on your own device.
There is no backend server, no analytics, no telemetry, and no third-party service of any kind.

## What the extension stores

All data below is written to `chrome.storage.local` on your device and never leaves it:

| Data | Why it is stored |
|---|---|
| URLs and titles of HTML documents you open (including `file://` paths) | To build the catalog of your local HTML documents |
| A short text excerpt and structure summary of those documents | To show a preview in the catalog list |
| Your grouping rules and display settings | To remember how you want the catalog organized |
| Saved tab sets | To reopen a group of documents later |

## What the extension reads but does not store

| API | Use |
|---|---|
| `chrome.history` | A one-time backfill when the extension is installed, to find local HTML documents you opened before installing. Read-only. History entries are never modified or deleted. |
| `chrome.bookmarks` | To display your existing bookmarks on the new tab page, so replacing the new tab page does not take away shortcuts you already had. Read-only. |
| `chrome.tabs` / `chrome.tabGroups` | To know which documents are open and to group or collapse their tabs on your command. |

## Network activity

The extension makes network requests in exactly two cases, both to documents you yourself opened:

1. Fetching a document you catalogued, to generate its preview and to check whether the file still exists.
2. Fetching the local HTML file being edited, to load it into the editor.

No request is ever made to a server operated by the developer or by any third party.
No page content, URL, or usage data is ever uploaded anywhere.

## Search

The search box on the new tab page calls `chrome.search.query()`, which hands the query to **the search engine you have already configured in Chrome**.
The extension does not change your default search engine, does not proxy your queries, and does not see or record search results.

## Remote code

The extension contains no remotely hosted code. It does not use `eval()` or `new Function()`, and it does not load scripts from any external server. All code ships inside the extension package.

## Permissions

A per-permission explanation is published in the repository at [`store/justifications.md`](store/justifications.md).

## Data deletion

Removing the extension from Chrome deletes everything it stored.
You can also clear the catalog at any time from the extension's settings screen.

## Changes to this policy

Any change will be published in this file with an updated date at the top.

## Contact

Contact: (to be filled in before publication)

---

# プライバシーポリシー — HTML Hub

**最終更新: 2026-09-01**

## 要約

HTML Hub は、利用者のデータを収集・送信・販売しません。
この拡張機能が保存するものはすべて、お使いの端末のブラウザ内ストレージに留まります。
サーバーもアナリティクスもテレメトリも第三者サービスも、一切使用していません。

## 保存する情報

以下はすべて端末上の `chrome.storage.local` に書き込まれ、外部に出ることはありません。

| 情報 | 保存する理由 |
|---|---|
| 開いた HTML 文書の URL とタイトル（`file://` のローカルパスを含む） | ローカル HTML 文書のカタログを作るため |
| それらの文書の短い抜粋と構造の要約 | カタログ一覧にプレビューを表示するため |
| グループ分けのルールと表示設定 | カタログの整理方法を記憶するため |
| 保存したタブセット | 文書のまとまりを後でまとめて開き直すため |

## 読み取るが保存しない情報

| API | 用途 |
|---|---|
| `chrome.history` | インストール時に一度だけ実行する初期取り込み。インストール以前に開いていたローカル HTML 文書を見つけるために使用します。読み取りのみで、履歴を変更・削除することはありません。 |
| `chrome.bookmarks` | 新しいタブページに既存のブックマークを表示するため。新しいタブページを置き換えても、それまで使えていたショートカットが失われないようにするためです。読み取りのみです。 |
| `chrome.tabs` / `chrome.tabGroups` | どの文書が開かれているかを把握し、利用者の操作に応じてタブをグループ化・折りたたむため。 |

## 通信

この拡張機能が通信を行うのは、利用者自身が開いた文書に対する次の 2 つの場合だけです。

1. カタログに登録された文書を取得し、プレビューの生成とファイルの存在確認を行うとき
2. 編集対象のローカル HTML ファイルをエディタに読み込むとき

開発者や第三者が運営するサーバーへのリクエストは一切行いません。
ページの内容・URL・利用状況が外部に送信されることはありません。

## 検索について

新しいタブページの検索ボックスは `chrome.search.query()` を呼び出します。これは、検索語を **Chrome で既に設定されている検索エンジン** にそのまま渡す仕組みです。
この拡張機能は既定の検索エンジンを変更しません。検索語を中継することも、検索結果を取得・記録することもありません。

## リモートコード

外部でホストされたコードは含まれていません。`eval()` や `new Function()` は使用せず、外部サーバーからスクリプトを読み込むこともありません。すべてのコードは拡張機能のパッケージ内に同梱されています。

## 権限

各権限の個別説明は、リポジトリ内の [`store/justifications.md`](store/justifications.md) に掲載しています。

## データの削除

Chrome から拡張機能を削除すると、保存されていた情報はすべて削除されます。
拡張機能の設定画面から、いつでもカタログを消去することもできます。

## 本ポリシーの変更

変更した場合は、このファイルに冒頭の日付を更新したうえで掲載します。

## 連絡先

連絡先: （公開前に記入）
