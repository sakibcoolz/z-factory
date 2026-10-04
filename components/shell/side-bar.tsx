import Link from "next/link";
import type { ReactNode } from "react";

type SideBarProps = {
  title: string;
  /** Which editor edge the bar sits on; `left` draws the rule on its left (inspector). */
  edge?: "right" | "left";
  className?: string;
  children: ReactNode;
};

export function SideBar({ title, edge = "right", className, children }: SideBarProps) {
  return (
    <aside className={className ? `zf-side ${className}` : "zf-side"} data-edge={edge} aria-label={title}>
      <h2 className="zf-side-title">{title}</h2>
      {children}
    </aside>
  );
}

type SideSectionProps = {
  title: string;
  children: ReactNode;
};

export function SideSection({ title, children }: SideSectionProps) {
  return (
    <section>
      <h3 className="zf-side-section">
        <span aria-hidden="true">▾</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export type TreeNode = {
  label: ReactNode;
  meta?: ReactNode;
  href?: string;
  level?: 0 | 1 | 2;
  active?: boolean;
  muted?: boolean;
};

type TreeProps = {
  items: readonly TreeNode[];
};

export function Tree({ items }: TreeProps) {
  return (
    <ul className="zf-tree">
      {items.map((item, index) => {
        const content = (
          <>
            <span>{item.label}</span>
            {item.meta ? <span className="zf-tree-meta">{item.meta}</span> : null}
          </>
        );
        const shared = {
          className: "zf-tree-item",
          "data-level": item.level ?? 0,
          "data-muted": item.muted ?? false,
          "aria-current": item.active ? ("true" as const) : undefined,
        };
        return (
          <li key={index}>
            {item.href ? (
              <Link href={item.href} {...shared}>
                {content}
              </Link>
            ) : (
              <div {...shared}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
