import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { provideRouter } from '@angular/router';
import { ROUTES } from './app/app.routes';
import { provideAppTransloco } from './app/i18n/transloco.config';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(ROUTES), provideAppTransloco()],
}).catch((err) => console.error(err));
