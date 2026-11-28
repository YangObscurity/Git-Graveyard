import localFont from "next/font/local";

export const bodyFont = localFont({
  src: "./fonts/AtkinsonHyperlegibleNext-latin-wght.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--font-body-face",
  fallback: ["Atkinson Hyperlegible", "Segoe UI", "system-ui", "sans-serif"],
});

export const monoFont = localFont({
  src: "./fonts/AtkinsonHyperlegibleMono-latin-wght.woff2",
  weight: "400 600",
  style: "normal",
  display: "swap",
  variable: "--font-mono-face",
  fallback: [
    "ui-monospace",
    "Cascadia Code",
    "JetBrains Mono",
    "Consolas",
    "Menlo",
    "monospace",
  ],
});

export const ritualFont = localFont({
  src: "./fonts/GrenzeGotisch-latin-wght.woff2",
  weight: "600",
  style: "normal",
  display: "swap",
  variable: "--font-ritual-face",
  fallback: ["UnifrakturMaguntia", "Georgia", "serif"],
});

export const fontVariableClasses = `${bodyFont.variable} ${monoFont.variable} ${ritualFont.variable}`;
