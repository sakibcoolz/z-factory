"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

type AutoRefreshProps = {
  /** How often the server-rendered data of the page is fetched again. */
  intervalMs: number;
};

/** Re-reads the page's server data on an interval while the tab is visible. Renders nothing. */
export function AutoRefresh({ intervalMs }: AutoRefreshProps) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
