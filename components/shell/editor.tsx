import Link from "next/link";
import type { ReactNode } from "react";

export type EditorTab = {
  label: string;
  href?: string;
  active?: boolean;
};

type EditorTabsProps = {
  tabs: readonly EditorTab[];
  /** Right-aligned breadcrumb / context hint. */
  crumb?: string;
};

export function EditorTabs({ tabs, crumb }: EditorTabsProps) {
  return (
    <div className="zf-tabs">
      {tabs.map((tab) =>
        tab.href && !tab.active ? (
          <Link key={tab.label} href={tab.href} className="zf-tab">
            {tab.label}
          </Link>
        ) : (
          <span key={tab.label} className="zf-tab" aria-current={tab.active ? "page" : undefined}>
            {tab.label}
          </span>
        ),
      )}
      {crumb ? <span className="zf-tabs-crumb">{crumb}</span> : null}
    </div>
  );
}

type ToolbarProps = {
  /** Left-aligned summary; actions follow on the right. */
  summary: string;
  children?: ReactNode;
};

export function Toolbar({ summary, children }: ToolbarProps) {
  return (
    <div className="zf-toolbar">
      <span className="zf-k mr-auto">{summary}</span>
      {children}
    </div>
  );
}

type ContentProps = {
  /** Hide the canvas grid behind the content. */
  plain?: boolean;
  /** Remove the content padding (tables that run edge to edge). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
};

export function Content({ plain = false, flush = false, className, children }: ContentProps) {
  return (
    <div className={className ? `zf-cont ${className}` : "zf-cont"} data-plain={plain} data-flush={flush}>
      {children}
    </div>
  );
}

type PanelProps = {
  tabs: readonly string[];
  active: string;
  /** Right-aligned slot in the panel header. */
  end?: ReactNode;
  /** Let the panel take the remaining editor height. */
  grow?: boolean;
  children: ReactNode;
};

export function Panel({ tabs, active, end, grow = false, children }: PanelProps) {
  return (
    <section className="zf-panel" data-grow={grow} aria-label={active}>
      <div className="zf-panel-head">
        {tabs.map((tab) => (
          <span key={tab} className="zf-panel-tab" aria-current={tab === active ? "true" : undefined}>
            {tab}
          </span>
        ))}
        {end ? <span className="ml-auto">{end}</span> : null}
      </div>
      {children}
    </section>
  );
}
