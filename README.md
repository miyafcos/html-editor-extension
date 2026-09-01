# HTML Hub (html-editor-extension)

Chrome 拡張(Manifest V3)。ローカル HTML を扱う2機能を1拡張に統合:

1. **編集 (HTML Editor)** — Chrome で開いた見た目そのままに `contenteditable` で直接編集
2. **レポート管理 (Report Hub)** — 開いた file:// HTML を自動カタログ化+タブ整理 (2026-07-13 統合)

## Report Hub 機能 (`src/reporthub/` + `src/dashboard/` + `src/background/reporthub-sw.ts`)

- file://*.html を開いた瞬間に自動記録 (タイトル/パス/回数)。導入時に Chrome 履歴からバックフィル
- Side Panel「📚 レポート」タブ: 検索・最近・ピン留め・開いているタブ・タブセット保存/復元
- **ぐっとまとめる** `Ctrl+Shift+9` = 「レポート」タブグループへ集約+折りたたみ / `Ctrl+Shift+8` = 畳み展開
- ダッシュボード (フルページ): 案件別グルーピング・一括操作・存在確認 (消失検出)・JSON入出力・設定
- アイコンバッジ = 開いているレポートタブ数
- 実装ノート: 正規化キー (decode→NFC→小文字) で重複統合 / webNavigation の ERR_FILE_NOT_FOUND+navfail フラグで死活 /
  新規作成タブは tabs.query に載る前なので **タブIDを直接グループ化** (commit レース回避)

E2E: `scratchpad/report-hub-e2e/e2e-merged.mjs` (CDP・22項目。Chrome for Testing +
`--load-extension` + `--disable-features=DisableLoadExtensionCommandLineSwitch` が必要)

---

以下は編集 (HTML Editor) 側のドキュメント。

## 設計の核

- **iframe srcdoc に元HTMLをそのまま投入** — `@page` / `:root` 変数 / mm単位印刷レイアウトを汚染しない。
- **diff最小化** — 保存時は `<head>` 元バイト列を温存し、`<body>` 中身だけ置換。CRLF/LF/BOM 保持。
- **File System Access API** — `showOpenFilePicker` で開いたファイルにその場で上書き保存。同階層の画像は `showDirectoryPicker` で読み込み。

## 開発

```powershell
git clone https://github.com/miyafcos/html-editor-extension.git
cd html-editor-extension
npm install
npm run dev      # HMR 開発(dist/ に出力)
npm run build    # 本番ビルド
```

## Chrome への読み込み(開発モード)

1. `npm run build`
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」→ クローンしたリポジトリの `dist` フォルダを指定
5. 拡張アイコンをクリック → エディタタブが開く
6. 「開く」で `.html` ファイルを選ぶ → 編集 → `Ctrl+S` で上書き保存

`file://` 配下のHTMLを開く場合は、`chrome://extensions` の拡張詳細で「ファイルのURLへのアクセスを許可」を ON にする。

## バージョン

- v0.1: 開く・編集・上書き保存(現在)
- v0.2: Word 風ツールバー + 部品挿入パレット
- v0.3: 任意Webページ quick-edit(`.html` ダウンロード)
