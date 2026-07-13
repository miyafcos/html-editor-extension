# html-editor-extension

Chrome 拡張(Manifest V3)で動く WYSIWYG HTML エディタ。
Chrome で開いた見た目そのままに、`contenteditable` で直接編集できる。

## 設計の核

- **iframe srcdoc に元HTMLをそのまま投入** — `@page` / `:root` 変数 / mm単位印刷レイアウトを汚染しない。
- **diff最小化** — 保存時は `<head>` 元バイト列を温存し、`<body>` 中身だけ置換。CRLF/LF/BOM 保持。
- **File System Access API** — `showOpenFilePicker` で開いたファイルにその場で上書き保存。同階層の画像は `showDirectoryPicker` で読み込み。

## 開発

```powershell
cd C:\Users\miyaz\html-editor-extension
npm install
npm run dev      # HMR 開発(dist/ に出力)
npm run build    # 本番ビルド
```

## Chrome への読み込み(開発モード)

1. `npm run build`
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」→ `C:\Users\miyaz\html-editor-extension\dist` を指定
5. 拡張アイコンをクリック → エディタタブが開く
6. 「開く」で `.html` ファイルを選ぶ → 編集 → `Ctrl+S` で上書き保存

`file://` 配下のHTMLを開く場合は、`chrome://extensions` の拡張詳細で「ファイルのURLへのアクセスを許可」を ON にする。

## バージョン

- v0.1: 開く・編集・上書き保存(現在)
- v0.2: Word 風ツールバー + 部品挿入パレット
- v0.3: 任意Webページ quick-edit(`.html` ダウンロード)
