import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LanguageService } from './services/language.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: [
    `:host { display: block; width: 100vw; height: 100vh; overflow: hidden; }`,
  ],
})
export class AppComponent {
  // Injected so the stored language preference is applied at app startup.
  constructor(private _lang: LanguageService) {}
}
