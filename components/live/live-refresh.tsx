"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useFactoryStream } from "./use-factory-stream";

type LiveRefreshProps = {
  streamUrl: string;
  /** Changes that arrive closer together than this cause one refresh. */
  debounceMs?: number;
};

/**
 * Re-reads the page's server data when the factory records an event (a state change, a
 * fault, an alarm), instead of polling for it. Renders nothing.
 */
export function LiveRefresh({ streamUrl, debounceMs = 400 }: LiveRefreshProps) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useFactoryStream(streamUrl, (message) => {
    if (message.kind !== "event" && message.kind !== "reset") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), debounceMs);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return null;
}
