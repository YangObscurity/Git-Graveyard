import React from "react";
import Link from "next/link";
import { CryptOrnament } from "./CryptOrnament";
import { StateGlyph, type StateFamily, type StateGlyphVariant } from "./StateGlyph";

export type RitualStationKey = "gate" | "tomb" | "pact" | "legion" | "relic";

export type RitualStationState = "done" | "now" | "next" | "later" | "locked";

export interface RitualStationInput {
  key: RitualStationKey;
  label?: string;
  state?: RitualStationState;
  href?: string | null;
  reachable?: boolean;
  lockedReason?: string | null;
}

export interface RitualRibbonProps {
  currentStation?: RitualStationKey;
  reachableStations?: readonly RitualStationKey[];
  stations?: readonly RitualStationInput[];
  hrefs?: Partial<Record<RitualStationKey, string | null>>;
  lockedReasons?: Partial<Record<RitualStationKey, string | null>>;
  replay?: boolean;
  className?: string;
}

const DEFAULT_STATIONS: readonly {
  key: RitualStationKey;
  label: string;
  defaultHref: string;
}[] = [
  { key: "gate", label: "Gate", defaultHref: "/" },
  { key: "tomb", label: "Tombstone", defaultHref: "/tomb" },
  { key: "pact", label: "Pact", defaultHref: "#pact" },
  { key: "legion", label: "Legion", defaultHref: "#legion" },
  { key: "relic", label: "Reliquary", defaultHref: "#relic" },
];

const STATE_DISPLAY: Record<
  RitualStationState,
  { text: string; family: StateFamily; glyph: StateGlyphVariant }
> = {
  done: { text: "Done", family: "risen", glyph: "check" },
  now: { text: "Now", family: "wait", glyph: "flame" },
  next: { text: "Next", family: "idle", glyph: "dot" },
  later: { text: "Later", family: "idle", glyph: "dash" },
  locked: { text: "Locked", family: "idle", glyph: "lock" },
};

function inferStationState(
  idx: number,
  currentIdx: number,
  reachable: boolean
): RitualStationState {
  if (idx === currentIdx) return "now";
  if (!reachable) return "locked";
  if (currentIdx >= 0 && idx < currentIdx) return "done";
  if (currentIdx >= 0 && idx === currentIdx + 1) return "next";
  return "later";
}

export function RitualRibbon({
  currentStation,
  reachableStations,
  stations,
  hrefs,
  lockedReasons,
  replay = false,
  className = "",
}: RitualRibbonProps) {
  const stationInputs = new Map<RitualStationKey, RitualStationInput>();
  if (stations) {
    for (const s of stations) {
      stationInputs.set(s.key, s);
    }
  }

  const orderedDefs = stations && stations.length > 0
    ? stations.map((s) => {
        const fallback = DEFAULT_STATIONS.find((d) => d.key === s.key)!;
        return {
          key: s.key,
          label: s.label ?? fallback.label,
          defaultHref: fallback.defaultHref,
        };
      })
    : DEFAULT_STATIONS;

  const currentIdx = currentStation
    ? orderedDefs.findIndex((s) => s.key === currentStation)
    : orderedDefs.findIndex((s) => stationInputs.get(s.key)?.state === "now");

  const resolved = orderedDefs.map((def, idx) => {
    const input = stationInputs.get(def.key);
    const providedHref = input?.href !== undefined ? input.href : hrefs?.[def.key];

    let isReachable: boolean;
    if (input?.reachable !== undefined) {
      isReachable = input.reachable;
    } else if (reachableStations !== undefined) {
      isReachable = reachableStations.includes(def.key);
    } else if (input?.state !== undefined) {
      isReachable = input.state !== "locked" && providedHref !== null;
    } else if (providedHref !== undefined) {
      isReachable = providedHref !== null;
    } else {
      isReachable = currentIdx >= 0 ? idx <= currentIdx : def.key === "gate";
    }

    const isCurrent = currentStation
      ? def.key === currentStation
      : input?.state === "now";

    const state: RitualStationState =
      input?.state ?? inferStationState(idx, currentIdx, isReachable);

    const href = isReachable ? providedHref ?? def.defaultHref : null;
    const lockedReason =
      input?.lockedReason ??
      lockedReasons?.[def.key] ??
      (isReachable ? null : `${def.label} is not open yet.`);

    return {
      key: def.key,
      label: def.label,
      state,
      isCurrent,
      isReachable,
      href,
      lockedReason,
    };
  });

  return (
    <nav
      aria-label="Ritual journey"
      data-ui-element="ritual-ribbon"
      className={`flex items-center gap-4 ${className}`.trim()}
    >
      <ol className="crypt-ribbon">
        {resolved.map((station, idx) => {
          const prevState = idx > 0 ? resolved[idx - 1].state : undefined;
          const display = STATE_DISPLAY[station.state];
          const lit = station.state === "done" || station.state === "now";
          const flicker = station.state === "now";

          const inner = (
            <>
              <CryptOrnament
                kind="candle"
                size="sm"
                lit={lit}
                flicker={flicker}
              />
              <span className="crypt-ribbon__name">{station.label}</span>
              <span className="crypt-ribbon__state">
                <StateGlyph family={display.family} variant={display.glyph} />
                <span>{display.text}</span>
              </span>
              {!station.isReachable && station.lockedReason && (
                <span className="sr-only">{station.lockedReason}</span>
              )}
            </>
          );

          return (
            <li
              key={station.key}
              className="crypt-ribbon__station"
              data-station={station.key}
              data-state={station.state}
              data-prev={prevState === "done" ? "done" : undefined}
            >
              {station.isReachable && station.href ? (
                <Link
                  href={station.href}
                  aria-current={station.isCurrent ? "step" : undefined}
                  className="crypt-ribbon__link"
                >
                  {inner}
                </Link>
              ) : (
                <span
                  aria-current={station.isCurrent ? "step" : undefined}
                  aria-disabled="true"
                  title={station.lockedReason ?? undefined}
                  className="crypt-ribbon__link"
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {replay && (
        <span className="crypt-kiro" aria-current="page">
          <StateGlyph family="kiro" variant="eye" />
          <span>Replay</span>
        </span>
      )}
    </nav>
  );
}
