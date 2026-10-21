import { config } from "../../package.json";
import {
  getDeepSeekSearchCredential,
  resolveEffectiveWebAccessProvider,
} from "./deepseekSearchKey";
import type { WebAccessProviderId, WebAccessProviderSetting } from "./types";

export type { WebAccessProviderId, WebAccessProviderSetting } from "./types";

export const TAVILY_API_KEY_PREF = `${config.prefsPrefix}.tavilyApiKey`;
export const ANYSEARCH_API_KEY_PREF = `${config.prefsPrefix}.anysearchApiKey`;
export const WEB_ACCESS_PROVIDER_PREF = `${config.prefsPrefix}.webAccessProvider`;

const PROVIDER_SETTINGS: readonly WebAccessProviderSetting[] = [
  "auto",
  "tavily",
  "anysearch",
  "deepseek",
];

/** The saved choice as the settings select shows it; unknown values read as "auto". */
export function getWebAccessProviderSetting(): WebAccessProviderSetting {
  try {
    const value = Zotero.Prefs.get(WEB_ACCESS_PROVIDER_PREF, true);
    return PROVIDER_SETTINGS.find((setting) => setting === value) || "auto";
  } catch {
    return "auto";
  }
}

/** The provider that web_search and web_read call after "auto" is resolved. */
export function getWebAccessProvider(): WebAccessProviderId {
  return resolveEffectiveWebAccessProvider({
    setting: getWebAccessProviderSetting(),
    hasTavilyKey: hasTavilyApiKey(),
    hasDeepSeekKey: () => Boolean(getDeepSeekSearchCredential()),
  });
}

export function setWebAccessProvider(value: WebAccessProviderSetting): void {
  if (!PROVIDER_SETTINGS.includes(value)) {
    throw new Error("Unsupported web access provider.");
  }
  Zotero.Prefs.set(WEB_ACCESS_PROVIDER_PREF, value, true);
}

/** True when the effective provider can make a call: the tools are offered. */
export function isWebAccessConfigured(): boolean {
  switch (getWebAccessProvider()) {
    case "anysearch":
      return true;
    case "deepseek":
      return Boolean(getDeepSeekSearchCredential());
    default:
      return hasTavilyApiKey();
  }
}

/**
 * Deliberately no environment, model-key, or cross-provider fallback for
 * Tavily and AnySearch. DeepSeek is the one exception: its key comes from an
 * official DeepSeek model profile (see deepseekSearchKey.ts).
 */
export function getAnysearchApiKey(): string {
  try {
    return String(Zotero.Prefs.get(ANYSEARCH_API_KEY_PREF, true) || "").trim();
  } catch {
    return "";
  }
}

export function setAnysearchApiKey(value: string): void {
  Zotero.Prefs.set(ANYSEARCH_API_KEY_PREF, value.trim(), true);
}

export function getTavilyApiKey(): string {
  try {
    return String(Zotero.Prefs.get(TAVILY_API_KEY_PREF, true) || "").trim();
  } catch {
    return "";
  }
}

export function setTavilyApiKey(value: string): void {
  Zotero.Prefs.set(TAVILY_API_KEY_PREF, value.trim(), true);
}

export function hasTavilyApiKey(): boolean {
  return Boolean(getTavilyApiKey());
}
