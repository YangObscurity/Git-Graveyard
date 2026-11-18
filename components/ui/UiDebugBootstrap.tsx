"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { installUiDebugApi } from "@/lib/ui-debug";
import { UiDebugLiveHud } from "@/components/debug/UiDebugLiveHud";

export function UiDebugBootstrap() {
  let hookPathname: string | null = null;
  try {
    hookPathname = usePathname();
  } catch {
    hookPathname = null;
  }

  const [hudEnabled, setHudEnabled] = useState(false);

  useEffect(() => {
    installUiDebugApi();
    const sync = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        setHudEnabled(params.get("uiDebug") === "1");
      } catch {
        setHudEnabled(false);
      }
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
    };
  }, [hookPathname]);

  if (!hudEnabled) {
    return null;
  }

  return <UiDebugLiveHud />;
}
