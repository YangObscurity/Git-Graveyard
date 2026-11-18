"use client";

// Live view of one run: load the stored event log, then follow the SSE stream
// from the last stored seq. Both paths feed the same idempotent reducer, so a
// reconnect or an overlapping replay never applies an event twice.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  clearLiveRunStreamSnapshot,
  reportLiveRunStreamSnapshot,
} from "@/lib/ui-debug";
import { eventStreamUrl, fetchRunEvents } from "./api";
import {
  applyRunEvents,
  createRunView,
  openAsks,
  pendingApprovals,
  type RunView,
} from "./run-model";

export interface RunStream {
  view: RunView;
  /** True until the stored log has been read (or failed to load). */
  loading: boolean;
  /** The live stream dropped and the browser is retrying. */
  reconnecting: boolean;
  /** Plain-words load failure, or null. */
  loadError: string | null;
  /**
   * Read events newer than the last applied seq. Called after a user action so
   * its recorded event shows even while the stream is reconnecting. Does
   * nothing before the component has mounted.
   */
  refresh: () => Promise<void>;
}

export interface UseRunStreamOptions {
  /** Events already in hand (tests, replay, debug lab). Applied first. */
  initialEvents?: readonly unknown[];
  /** Set false to render from initialEvents only, with no network. */
  live?: boolean;
}

function reducer(view: RunView, events: readonly unknown[]): RunView {
  return applyRunEvents(view, events);
}

export function useRunStream(
  runId: string,
  options: UseRunStreamOptions = {}
): RunStream {
  const { initialEvents, live = true } = options;

  // Seeding in the initializer makes initialEvents visible to the first
  // render, which is what server-side rendering and tests see.
  const [view, apply] = useReducer(reducer, initialEvents, (seed) =>
    applyRunEvents(createRunView(), seed ?? [])
  );
  const [loading, setLoading] = useState<boolean>(live);
  const [reconnecting, setReconnecting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastSeqRef = useRef(view.lastSeq);
  lastSeqRef.current = view.lastSeq;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current || !live || !runId) return;
    const result = await fetchRunEvents(runId, lastSeqRef.current + 1);
    if (mountedRef.current && result.ok) apply(result.events);
  }, [runId, live]);

  useEffect(() => {
    if (!live || !runId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;

    async function start() {
      setLoadError(null);
      const stored = await fetchRunEvents(runId, 1);
      if (cancelled) return;

      let resumeFrom = lastSeqRef.current;
      if (stored.ok) {
        apply(stored.events);
        for (const ev of stored.events) {
          if (typeof ev.seq === "number" && ev.seq > resumeFrom) resumeFrom = ev.seq;
        }
      } else {
        setLoadError(
          stored.status === 404
            ? "Run not found."
            : "Could not read the stored event log. Live events will still appear."
        );
      }
      setLoading(false);

      if (typeof EventSource === "undefined") return;
      try {
        source = new EventSource(eventStreamUrl(runId, resumeFrom));
      } catch {
        setReconnecting(true);
        return;
      }
      source.onopen = () => {
        if (!cancelled) setReconnecting(false);
      };
      source.onmessage = (message) => {
        if (cancelled) return;
        try {
          apply([JSON.parse(message.data)]);
        } catch {
          // Keepalive or malformed line.
        }
      };
      source.onerror = () => {
        // EventSource retries on its own and sends Last-Event-ID.
        if (!cancelled) setReconnecting(true);
      };
    }

    start();

    return () => {
      cancelled = true;
      if (source) source.close();
    };
  }, [runId, live]);

  // Publish client-side stream telemetry to the UI debug store without
  // issuing any extra network calls or affecting SSR.
  useEffect(() => {
    if (!runId) return;
    reportLiveRunStreamSnapshot(runId, {
      runId,
      loading,
      reconnecting,
      loadError,
      lastSeq: view.lastSeq,
      phase: view.phase,
      outcome: view.outcome,
      pactStatus: view.pact.approved
        ? "approved"
        : view.pact.version !== null
        ? "draft"
        : "none",
      pactVersion: view.pact.version,
      skeletonCount: view.skeletons.length,
      pendingApprovalsCount: pendingApprovals(view).length,
      openAsksCount: openAsks(view).length,
      taskCount: view.tasks.length,
      updatedAt: Date.now(),
    });
  }, [runId, loading, reconnecting, loadError, view]);

  useEffect(() => {
    if (!runId) return;
    return () => {
      clearLiveRunStreamSnapshot(runId);
    };
  }, [runId]);

  return { view, loading, reconnecting, loadError, refresh };
}
