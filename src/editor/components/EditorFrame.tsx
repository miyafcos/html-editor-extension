import { useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { attachFrame, type AttachedFrame } from "../core/frameBridge";
import { disarmScripts } from "../core/sanitize";
import { handleTableKeydown } from "../core/tableOps";
import { cleanPastedHtml, shouldClean } from "../core/pasteClean";
import {
  buildImageHtml,
  extractImageFromPaste,
  extractImagesFromDrop
} from "../core/imageInsert";
import { insertHtmlAtSelection } from "../core/commands";
import styles from "../styles/ui.module.css";

interface Props {
  onAttached: (ops: AttachedFrame | null) => void;
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
}

export function EditorFrame({ onAttached, iframeRef }: Props) {
  const opsRef = useRef<AttachedFrame | null>(null);
  const split = useEditorStore((s) => s.split);
  const assetsDir = useEditorStore((s) => s.assetsDir);
  const markDirty = useEditorStore((s) => s.markDirty);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    if (!split) {
      opsRef.current?.dispose();
      opsRef.current = null;
      onAttached(null);
      iframe.removeAttribute("srcdoc");
      return;
    }

    const srcdoc = split.headOuter + disarmScripts(split.bodyInner) + split.tailOuter;

    const handleLoad = async () => {
      const ops = attachFrame(iframe);
      opsRef.current = ops;
      if (assetsDir) {
        await ops.rewriteImagesForView(assetsDir);
      }
      ops.enableEdit();
      ops.onDirty(markDirty);

      ops.onKeyDown((e) => {
        if (iframe.contentWindow) {
          handleTableKeydown(e, iframe.contentWindow);
        }
      });

      ops.onPaste(async (e) => {
        const image = await extractImageFromPaste(e);
        if (image) {
          e.preventDefault();
          const { assetsDir: dir } = useEditorStore.getState();
          const html = await buildImageHtml(image, { assetsDir: dir });
          insertHtmlAtSelection(iframe, html);
          return;
        }
        const html = e.clipboardData?.getData("text/html");
        if (html && shouldClean(html)) {
          e.preventDefault();
          const cleaned = cleanPastedHtml(html);
          iframe.contentDocument?.execCommand("insertHTML", false, cleaned);
        }
      });

      ops.onDrop(async (e) => {
        const images = extractImagesFromDrop(e);
        if (images.length > 0) {
          e.preventDefault();
          const { assetsDir: dir } = useEditorStore.getState();
          for (const img of images) {
            const html = await buildImageHtml(img, { assetsDir: dir });
            insertHtmlAtSelection(iframe, html);
          }
        }
      });

      onAttached(ops);
    };

    iframe.addEventListener("load", handleLoad, { once: true });
    iframe.srcdoc = srcdoc;

    return () => {
      iframe.removeEventListener("load", handleLoad);
      opsRef.current?.dispose();
      opsRef.current = null;
    };
  }, [split, assetsDir, markDirty, onAttached, iframeRef]);

  return (
    <div className={styles.frameWrap}>
      {!split && (
        <div className={styles.emptyHint}>
          「開く」「新規」または「最近」からファイルを選んでください。
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="HTML editor surface"
        className={styles.frame}
        sandbox="allow-same-origin"
      />
    </div>
  );
}
