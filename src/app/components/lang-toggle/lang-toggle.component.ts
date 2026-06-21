import { Component } from "@angular/core";
import { LanguageService } from "../../services/language.service";

/**
 * Small FR/EN switch. The button shows the language you'd switch *to*, so when
 * the app is in French it reads "EN".
 */
@Component({
  selector: "app-lang-toggle",
  standalone: true,
  template: `
    <button
      class="lang-toggle"
      (click)="lang.toggle()"
      [title]="lang.current() === 'fr' ? 'Switch to English' : 'Passer en français'"
    >
      {{ lang.current() === "fr" ? "EN" : "FR" }}
    </button>
  `,
  styles: [
    `
      .lang-toggle {
        font-size: 12px;
        padding: 4px 10px;
        font-family: var(--font-mono);
        letter-spacing: 0.04em;
      }
    `,
  ],
})
export class LangToggleComponent {
  constructor(public lang: LanguageService) {}
}
