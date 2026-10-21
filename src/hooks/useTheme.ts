/**
 * Light/dark theme for the whole app.
 *
 * The theme is applied as <html data-theme="light|dark">; every colour in
 * the app is a custom property defined per theme in components/theme.css,
 * so nothing else needs to re-render when it changes. The one exception is
 * the Ace editors, whose theme is a JS option: App passes `aceTheme` to
 * them.
 *
 * Starting theme: the user's last explicit choice (localStorage), else the
 * operating system's preference. Until the user picks one, the app follows
 * the OS setting live (e.g. an automatic switch at sunset). index.html runs
 * the same logic inline before first paint, so there's no white flash on
 * load in dark mode; this hook then takes over.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "mips-sim-theme";

function storedTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // storage blocked (private mode, sandboxed iframe, ...)
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export interface ThemeHandle {
  theme: Theme;
  toggle: () => void;
  /** Ace editor theme id matching `theme`. */
  aceTheme: string;
}

export function useTheme(): ThemeHandle {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow the OS setting until the user makes an explicit choice.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      if (storedTheme() === null) setTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not remembered across visits, but still applied now.
      }
      return next;
    });
  }, []);

  return { theme, toggle, aceTheme: theme === "dark" ? "ace/theme/tomorrow_night" : "ace/theme/chrome" };
}