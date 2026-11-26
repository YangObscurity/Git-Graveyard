"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import type { EventEnvelope } from "@/lib/events/types";
import { summarizeEvent } from "@/lib/ui/event-summary";
import { StatusPill } from "@/components/ui/StatusPill";
import { CryptOrnament } from "@/components/ui/CryptOrnament";

export interface ReplayPlayerProps {
  runId: string;
  initialEvents?: EventEnvelope[];
  from?: number;
  to?: number;
  autoPlay?: boolean;
}

export interface ReplayTimelineEvent {
  type: "event";
  event: EventEnvelope;
}

export interface ReplayTimelineGap {
  type: "gap";
  fromSeq: number;
  toSeq: number;
}

export type ReplayTimelineItem = ReplayTimelineEvent | ReplayTimelineGap;

export function buildReplayTimeline(
  events: EventEnvelope[],
  expectedStartSeq: number = 1
): ReplayTimelineItem[] {
  if (!events || events.length === 0) {
    return [];
  }
  // Requirement 33.1: render strictly in seq order
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const items: ReplayTimelineItem[] = [];

  // Requirement 33.2: render visible gap at missing seq numbers
  if (sorted[0].seq > expectedStartSeq) {
    items.push({
      type: "gap",
      fromSeq: expectedStartSeq,
      toSeq: sorted[0].seq - 1,
    });
  }

  for (let i = 0; i < sorted.length; i++) {
    items.push({
      type: "event",
      event: sorted[i],
    });
    if (i < sorted.length - 1) {
      const currentSeq = sorted[i].seq;
      const nextSeq = sorted[i + 1].seq;
      if (nextSeq > currentSeq + 1) {
        items.push({
          type: "gap",
          fromSeq: currentSeq + 1,
          toSeq: nextSeq - 1,
        });
      }
    }
  }
  return items;
}

