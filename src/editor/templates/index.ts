export interface TemplateDef {
  id: string;
  label: string;
  description: string;
  html: string;
}

const HEAD_STYLE = `<style>:root{--ink:#111827;--muted:#6b7280;--accent:#2563eb;--bg:#ffffff;--surface:#f9fafb;--border:#e5e7eb;}html,body{margin:0;padding:0;font-family:"Yu Gothic UI","Meiryo",sans-serif;color:var(--ink);background:var(--bg);}body{padding:24px;line-height:1.7;}h1{font-size:24px;margin-top:0;border-bottom:2px solid var(--accent);padding-bottom:8px;}h2{font-size:18px;margin-top:24px;border-left:4px solid var(--accent);padding-left:8px;}h3{font-size:15px;margin-top:16px;}table{border-collapse:collapse;width:100%;margin:12px 0;}th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top;}th{background:var(--surface);font-weight:600;}.badge{display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;color:#fff;font-weight:600;}.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin:8px 0;}blockquote{margin:16px 0;padding:12px 16px;border-left:4px solid var(--accent);background:#eff6ff;color:#1e3a8a;border-radius:0 4px 4px 0;}</style>`;

const head = (title: string) =>
  `<!DOCTYPE html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n<title>${title}</title>\n${HEAD_STYLE}\n</head>\n`;

const SHINCHOKU =
  head("進捗管理表") +
  `<body>
<h1>案件進捗サマリ</h1>
<p>更新日: <span>2026-MM-DD</span> / 担当: <span>記入</span></p>

<h2>本日のフォーカス</h2>
<ul>
  <li>項目1</li>
  <li>項目2</li>
  <li>項目3</li>
</ul>

<h2>進捗一覧</h2>
<table>
  <thead>
    <tr><th style="width:30%;">案件</th><th style="width:20%;">状態</th><th>担当</th><th style="width:15%;">期日</th></tr>
  </thead>
  <tbody>
    <tr><td>案件A</td><td><span class="badge" style="background:#16a34a;">進行中</span></td><td>担当者名</td><td>MM/DD</td></tr>
    <tr><td>案件B</td><td><span class="badge" style="background:#dc2626;">要対応</span></td><td>担当者名</td><td>MM/DD</td></tr>
    <tr><td>案件C</td><td><span class="badge" style="background:#6b7280;">保留</span></td><td>担当者名</td><td>MM/DD</td></tr>
  </tbody>
</table>

<h2>振り返り</h2>
<blockquote>所感や次のアクションを記入。</blockquote>
</body>
</html>`;

const DRILL_A4 =
  head("教材ドリル") +
  `<body style="background:#f3f4f6;">
<style>@page{size:A4;margin:15mm;}.page{width:210mm;min-height:297mm;background:#fff;margin:0 auto 12px;padding:15mm;box-sizing:border-box;page-break-after:always;}@media print{body{background:#fff;}.page{margin:0;box-shadow:none;}}</style>

<div class="page">
  <h1>第1回 計算ドリル</h1>
  <p>名前 <span style="display:inline-block;border-bottom:1px solid #111;width:160px;">&nbsp;</span>　日付 <span style="display:inline-block;border-bottom:1px solid #111;width:60px;">&nbsp;</span> 月 <span style="display:inline-block;border-bottom:1px solid #111;width:60px;">&nbsp;</span> 日</p>

  <h2>1. 基本問題</h2>
  <ol>
    <li>3 + 5 = ____</li>
    <li>12 − 7 = ____</li>
    <li>4 × 6 = ____</li>
    <li>18 ÷ 3 = ____</li>
  </ol>

  <h2>2. 応用</h2>
  <p>下の図を見て答えなさい。</p>
  <p>(図版エリア)</p>
</div>
</body>
</html>`;

