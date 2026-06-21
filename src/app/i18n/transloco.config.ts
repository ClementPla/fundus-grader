import { Injectable, isDevMode } from "@angular/core";
import {
  provideTransloco,
  Translation,
  TranslocoLoader,
} from "@jsverse/transloco";
import { of } from "rxjs";
import { en } from "./en";
import { fr } from "./fr";

export type Lang = "fr" | "en";
export const AVAILABLE_LANGS: Lang[] = ["fr", "en"];
export const DEFAULT_LANG: Lang = "fr";
export const LANG_STORAGE_KEY = "fg.lang";

const DICTS: Record<Lang, Translation> = { fr, en };

/**
 * Loads translations from bundled TypeScript objects rather than over HTTP.
 * This avoids relying on Tauri's custom asset protocol and keeps the
 * dictionaries type-checked alongside the rest of the app.
 */
@Injectable({ providedIn: "root" })
export class InlineTranslocoLoader implements TranslocoLoader {
  getTranslation(lang: string) {
    return of(DICTS[lang as Lang] ?? DICTS[DEFAULT_LANG]);
  }
}

export function provideAppTransloco() {
  return provideTransloco({
    config: {
      availableLangs: AVAILABLE_LANGS,
      defaultLang: DEFAULT_LANG,
      fallbackLang: DEFAULT_LANG,
      reRenderOnLangChange: true,
      missingHandler: { useFallbackTranslation: true },
      prodMode: !isDevMode(),
    },
    loader: InlineTranslocoLoader,
  });
}
