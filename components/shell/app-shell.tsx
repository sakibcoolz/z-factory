import Link from "next/link";
import type { ReactNode } from "react";
import { ACTIVITIES, type ActivityKey, type FactoryContext } from "@/lib/navigation/activities";

export type { ActivityKey, FactoryContext };

type StatusTone = "ok" | "flt" | "deg" | "off";

type AppShellProps = {
  /** Window title, e.g. `Pump House Demo — Z-FACTORY`. */
  title: string;
  /** Hint shown in the command center. */
  command?: string;
  /** State pill at the end of the title bar. */
  titleState?: ReactNode;
  activity: ActivityKey;
  context?: FactoryContext;
  badges?: Partial<Record<ActivityKey, number>>;
  sidebar?: ReactNode;
  status: {
    tone?: StatusTone;
    left: readonly string[];
    right?: readonly string[];
  };
  /** Editor area: tabs, toolbar, content and panel. */
  children: ReactNode;
};

export function AppShell({
  title,
  command,
  titleState,
  activity,
  context,
  badges,
  sidebar,
  status,
  children,
}: AppShellProps) {
  return (
    <div className="zf-shell">
      <header className="zf-title">
        <span>{title}</span>
        {command ? <span className="zf-title-cmd">{command}</span> : <span className="flex-1" />}
        {titleState}
      </header>
      <div className="zf-body">
        <nav className="zf-act" aria-label="Activities">
          {ACTIVITIES.map((item) => {
            const href = item.href(context);
            const badge = badges?.[item.key];
            const content = (
              <>
                {item.short}
                {badge ? <span className="zf-act-badge">{badge}</span> : null}
              </>
            );
            return href ? (
              <Link
                key={item.key}
                href={href}
                className="zf-act-item"
                aria-label={item.label}
                aria-current={item.key === activity ? "page" : undefined}
              >
                {content}
              </Link>
            ) : (
              <span
                key={item.key}
                className="zf-act-item"
                aria-label={item.label}
                aria-current={item.key === activity ? "page" : undefined}
                aria-disabled="true"
                title="Open a factory first"
              >
                {content}
              </span>
            );
          })}
          <span className="zf-act-item zf-act-end" aria-label="Settings" aria-disabled="true" title="Settings">
            ⚙
          </span>
        </nav>
        {sidebar}
        <main className="zf-ed">{children}</main>
      </div>
      <footer className="zf-status" data-tone={status.tone ?? "ok"}>
        {status.left.map((item) => (
          <span key={item}>{item}</span>
        ))}
        {status.right ? (
          <span className="zf-status-end">
            {status.right.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
