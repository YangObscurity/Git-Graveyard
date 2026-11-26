import React from "react";
import {
  UiDebugGallery,
  type UiDebugGalleryMode,
} from "@/components/debug/UiDebugGallery";
import {
  DEBUG_PRESET_MODES,
  DEBUG_VIEWPORT_MODES,
  type DebugPresetMode,
  type DebugViewportMode,
} from "@/lib/debug/ui-fixtures";

export interface DebugUiPageProps {
  searchParams?:
    | Promise<Record<string, string | string[] | undefined>>
    | Record<string, string | string[] | undefined>;
}

function pickFirst(
  val: string | string[] | undefined
): string | undefined {
  if (Array.isArray(val)) return val[0];
  return val;
}

export default async function DebugUiPage({ searchParams }: DebugUiPageProps) {
  const resolved = searchParams ? await Promise.resolve(searchParams) : {};
  const uiDebug = pickFirst(resolved.uiDebug);
  const rawState = pickFirst(resolved.state);
  const rawViewport = pickFirst(resolved.viewport);
  const rawElement = pickFirst(resolved.element);
  const rawMode = pickFirst(resolved.mode);

  const allowed =
    process.env.NODE_ENV !== "production" || uiDebug === "1";

  if (!allowed) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone font-mono p-6 flex items-center justify-center">
        <div
          data-testid="ui-debug-locked"
          data-ui-element="ui-debug-gallery"
          data-ui-state="locked"
          className="crypt-panel-engraved max-w-md w-full p-6 text-center space-y-2"
        >
          <div className="text-xs uppercase tracking-widest text-amber-400 font-semibold">
            Access Restricted
          </div>
          <p className="text-sm text-parchment">
            UI Lab locked — append ?uiDebug=1 to inspect primitives
          </p>
        </div>
      </main>
    );
  }

  const initialPreset: DebugPresetMode = (
    DEBUG_PRESET_MODES as readonly string[]
  ).includes(rawState ?? "")
    ? (rawState as DebugPresetMode)
    : "active";

  const initialViewport: DebugViewportMode = (
    DEBUG_VIEWPORT_MODES as readonly string[]
  ).includes(rawViewport ?? "")
    ? (rawViewport as DebugViewportMode)
    : "full";

  const initialMode: UiDebugGalleryMode =
    rawMode === "live" ? "live" : "fixtures";

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone font-mono">
      <UiDebugGallery
        initialPreset={initialPreset}
        initialViewport={initialViewport}
        initialElement={rawElement ?? ""}
        initialOutline={uiDebug === "1"}
        initialMode={initialMode}
      />
    </main>
  );
}
