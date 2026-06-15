import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { SessionComponent } from './components/session/session.component';
import { AdminComponent } from './components/admin/admin.component';

export const ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', component: LoginComponent },
  { path: 'session', component: SessionComponent },
  { path: 'admin', component: AdminComponent },
  { path: '**', redirectTo: 'login' },
];