const EIGYO =
  head("営業資料") +
  `<body>
<h1>サービス提案書</h1>
<blockquote>本資料は、貴社の業務課題に対する提案です。要点を3つに絞ってお伝えします。</blockquote>

<h2>1. 課題認識</h2>
<div class="card">
  <h3>現状</h3>
  <p>現状の課題を記述します。</p>
</div>
<div class="card">
  <h3>背景</h3>
  <p>背景を記述します。</p>
</div>

<h2>2. 提案内容</h2>
<ol>
  <li>提案1</li>
  <li>提案2</li>
  <li>提案3</li>
</ol>

<h2>3. スケジュール</h2>
<table>
  <thead><tr><th>フェーズ</th><th>期間</th><th>成果物</th></tr></thead>
  <tbody>
    <tr><td>要件定義</td><td>2週間</td><td>仕様書</td></tr>
    <tr><td>開発</td><td>4週間</td><td>動作する成果物</td></tr>
    <tr><td>納品</td><td>1週間</td><td>マニュアル</td></tr>
  </tbody>
</table>
</body>
</html>`;

const KENSA =
  head("検査レポート") +
  `<body>
<h1>確認結果レポート</h1>
<p>対象: <span>ファイル名</span> / 日付: 2026-MM-DD / 担当: <span>記入</span></p>

<h2>サマリ</h2>
<div style="display:flex;gap:12px;margin:12px 0;">
  <div style="flex:1;padding:12px;background:#dcfce7;border-radius:8px;text-align:center;">
    <div style="font-size:24px;font-weight:700;color:#14532d;">N</div>
    <div style="color:#14532d;">OK</div>
  </div>
  <div style="flex:1;padding:12px;background:#fee2e2;border-radius:8px;text-align:center;">
    <div style="font-size:24px;font-weight:700;color:#7f1d1d;">N</div>
    <div style="color:#7f1d1d;">要修正</div>
  </div>
</div>

<h2>詳細</h2>
<table>
  <thead><tr><th>項目</th><th>判定</th><th>備考</th></tr></thead>
  <tbody>
    <tr><td>項目1</td><td><span class="badge" style="background:#16a34a;">OK</span></td><td></td></tr>
    <tr><td>項目2</td><td><span class="badge" style="background:#dc2626;">NG</span></td><td>修正必要</td></tr>
  </tbody>
</table>

<h2>所感</h2>
<blockquote>総評をここに。</blockquote>
</body>
</html>`;

const MANUAL =
  head("運用マニュアル") +
  `<body style="display:grid;grid-template-columns:200px 1fr;gap:24px;max-width:1100px;margin:0 auto;">
<nav style="position:sticky;top:0;align-self:start;padding:16px;background:var(--surface);border-radius:8px;border:1px solid var(--border);">
  <h3 style="margin-top:0;">目次</h3>
  <ul style="list-style:none;padding:0;line-height:1.8;">
    <li><a href="#s1">1. 概要</a></li>
    <li><a href="#s2">2. 手順</a></li>
    <li><a href="#s3">3. トラブル時</a></li>
  </ul>
</nav>
<main>
  <h1>運用マニュアル</h1>
  <h2 id="s1">1. 概要</h2>
  <p>本マニュアルは、〜の運用を説明します。</p>

  <h2 id="s2">2. 手順</h2>
  <ol>
    <li>手順1</li>
    <li>手順2</li>
    <li>手順3</li>
  </ol>

  <h2 id="s3">3. トラブル時</h2>
  <div class="card">
    <h3>症状A</h3>
    <p>対処: ...</p>
  </div>
</main>
</body>
</html>`;

export const templates: TemplateDef[] = [
  {
    id: "shinchoku",
    label: "進捗管理表",
    description: "案件・状態・担当・期日テーブル + バッジ",
    html: SHINCHOKU
  },
  {
    id: "drill",
    label: "教材ドリル(A4)",
    description: "@page A4 + page-break 印刷想定",
    html: DRILL_A4
  },
  {
    id: "eigyo",
    label: "営業資料",
    description: "リード文 + カード + スケジュール表",
    html: EIGYO
  },
  {
    id: "kensa",
    label: "検査レポート",
    description: "サマリ箱 + 詳細テーブル + 所感",
    html: KENSA
  },
  {
    id: "manual",
    label: "運用マニュアル",
    description: "目次 + 長文セクション(2カラム)",
    html: MANUAL
  }
];
