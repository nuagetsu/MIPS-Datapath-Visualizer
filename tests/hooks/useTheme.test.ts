/**
 * useTheme: light/dark theme, remembered in localStorage, defaulting to (and
 * following) the OS preference until the user picks one.
 *
 * jsdom has no matchMedia, so each test installs a fake one it can flip.
 * localStorage is replaced the same way (including a version that throws, as
 * in some private-browsing modes), and everything is put back afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "../../src/hooks/useTheme";

const KEY = "mips-sim-theme";

interface FakeMediaQuery {
  matches: boolean;
  listeners: Set<() => void>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

let mq: FakeMediaQuery;
let store: Map<string, string>;
const saved: Record<string, PropertyDescriptor | undefined> = {};

function install(name: "matchMedia" | "localStorage", value: unknown) {
  if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

function fakeStorage(throws = false) {
  const fail = () => {
    throw new Error("storage blocked");
  };
  return {
    getItem: throws ? fail : (k: string) => store.get(k) ?? null,
    setItem: throws ? fail : (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

/** The OS preference changes (and its "change" listeners fire). */
function osPrefers(dark: boolean) {
  mq.matches = dark;
  act(() => mq.listeners.forEach((fn) => fn()));
}

beforeEach(() => {
  store = new Map();
  mq = {
    matches: false,
    listeners: new Set(),
    addEventListener: (_t, fn) => void mq.listeners.add(fn),
    removeEventListener: (_t, fn) => void mq.listeners.delete(fn),
  };
  install("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-color-scheme: dark)");
    return mq;
  });
  install("localStorage", fakeStorage());
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  for (const [name, desc] of Object.entries(saved)) {
    if (desc) Object.defineProperty(window, name, desc);
    else delete (window as unknown as Record<string, unknown>)[name];
    delete saved[name];
  }
});

describe("useTheme: starting theme", () => {
  it("follows the OS preference when nothing is stored", () => {
    mq.matches = true;
    expect(renderHook(() => useTheme()).result.current.theme).toBe("dark");
    mq.matches = false;
    expect(renderHook(() => useTheme()).result.current.theme).toBe("light");
  });

  it("a stored choice wins over the OS preference", () => {
    store.set(KEY, "light");
    mq.matches = true;
    expect(renderHook(() => useTheme()).result.current.theme).toBe("light");
  });

  it("ignores a stored value that isn't light or dark", () => {
    store.set(KEY, "purple");
    mq.matches = true;
    expect(renderHook(() => useTheme()).result.current.theme).toBe("dark");
  });

  it("works when storage is blocked (falls back to the OS preference)", () => {
    install("localStorage", fakeStorage(true));
    mq.matches = true;
    expect(renderHook(() => useTheme()).result.current.theme).toBe("dark");
  });

  it("works without matchMedia (defaults to light)", () => {
    install("matchMedia", undefined);
    expect(renderHook(() => useTheme()).result.current.theme).toBe("light");
  });
});

describe("useTheme: applying and switching", () => {
  it("sets data-theme on <html>", () => {
    mq.matches = true;
    renderHook(() => useTheme());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("toggle switches theme, updates <html> and remembers the choice", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(store.get(KEY)).toBe("dark");
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
    expect(store.get(KEY)).toBe("light");
  });

  it("toggle still works when storage is blocked (just not remembered)", () => {
    install("localStorage", fakeStorage(true));
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
  });

  it("gives the matching Ace editor theme", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.aceTheme).toBe("ace/theme/chrome");
    act(() => result.current.toggle());
    expect(result.current.aceTheme).toBe("ace/theme/tomorrow_night");
  });
});

describe("useTheme: following the OS live", () => {
  it("follows OS changes until the user picks a theme", () => {
    const { result } = renderHook(() => useTheme());
    osPrefers(true);
    expect(result.current.theme).toBe("dark");
    osPrefers(false);
    expect(result.current.theme).toBe("light");
  });

  it("stops following once the user has chosen", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle()); // dark, stored
    osPrefers(false);
    expect(result.current.theme).toBe("dark");
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useTheme());
    expect(mq.listeners.size).toBe(1);
    unmount();
    expect(mq.listeners.size).toBe(0);
  });
});
