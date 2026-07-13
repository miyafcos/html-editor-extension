import { useEffect, useState } from "react";
import { recomputeGroups, saveSettings } from "../../reporthub/repo";
import type { GroupRule, Settings } from "../../reporthub/types";
import { useLibraryStore } from "../../reporthub/libraryStore";
import css from "../dashboard.module.css";

const COLORS: chrome.tabGroups.ColorEnum[] = [
  "blue",
  "grey",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
];

interface Props {
  onStatus: (s: string) => void;
}

export default function SettingsPane({ onStatus }: Props) {
  const settings = useLibraryStore((s) => s.settings);
  const [exclude, setExclude] = useState("");
  const [rules, setRules] = useState<GroupRule[]>([]);
  const [tabTitle, setTabTitle] = useState("");
  const [tabColor, setTabColor] = useState<chrome.tabGroups.ColorEnum>("blue");

  useEffect(() => {
    setExclude(settings.excludePatterns.join("\n"));
    setRules(settings.groupRules.map((r) => ({ ...r })));
    setTabTitle(settings.tabGroupTitle);
    setTabColor(settings.tabGroupColor);
  }, [settings]);

  const buildSettings = (): Settings => ({
    excludePatterns: exclude
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    groupRules: rules.filter((r) => r.pattern.trim() && r.group.trim()),
    tabGroupTitle: tabTitle.trim() || "レポート",
    tabGroupColor: tabColor
  });

  const save = async (recompute: boolean) => {
    const next = buildSettings();
    await saveSettings(next);
    if (recompute) {
      const n = await recomputeGroups(next);
      onStatus(`設定を保存し、${n}件のグループを再計算しました`);
    } else {
      onStatus("設定を保存しました");
    }
  };

  return (
    <div className={css.settings}>
      <section className={css.settingsSection}>
        <h2>除外パターン</h2>
        <p className={css.hint}>
          1行1パターン。パス (小文字化) に部分一致したものは記録・タブ整理の対象外。
        </p>
        <textarea
          className={css.settingsArea}
          rows={5}
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
        />
      </section>

      <section className={css.settingsSection}>
        <h2>グループ推定ルール</h2>
        <p className={css.hint}>
          上から順に評価し、最初に一致したルールを適用。パターンは正規表現
          (大文字小文字無視)、グループ名の $1 は捕捉グループで置換。どれにも一致しなければ「その他」。
        </p>
        {rules.map((r, i) => (
          <div key={i} className={css.ruleRow}>
            <input
              className={css.rulePattern}
              value={r.pattern}
              placeholder="^g:/マイドライブ/([^/]+)/"
              onChange={(e) =>
                setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))
              }
            />
            <span className={css.ruleArrow}>→</span>
            <input
              className={css.ruleGroup}
              value={r.group}
              placeholder="$1"
              onChange={(e) =>
                setRules(rules.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))
              }
            />
            <button
              className={css.ruleDel}
              title="このルールを削除"
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button onClick={() => setRules([...rules, { pattern: "", group: "" }])}>
          + ルール追加
        </button>
      </section>

      <section className={css.settingsSection}>
        <h2>タブグループ</h2>
        <div className={css.ruleRow}>
          <label>
            名前:{" "}
            <input value={tabTitle} onChange={(e) => setTabTitle(e.target.value)} />
          </label>
          <label>
            色:{" "}
            <select
              value={tabColor}
              onChange={(e) => setTabColor(e.target.value as chrome.tabGroups.ColorEnum)}
            >
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <div className={css.settingsBtns}>
        <button className={css.primaryBtn} onClick={() => void save(false)}>
          保存
        </button>
        <button onClick={() => void save(true)}>保存してグループ再計算</button>
      </div>
    </div>
  );
}
