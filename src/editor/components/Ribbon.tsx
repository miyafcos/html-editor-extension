import { useState, useCallback, useRef, useEffect } from "react";
import { commands, runCommand, insertHtmlAtSelection } from "../core/commands";
import { parts, type PartDef } from "../parts";
import { useEditorStore } from "../store/editorStore";
import styles from "../styles/ui.module.css";

interface Props {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  disabled: boolean;
  onOpenSearch: () => void;
  onPickAssets: () => void;
}

type TabId = "home" | "insert" | "view";

const QUICK_TEXT_COLORS = [
  { label: "黒", value: "#111827" },
  { label: "赤", value: "#dc2626" },
  { label: "青", value: "#2563eb" },
  { label: "緑", value: "#16a34a" },
  { label: "橙", value: "#ea580c" }
];

const QUICK_BG_COLORS = [
  { label: "なし", value: "transparent" },
  { label: "黄", value: "#fef3c7" },
  { label: "青", value: "#dbeafe" },
  { label: "緑", value: "#dcfce7" },
  { label: "桃", value: "#fce7f3" }
];

function preventBlur(e: React.MouseEvent) {
  e.preventDefault();
}

interface IconProps {
  d: string;
  size?: number;
}

function Icon({ d, size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICON = {
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  ol: "M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  unlink: "M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.71 1.71M10 11l-2 2M3 21l3-3M7 17l-3 3M14 4l3 3",
  alignLeft: "M17 10H3M21 6H3M21 14H3M17 18H3",
  alignCenter: "M21 10H3M21 6H3M21 14H3M21 18H3",
  alignRight: "M21 10H7M21 6H3M21 14H3M21 18H7",
  undo: "M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13",
  redo: "M21 7v6h-6M3 17a9 9 0 0 1 15-6.7L21 13",
  clear: "M16 3l5 5L10 19l-5-5L16 3M21 21H7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  outline: "M3 6h18M3 12h18M3 18h12",
  folder: "M4 4h6l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  image: "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM21 15l-5-5L5 21",
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18",
  badge: "M12 3l8 5v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V8l8-5z",
  callout: "M21 11.5a8.38 8.38 0 0 1-9 8.5l-5 3v-5a8.5 8.5 0 1 1 14-6.5z",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  check: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  toc: "M9 5H5v4h4V5zM9 11H5v4h4v-4zM9 17H5v4h4v-4zM21 7H13M21 13H13M21 19H13",
  details: "M9 18l6-6-6-6"
};

export function Ribbon({ iframeRef, disabled, onOpenSearch, onPickAssets }: Props) {
  const [tab, setTab] = useState<TabId>("home");
  const [partsOpen, setPartsOpen] = useState(false);
  const partsRef = useRef<HTMLDivElement | null>(null);
  const outlineOpen = useEditorStore((s) => s.outlineOpen);
  const toggleOutline = useEditorStore((s) => s.toggleOutline);
  const assetsDir = useEditorStore((s) => s.assetsDir);

  const run = useCallback(
    (cmd: (typeof commands)[keyof typeof commands] | ReturnType<typeof commands.color>) => {
      runCommand(iframeRef.current, cmd as never);
    },
    [iframeRef]
  );

  useEffect(() => {
    if (!partsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (partsRef.current && !partsRef.current.contains(e.target as Node)) {
        setPartsOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [partsOpen]);

  const insertLink = () => {
    const url = window.prompt("リンク先 URL", "https://");
    if (!url) return;
    runCommand(iframeRef.current, commands.link(url));
  };

  const onBlock = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const map: Record<string, (typeof commands)[keyof typeof commands]> = {
      p: commands.paragraph,
      h1: commands.h1,
      h2: commands.h2,
      h3: commands.h3,
      h4: commands.h4
    };
    if (map[v]) run(map[v]);
    e.target.value = "_";
  };

  const insertImageDialog = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const { assetsDir: dir } = useEditorStore.getState();
      const { buildImageHtml } = await import("../core/imageInsert");
      const html = await buildImageHtml(file, { assetsDir: dir });
      if (iframeRef.current) insertHtmlAtSelection(iframeRef.current, html);
    };
    input.click();
  };

  const insertPart = (p: PartDef) => {
    setPartsOpen(false);
    if (iframeRef.current) p.run(iframeRef.current);
  };

  const renderTab = () => {
    if (tab === "home") return renderHome();
    if (tab === "insert") return renderInsert();
    return renderView();
  };

  const renderHome = () => (
    <>
      <Group label="フォント">
        <ToolButton
          label="B"
          bold
          title="太字 (Ctrl+B)"
          onClick={() => run(commands.bold)}
          disabled={disabled}
        />
        <ToolButton
          label="I"
          italic
          title="斜体 (Ctrl+I)"
          onClick={() => run(commands.italic)}
          disabled={disabled}
        />
        <ToolButton
          label="U"
          underline
          title="下線 (Ctrl+U)"
          onClick={() => run(commands.underline)}
          disabled={disabled}
        />
        <ToolButton
          label="S"
          strike
          title="取り消し線"
          onClick={() => run(commands.strikethrough)}
          disabled={disabled}
        />
      </Group>

      <Group label="段落">
        <select
          className={styles.rselect}
          onMouseDown={preventBlur}
          onChange={onBlock}
          disabled={disabled}
          defaultValue="_"
          title="段落スタイル"
        >
          <option value="_" disabled>
            スタイル
          </option>
          <option value="p">本文</option>
          <option value="h1">見出し1</option>
          <option value="h2">見出し2</option>
          <option value="h3">見出し3</option>
          <option value="h4">見出し4</option>
        </select>
        <IconButton
          icon={ICON.list}
          title="箇条書き"
          onClick={() => run(commands.ul)}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.ol}
          title="番号付き"
          onClick={() => run(commands.ol)}
          disabled={disabled}
        />
      </Group>

      <Group label="リンク">
        <IconButton
          icon={ICON.link}
          title="リンク挿入"
          onClick={insertLink}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.unlink}
          title="リンク解除"
          onClick={() => run(commands.unlink)}
          disabled={disabled}
        />
      </Group>

      <Group label="色">
        <div className={styles.rcolBlock}>
          <span className={styles.rcolLabel}>文字</span>
          <div className={styles.rcolRow}>
            {QUICK_TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                className={styles.rswatch}
                style={{ background: c.value }}
                onMouseDown={preventBlur}
                onClick={() => run(commands.color(c.value))}
                disabled={disabled}
                title={`文字色 ${c.label}`}
                aria-label={`文字色 ${c.label}`}
              />
            ))}
          </div>
        </div>
        <div className={styles.rcolBlock}>
          <span className={styles.rcolLabel}>背景</span>
          <div className={styles.rcolRow}>
            {QUICK_BG_COLORS.map((c) => (
              <button
                key={c.value}
                className={styles.rswatch}
                style={{
                  background: c.value === "transparent" ? "#ffffff" : c.value,
                  border: c.value === "transparent" ? "1px dashed #9ca3af" : "1px solid #d1d5db"
                }}
                onMouseDown={preventBlur}
                onClick={() => run(commands.bgColor(c.value))}
                disabled={disabled}
                title={`背景色 ${c.label}`}
                aria-label={`背景色 ${c.label}`}
              />
            ))}
          </div>
        </div>
      </Group>

      <Group label="配置">
        <IconButton
          icon={ICON.alignLeft}
          title="左寄せ"
          onClick={() => run(commands.alignLeft)}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.alignCenter}
          title="中央"
          onClick={() => run(commands.alignCenter)}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.alignRight}
          title="右寄せ"
          onClick={() => run(commands.alignRight)}
          disabled={disabled}
        />
      </Group>

      <Group label="履歴">
        <IconButton
          icon={ICON.undo}
          title="元に戻す (Ctrl+Z)"
          onClick={() => run(commands.undo)}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.redo}
          title="やり直し (Ctrl+Y)"
          onClick={() => run(commands.redo)}
          disabled={disabled}
        />
        <IconButton
          icon={ICON.clear}
          title="書式解除"
          onClick={() => run(commands.removeFormat)}
          disabled={disabled}
        />
      </Group>
    </>
  );

  const renderInsert = () => {
    const grouped = parts.reduce<Record<string, PartDef[]>>((acc, p) => {
      const g = p.group ?? "その他";
      (acc[g] = acc[g] || []).push(p);
      return acc;
    }, {});

    return (
      <>
        <Group label="ファイル">
          <button
            className={styles.rbtnWide}
            onMouseDown={preventBlur}
            onClick={insertImageDialog}
            disabled={disabled}
            title="画像を選択して挿入"
          >
            <Icon d={ICON.image} />
            <span>画像</span>
          </button>
          <button
            className={styles.rbtnWide}
            onMouseDown={preventBlur}
            onClick={insertLink}
            disabled={disabled}
            title="リンクを挿入"
          >
            <Icon d={ICON.link} />
            <span>リンク</span>
          </button>
        </Group>

        {Object.entries(grouped).map(([groupName, items]) => (
          <Group key={groupName} label={groupName}>
            {items.map((p) => (
              <button
                key={p.id}
                className={styles.rbtnTile}
                onMouseDown={preventBlur}
                onClick={() => p.run(iframeRef.current!)}
                disabled={disabled}
                title={p.hint ?? p.label}
              >
                <span className={styles.rbtnTileLabel}>{p.label}</span>
                {p.hint && <span className={styles.rbtnTileHint}>{p.hint}</span>}
              </button>
            ))}
          </Group>
        ))}
      </>
    );
  };

  const renderView = () => (
    <>
      <Group label="検索">
        <button
          className={styles.rbtnWide}
          onMouseDown={preventBlur}
          onClick={onOpenSearch}
          disabled={disabled}
          title="検索・置換 (Ctrl+F / Ctrl+H)"
        >
          <Icon d={ICON.search} />
          <span>検索・置換</span>
        </button>
      </Group>
      <Group label="表示">
        <button
          className={`${styles.rbtnWide} ${outlineOpen ? styles.rbtnActive : ""}`}
          onMouseDown={preventBlur}
          onClick={toggleOutline}
          title="見出しアウトラインを開閉"
        >
          <Icon d={ICON.outline} />
          <span>アウトライン</span>
        </button>
      </Group>
      <Group label="ファイル">
        <button
          className={`${styles.rbtnWide} ${assetsDir ? styles.rbtnActive : ""}`}
          onMouseDown={preventBlur}
          onClick={onPickAssets}
          disabled={disabled}
          title="同階層フォルダの画像を読めるようにする"
        >
          <Icon d={ICON.folder} />
          <span>画像フォルダ{assetsDir ? " ✓" : ""}</span>
        </button>
      </Group>
    </>
  );

  // unused suppression
  void partsRef;
  void setPartsOpen;
  void insertHtmlAtSelection;

  return (
    <div className={styles.ribbonWrap} aria-disabled={disabled}>
      <div className={styles.rTabs}>
        <button
          className={`${styles.rTab} ${tab === "home" ? styles.rTabActive : ""}`}
          onClick={() => setTab("home")}
        >
          ホーム
        </button>
        <button
          className={`${styles.rTab} ${tab === "insert" ? styles.rTabActive : ""}`}
          onClick={() => setTab("insert")}
        >
          挿入
        </button>
        <button
          className={`${styles.rTab} ${tab === "view" ? styles.rTabActive : ""}`}
          onClick={() => setTab("view")}
        >
          表示
        </button>
        <span className={styles.rTabSpacer} />
        <span className={styles.rhint}>
          Ctrl+S 保存 / Ctrl+F 検索 / Ctrl+Z 戻す
        </span>
      </div>
      <div className={styles.ribbon}>{renderTab()}</div>
    </div>
  );

  function insertPartSilently(p: PartDef) {
    insertPart(p);
  }
  void insertPartSilently;
}

interface GroupProps {
  label: string;
  children: React.ReactNode;
}

function Group({ label, children }: GroupProps) {
  return (
    <div className={styles.rgroupWrap}>
      <div className={styles.rgroupInner}>{children}</div>
      <div className={styles.rgroupLabel}>{label}</div>
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

function ToolButton({ label, title, onClick, disabled, bold, italic, underline, strike }: ToolButtonProps) {
  const style: React.CSSProperties = {};
  if (bold) style.fontWeight = 700;
  if (italic) style.fontStyle = "italic";
  if (underline) style.textDecoration = "underline";
  if (strike) style.textDecoration = "line-through";
  return (
    <button
      className={styles.rbtn}
      style={style}
      onMouseDown={preventBlur}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

interface IconButtonProps {
  icon: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
}

function IconButton({ icon, title, onClick, disabled }: IconButtonProps) {
  return (
    <button
      className={styles.rbtn}
      onMouseDown={preventBlur}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      <Icon d={icon} />
    </button>
  );
}