export function formatTimeMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatTimestamp(ts?: number | null): string {
  if (!ts) {
    return "unknown";
  }
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function getEventKindBadgeClass(kind: string): string {
  const k = kind.toLowerCase();
  if (k.startsWith("admin.") || k.includes("error") || k.includes("exceeded") || k.includes("fail")) {
    return "bg-rose-950/60 text-rose-300 border-[var(--crimson-seal-border)]";
  }
  if (k.startsWith("skeleton.") || k.startsWith("gate.") || k.startsWith("verdict")) {
    return "bg-emerald-950/50 text-emerald-300 border-[var(--necromancy-emerald-border)]";
  }
  if (k.startsWith("pact.") || k.startsWith("necromancer.")) {
    return "bg-violet-950/50 text-violet-300 border-[var(--spectral-violet-border)]";
  }
  if (k.startsWith("run.") || k.startsWith("artifact.")) {
    return "bg-amber-950/50 text-amber-300 border-[var(--arcane-amber-border)]";
  }
  return "bg-neutral-900 text-parchment border-white/15";
}

function mapEventToChapter(kind: string): "Tomb" | "Pact" | "Legion" | "Relic" | null {
  const k = kind.toLowerCase();
  if (k.includes("certificate") || k.includes("grimoire") || k.includes("command")) {
    return "Tomb";
  }
  if (k.startsWith("pact.")) {
    return "Pact";
  }
  if (k.startsWith("skeleton.") || k.startsWith("task.") || k.startsWith("necromancer.")) {
    return "Legion";
  }
  if (k.startsWith("artifact.") || k === "run.done" || k.startsWith("report.")) {
    return "Relic";
  }
  return null;
}

const SPEED_OPTIONS = [1, 2, 4, 8] as const;

export function ReplayPlayer({
  runId,
  initialEvents,
  from,
  to,
  autoPlay = false,
}: ReplayPlayerProps) {
  const [events, setEvents] = useState<EventEnvelope[]>(initialEvents ?? []);
  const [loading, setLoading] = useState<boolean>(initialEvents === undefined);
  const [error, setError] = useState<string | null>(null);

  const timeline = useMemo(() => {
    const startSeq = typeof from === "number" ? from : 1;
    return buildReplayTimeline(events, startSeq);
  }, [events, from]);

  // Playback state: index points to the visible boundary in timeline
  const [playbackIndex, setPlaybackIndex] = useState<number>(() => {
    const startSeq = typeof from === "number" ? from : 1;
    return buildReplayTimeline(initialEvents ?? [], startSeq).length;
  });
  const [isPlaying, setIsPlaying] = useState<boolean>(autoPlay);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [elapsedReplayMs, setElapsedReplayMs] = useState<number>(0);

  // Requirement 33.11: Retrieve stored events via GET /api/runs/{runId}/events with from and to as JSON
  useEffect(() => {
    if (initialEvents !== undefined) {
      setEvents(initialEvents);
      const startSeq = typeof from === "number" ? from : 1;
      setPlaybackIndex(buildReplayTimeline(initialEvents, startSeq).length);
      return;
    }

    let cancelled = false;

    async function fetchEvents() {
      try {
        setLoading(true);
        setError(null);
        const fromVal = typeof from === "number" ? from : 1;
        const toVal = typeof to === "number" ? to : 1000000;
        const url = `/api/runs/${encodeURIComponent(runId)}/events?from=${encodeURIComponent(
          fromVal
        )}&to=${encodeURIComponent(toVal)}`;

        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!res.ok) {
          if (!cancelled) {
            // Requirement 39.6: error state in plain words
            setError("Unable to read event log.");
            setLoading(false);
          }
          return;
        }

        const data = await res.json();
        if (!cancelled) {
          if (Array.isArray(data)) {
            setEvents(data);
            const startSeq = typeof from === "number" ? from : 1;
            setPlaybackIndex(buildReplayTimeline(data, startSeq).length);
          } else {
            setEvents([]);
            setPlaybackIndex(0);
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Unable to read event log.");
          setLoading(false);
        }
      }
    }

    fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [runId, initialEvents, from, to]);

  // Check if run was killed (Requirement 39.5)
  const isKilled = useMemo(() => {
    return events.some(
      (e) =>
        e.kind === "admin.kill" ||
        (e.kind === "run.done" &&
          (e.data as Record<string, unknown>)?.outcome === "killed")
    );
  }, [events]);

  // Autoplay ticker
  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const intervalMs = Math.max(100, Math.floor(1000 / playbackSpeed));
    const timer = setInterval(() => {
      setPlaybackIndex((prev) => {
        if (prev >= timeline.length) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
      setElapsedReplayMs((prev) => prev + intervalMs * playbackSpeed);
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [isPlaying, playbackSpeed, timeline.length]);

  // Visible items based on playback index
  const visibleItems = useMemo(() => {
    const count = Math.min(playbackIndex, timeline.length);
    return timeline.slice(0, count);
  }, [timeline, playbackIndex]);

  const lastVisibleEvent = useMemo(() => {
    for (let i = visibleItems.length - 1; i >= 0; i--) {
      const item = visibleItems[i];
      if (item.type === "event") {
        return item.event;
      }
    }
    return null;
  }, [visibleItems]);

  const isAtEnd = visibleItems.length === timeline.length && timeline.length > 0;

  const handleTogglePlay = useCallback(() => {
    if (timeline.length === 0) return;
    if (isAtEnd && !isPlaying) {
      setPlaybackIndex(1);
      setElapsedReplayMs(0);
      setIsPlaying(true);
    } else {
      setIsPlaying((prev) => !prev);
    }
  }, [isAtEnd, isPlaying, timeline.length]);

  const handleStepForward = useCallback(() => {
    setIsPlaying(false);
    setPlaybackIndex((prev) => Math.min(timeline.length, prev + 1));
  }, [timeline.length]);

  const handleStepBackward = useCallback(() => {
    setIsPlaying(false);
    setPlaybackIndex((prev) => Math.max(0, prev - 1));
  }, []);

  // Keyboard shortcuts: Space (Play/Pause), ArrowRight (+1), ArrowLeft (-1)
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        handleStepForward();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        handleStepBackward();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleTogglePlay, handleStepForward, handleStepBackward]);

  const seqBounds = useMemo(() => {
    if (events.length === 0) {
      return { fromSeq: from ?? 1, toSeq: to ?? 0 };
    }
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    return {
      fromSeq: sorted[0].seq,
      toSeq: sorted[sorted.length - 1].seq,
    };
  }, [events, from, to]);

  const chapterMarkers = useMemo(() => {
    const markers: { label: "Tomb" | "Pact" | "Legion" | "Relic"; index: number; pct: number }[] = [];
    const seen = new Set<string>();
    const total = Math.max(1, timeline.length);
    timeline.forEach((item, idx) => {
      if (item.type !== "event") return;
      const chapter = mapEventToChapter(item.event.kind);
      if (chapter && !seen.has(chapter)) {
        seen.add(chapter);
        markers.push({
          label: chapter,
          index: idx + 1,
          pct: Math.round(((idx + 1) / total) * 100),
        });
      }
    });
    if (markers.length === 0 && timeline.length > 0) {
      return [
        { label: "Tomb" as const, index: 1, pct: 10 },
        { label: "Pact" as const, index: Math.max(1, Math.floor(timeline.length * 0.35)), pct: 35 },
        { label: "Legion" as const, index: Math.max(1, Math.floor(timeline.length * 0.65)), pct: 65 },
        { label: "Relic" as const, index: timeline.length, pct: 100 },
      ];
    }
    return markers;
  }, [timeline]);

  const uiState: "loading" | "playing" | "paused" | "ended" | "error" = loading
    ? "loading"
    : error
    ? "error"
    : isPlaying
    ? "playing"
    : isAtEnd
    ? "ended"
    : "paused";
  const uiVariant = `${playbackSpeed}x`;

  // Requirement 33.7: persistent "Replay" banner and no run action buttons
  const renderBanner = () => {
    const originalTimeDisplay = lastVisibleEvent
      ? formatTimestamp(lastVisibleEvent.ts)
      : events.length > 0
      ? formatTimestamp(events[0].ts)
      : "none";

    return (
      <div
        data-testid="replay-banner"
        className="sticky top-14 z-30 border-b border-[var(--border-engraved)] bg-[#0b0d11]/95 backdrop-blur-md px-4 sm:px-6 py-3 shadow-lg"
      >
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill
              tone="amber"
              pulse={isPlaying}
              label="Replay"
              testId="replay-badge"
              uiState={uiState}
            />
            <span
              data-testid="replay-run-id"
              className="text-sm font-semibold text-bone"
            >
              Run: {runId}
            </span>
            {events.length > 0 ? (
              <span className="crypt-well px-2 py-0.5 text-[11px] text-ash tabular-nums">
                seq {seqBounds.fromSeq}..{seqBounds.toSeq}
              </span>
            ) : null}
          </div>

          {/* Requirement 33.9: show both replay time and original time */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-ash">
            <span
              data-testid="replay-time"
              className="crypt-well px-2.5 py-1 text-emerald-300 tabular-nums"
            >
              Replay time: {formatTimeMs(elapsedReplayMs)}
            </span>
            <span
              data-testid="original-time"
              className="crypt-well px-2.5 py-1 text-parchment tabular-nums"
            >
              Original time: {originalTimeDisplay}
            </span>
          </div>
        </div>
      </div>
    );
  };

  const renderTransportDeck = () => {
    if (timeline.length === 0) return null;
    const progressPct = Math.round(
      (Math.min(playbackIndex, timeline.length) / Math.max(1, timeline.length)) * 100
    );

    return (
      <div className="sticky bottom-3 z-30 max-w-5xl mx-auto px-4 sm:px-6">
        <div className="crypt-panel-engraved bg-[#0b0d11]/95 backdrop-blur-md p-3.5 sm:p-4 space-y-3 shadow-2xl">
          {/* Interactive Timeline Scrubber Track */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-ash">
              <div className="flex items-center gap-2">
                <span className="uppercase tracking-wider text-dust text-[10px]">
                  Timeline Scrubber
                </span>
                <span className="text-emerald-300 tabular-nums font-semibold">
                  seq {seqBounds.fromSeq}..{seqBounds.toSeq}
                </span>
              </div>
              <span className="text-parchment tabular-nums">
                Event {Math.min(playbackIndex, timeline.length)} of {timeline.length}
              </span>
            </div>

            <div className="relative h-6 flex items-center">
              <div className="w-full h-1.5 rounded-full bg-recessed border border-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-150"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={timeline.length}
                value={Math.min(playbackIndex, timeline.length)}
                onChange={(e) => {
                  setIsPlaying(false);
                  setPlaybackIndex(Number(e.target.value));
                }}
                aria-label="Replay timeline scrubber"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>

            {/* Phase Chapter Markers */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-dust mr-1">
                Chapters:
              </span>
              {chapterMarkers.map((marker) => (
                <button
                  key={marker.label}
                  type="button"
                  onClick={() => {
                    setIsPlaying(false);
                    setPlaybackIndex(marker.index);
                  }}
                  className="px-2 py-0.5 rounded text-[10px] border border-white/10 bg-neutral-900/80 text-ash hover:text-emerald-300 hover:border-emerald-500/40 transition-colors cursor-pointer"
                >
                  {marker.label}
                </button>
              ))}
            </div>
          </div>

          {/* Transport Controls & Keyboard Hints (Replay playback only; NO run action buttons) */}
          <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="replay-toggle-play"
                onClick={handleTogglePlay}
                className="crypt-btn-primary px-3 py-1 rounded text-xs font-mono"
              >
                {isPlaying ? "Pause" : isAtEnd ? "Replay Again" : "Play"}
              </button>
              <button
                type="button"
                onClick={handleStepBackward}
                disabled={playbackIndex <= 0}
                className="crypt-btn-ghost px-2.5 py-1 rounded text-xs font-mono"
              >
                Step -1
              </button>
              <button
                type="button"
                data-testid="replay-step-forward"
                disabled={isAtEnd}
                onClick={handleStepForward}
                className="crypt-btn-ghost px-2.5 py-1 rounded text-xs font-mono"
              >
                Step +1
              </button>
              <button
                type="button"
                data-testid="replay-jump-end"
                onClick={() => {
                  setIsPlaying(false);
                  setPlaybackIndex(timeline.length);
                }}
                className="crypt-btn-ghost px-2.5 py-1 rounded text-xs font-mono"
              >
                Jump to End
              </button>
              <button
                type="button"
                data-testid="replay-reset"
                onClick={() => {
                  setIsPlaying(false);
                  setPlaybackIndex(0);
                  setElapsedReplayMs(0);
                }}
                className="crypt-btn-ghost px-2.5 py-1 rounded text-xs font-mono"
              >
                Reset
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Speed Selector Pills */}
              <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
                {SPEED_OPTIONS.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    onClick={() => setPlaybackSpeed(speed)}
                    className={`px-2 py-0.5 rounded text-xs border transition-colors cursor-pointer ${
                      playbackSpeed === speed
                        ? "bg-emerald-950/60 text-emerald-300 border-[var(--necromancy-emerald-border)] font-semibold"
                        : "bg-neutral-900/80 text-ash border-white/10 hover:text-bone"
                    }`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              {/* Keyboard Hints */}
              <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-dust">
                <span className="crypt-kbd">Space</span>
                <span>play</span>
                <span className="crypt-kbd">←/→</span>
                <span>step</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div
        data-ui-element="replay-player"
        data-ui-state={uiState}
        data-ui-variant={uiVariant}
        className="space-y-4 font-mono pb-8"
      >
        {renderBanner()}
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div
            data-testid="replay-loading"
            className="crypt-panel p-5 text-ash text-sm flex items-center gap-3"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400 crypt-pulse-emerald" aria-hidden="true" />
            <span>Loading replay events...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-ui-element="replay-player"
        data-ui-state={uiState}
        data-ui-variant={uiVariant}
        className="space-y-4 font-mono pb-8"
      >
        {renderBanner()}
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div
            data-testid="replay-error"
            className="crypt-panel p-5 border-rose-500/40 bg-rose-950/20 text-rose-300 text-sm border-l-2 border-l-rose-500"
          >
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (timeline.length === 0) {
    return (
      <div
        data-ui-element="replay-player"
        data-ui-state={uiState}
        data-ui-variant={uiVariant}
        className="space-y-4 font-mono pb-8"
      >
        {renderBanner()}
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div
            data-testid="replay-empty"
            className="crypt-panel p-8 text-ash text-sm text-center"
          >
            No events recorded for this run.
          </div>
        </div>
      </div>
    );
  }

  // Find the last event index among actual events to label stopped point if killed
  let lastActualEventSeq: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    lastActualEventSeq = events[i].seq;
    break;
  }

  // Render timeline items
  let prevEventTs: number | null = null;

  return (
    <div
      data-testid="replay-player"
      data-ui-element="replay-player"
      data-ui-state={uiState}
      data-ui-variant={uiVariant}
      className="space-y-5 font-mono pb-8"
    >
      {renderBanner()}

      <div className="max-w-5xl mx-auto px-4 sm:px-6 space-y-3">
        {visibleItems.map((item, idx) => {
          if (item.type === "gap") {
            const gapLabel =
              item.fromSeq === item.toSeq
                ? `seq ${item.fromSeq}`
                : `seq ${item.fromSeq} to ${item.toSeq}`;
            return (
              <div
                key={`gap-${item.fromSeq}-${item.toSeq}-${idx}`}
                data-testid="replay-gap"
                className="p-3 rounded-lg border border-dashed border-amber-500/50 bg-amber-950/20 text-amber-300 text-xs font-mono flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden="true" />
                <span>Gap: missing event {gapLabel}</span>
              </div>
            );
          }

          const ev = item.event;
          // Requirement 33.9: label every shortened wait
          const isShortenedWait =
            prevEventTs !== null && ev.ts - prevEventTs > 2000;
          prevEventTs = ev.ts;

          // Requirement 33.8: show "Redacted by the owner" at admin.redaction
          const isRedaction = ev.kind === "admin.redaction";

          // Requirement 39.5: for killed run, label last stored event as stopped point
          const isLastEventAndKilled = isKilled && ev.seq === lastActualEventSeq;

          return (
            <div
              key={`event-${ev.seq}`}
              data-testid={`replay-event-${ev.seq}`}
              className="crypt-panel p-4 text-xs space-y-2.5 hover:border-white/20 transition-colors"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="event-seq"
                    className="font-bold text-ash tabular-nums"
                  >
                    #{ev.seq}
                  </span>
                  <span
                    data-testid="event-kind"
                    className={`px-2 py-0.5 rounded font-semibold border ${getEventKindBadgeClass(ev.kind)}`}
                  >
                    {ev.kind}
                  </span>
                  <span
                    data-testid="event-actor"
                    className="text-ash font-mono"
                  >
                    actor: {ev.actor}
                  </span>
                  {ev.taskId ? (
                    <span className="crypt-well px-1.5 py-0.5 text-dust font-mono">
                      task: {ev.taskId}
                    </span>
                  ) : null}
                  {isShortenedWait ? (
                    <span
                      data-testid="shortened-wait-label"
                      className="px-2 py-0.5 rounded text-[11px] bg-amber-950/40 text-amber-300 border border-[var(--arcane-amber-border)]"
                    >
                      Shortened wait
                    </span>
                  ) : null}
                </div>

                <div className="text-dust text-[11px] tabular-nums">
                  {formatTimestamp(ev.ts)}
                </div>
              </div>

              {isRedaction ? (
                <div
                  data-testid="redaction-label"
                  className="crypt-well p-3 text-ash italic border-white/15"
                >
                  Redacted by the owner
                </div>
              ) : (
                <>
                  <p
                    data-testid="event-summary"
                    className="text-sm text-bone leading-snug break-words"
                  >
                    {summarizeEvent(ev)}
                  </p>
                  <details data-testid="event-raw">
                    <summary className="cursor-pointer select-none w-fit text-[11px] text-dust hover:text-ash">
                      Raw event
                    </summary>
                    <div className="overflow-x-auto mt-2">
                      <pre className="crypt-well font-mono text-[11px] whitespace-pre-wrap break-all text-parchment p-3">
                        {JSON.stringify(ev.data, null, 2)}
                      </pre>
                    </div>
                  </details>
                </>
              )}

              {isLastEventAndKilled ? (
                <div
                  data-testid="run-stopped-label"
                  className="p-2.5 rounded border border-[var(--crimson-seal-border)] border-l-2 border-l-rose-500 bg-rose-950/30 text-rose-300 text-xs font-semibold"
                >
                  Point where the run was stopped
                </div>
              ) : null}
            </div>
          );
        })}

        {/* Requirement 39.4: at last event, show ended state and offer the Reliquary */}
        {isAtEnd ? (
          <div
            data-testid="replay-ended-state"
            className="crypt-panel-engraved p-6 text-center space-y-3 mt-6"
          >
            <div className="flex justify-center text-emerald-400">
              <CryptOrnament kind="wax-seal" className="w-7 h-7" />
            </div>
            <div className="text-sm font-semibold text-bone">
              Run ended
            </div>
            <p className="text-xs text-ash">
              All stored events for this run have been replayed.
            </p>
            <div>
              <Link
                href={`/runs/${encodeURIComponent(runId)}/relic`}
                data-testid="replay-reliquary-link"
                className="crypt-btn-primary px-4 py-2 text-xs rounded"
              >
                View Reliquary
              </Link>
            </div>
          </div>
        ) : null}
      </div>

      {renderTransportDeck()}
    </div>
  );
}
