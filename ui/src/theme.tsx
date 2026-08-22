import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "wts.appearance.theme.v1";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

const fallbackThemeContext: ThemeContextValue = {
  preference: "system",
  resolvedTheme: "light",
  setPreference: () => undefined,
  toggleTheme: () => undefined,
};

const ThemeContext = createContext<ThemeContextValue>(fallbackThemeContext);

function availableStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function loadThemePreference(
  storage: Pick<Storage, "getItem"> | undefined = availableStorage(),
): ThemePreference {
  if (!storage) return "system";
  try {
    return normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : preference;
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  documentTarget: Pick<Document, "documentElement" | "querySelector"> | undefined =
    globalThis.document,
) {
  if (!documentTarget) return;
  documentTarget.documentElement.dataset.theme = theme;
  documentTarget.documentElement.style.colorScheme = theme;
  documentTarget
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0f141c" : "#f2f4f7");
}

function currentSystemPreference() {
  return globalThis.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false;
}

export function initializeTheme() {
  const preference = loadThemePreference();
  const resolvedTheme = resolveTheme(preference, currentSystemPreference());
  applyResolvedTheme(resolvedTheme);
  return { preference, resolvedTheme };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(loadThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    currentSystemPreference,
  );
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const media = globalThis.matchMedia?.(SYSTEM_DARK_QUERY);
    if (!media) return;
    const update = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    setSystemPrefersDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      availableStorage()?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A private or locked-down webview may reject local persistence.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setPreference]);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
      toggleTheme,
    }),
    [preference, resolvedTheme, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
