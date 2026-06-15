import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: [
    `:host { display: block; width: 100vw; height: 100vh; overflow: hidden; }`,
  ],
})
export class AppComponent {}
