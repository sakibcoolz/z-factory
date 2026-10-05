"use client";

import { useEffect, useRef, useState } from "react";
import { LIVE_MESSAGE_KINDS, type LiveMessage } from "@/lib/domain/live";

/**
 * `live`: connected. `reconnecting`: the browser is trying again. `paused`: the tab is
 * hidden and has let go of its connection. `offline`: the server refused the stream.
 */
export type StreamStatus = "connecting" | "live" | "reconnecting" | "paused" | "offline";

/**
 * Subscribes to a factory's live stream for as long as the component is mounted and its
 * tab is visible. After any interruption the server is told the last event that was
 * seen, so missed events are replayed; every (re)connect also brings the whole current
 * state.
 *
 * A hidden tab closes its stream: a browser allows only a handful of connections to one
 * server, and background tabs holding them would block the visible one.
 */
export function useFactoryStream(url: string, onMessage: (message: LiveMessage) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let source: EventSource | undefined;
    let lastEventId = "";

    const connect = () => {
      const separator = url.includes("?") ? "&" : "?";
      // A stream opened anew does not resume by itself; it says where it left off.
      const opened = new EventSource(
        lastEventId ? `${url}${separator}lastEventId=${encodeURIComponent(lastEventId)}` : url,
      );
      source = opened;
      opened.onopen = () => setStatus("live");
      // The browser retries on its own unless the server answered with an error status.
      opened.onerror = () => setStatus(opened.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
      for (const kind of LIVE_MESSAGE_KINDS) {
        opened.addEventListener(kind, (event: MessageEvent<string>) => {
          if (event.lastEventId) lastEventId = event.lastEventId;
          try {
            const data: unknown = JSON.parse(event.data);
            // A recorded event travels as the bare envelope, with its id as the stream id.
            handler.current((kind === "event" ? { kind, event: data } : data) as LiveMessage);
          } catch {
            // A message that cannot be read is skipped; the next snapshot corrects the state.
          }
        });
      }
    };
    const disconnect = () => {
      source?.close();
      source = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        disconnect();
        setStatus("paused");
      } else if (!source) {
        setStatus("connecting");
        connect();
      }
    };

    // A tab that is opened in the background connects when it is first looked at.
    if (!document.hidden) connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
    };
  }, [url]);

  return status;
}

export const STREAM_STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  paused: "paused",
  offline: "offline",
};
