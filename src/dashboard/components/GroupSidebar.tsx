import css from "../dashboard.module.css";

interface Props {
  groups: Map<string, number>;
  total: number;
  selected: string | null;
  onSelect: (group: string | null) => void;
}

export default function GroupSidebar({ groups, total, selected, onSelect }: Props) {
  return (
    <aside className={css.sidebar}>
      <div
        className={`${css.groupItem} ${selected === null ? css.groupActive : ""}`}
        onClick={() => onSelect(null)}
      >
        <span className={css.groupName}>すべて</span>
        <span className={css.groupCount}>{total}</span>
      </div>
      {[...groups.entries()].map(([name, count]) => (
        <div
          key={name}
          className={`${css.groupItem} ${selected === name ? css.groupActive : ""}`}
          onClick={() => onSelect(name)}
          title={name}
        >
          <span className={css.groupName}>{name}</span>
          <span className={css.groupCount}>{count}</span>
        </div>
      ))}
    </aside>
  );
}
