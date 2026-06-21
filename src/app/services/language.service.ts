import { Injectable, signal } from "@angular/core";
import { TranslocoService } from "@jsverse/transloco";
import {
  AVAILABLE_LANGS,
  DEFAULT_LANG,
  Lang,
  LANG_STORAGE_KEY,
} from "../i18n/transloco.config";

/**
 * App language state. Wraps TranslocoService with a signal for templates,
 * persistence to localStorage, and a French default. Construct it early (it's
 * injected by AppComponent) so the stored preference is applied before any
 * view renders.
 */
@Injectable({ providedIn: "root" })
export class LanguageService {
  readonly current = signal<Lang>(DEFAULT_LANG);

  constructor(private transloco: TranslocoService) {
    let initial: Lang = DEFAULT_LANG;
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null;
      if (stored && AVAILABLE_LANGS.includes(stored)) initial = stored;
    } catch {
      // localStorage unavailable — fall back to the default language.
    }
    this.set(initial);
  }

  set(lang: Lang) {
    this.transloco.setActiveLang(lang);
    this.current.set(lang);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Persistence is best-effort.
    }
  }

  toggle() {
    this.set(this.current() === "fr" ? "en" : "fr");
  }
}
