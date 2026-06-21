import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ApiService } from '../../services/api.service';
import { AppStateService } from '../../services/app-state.service';
import { LangToggleComponent } from '../lang-toggle/lang-toggle.component';
import { Reader } from '../../types';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, LangToggleComponent],
  template: `
    <div class="wrap">
      <div class="panel card">
        <div class="title-row">
          <h1>{{ 'common.appName' | transloco }}</h1>
          <span class="spacer"></span>
          <app-lang-toggle></app-lang-toggle>
        </div>

        <!-- Step 1: project file -->
        <div class="col" *ngIf="!appState.project()">
          <p class="dim">{{ 'login.openPrompt' | transloco }}</p>
          <button class="primary" (click)="pickProject()" [disabled]="busy()">
            {{ (busy() ? 'login.opening' : 'login.openProject') | transloco }}
          </button>
          <p class="faint" *ngIf="error()">{{ error() }}</p>
        </div>

        <!-- Step 2: reader identification -->
        <div class="col" *ngIf="appState.project() && !appState.reader()">
          <p class="dim">
            {{ 'login.projectLoaded' | transloco }} <span class="mono">{{ appState.project()!.project_path }}</span>
          </p>
          <p class="dim">
            {{ 'login.resultsSaved' | transloco }}
            <span class="mono">{{ appState.project()!.results_path }}</span>
          </p>

          <div *ngIf="readers().length > 0" class="col">
            <label>{{ 'login.continueExisting' | transloco }}</label>
            <div class="readers-list">
              <button
                *ngFor="let r of readers()"
                (click)="loginExisting(r)"
                [disabled]="busy()"
              >
                {{ r.surname }}, {{ r.name }}
              </button>
            </div>
            <div class="separator"><span>{{ 'login.orRegister' | transloco }}</span></div>
          </div>

          <label>{{ 'login.surname' | transloco }}</label>
          <input [(ngModel)]="surname" (keyup.enter)="registerNew()" [placeholder]="'login.surnamePh' | transloco" />
          <label>{{ 'login.givenName' | transloco }}</label>
          <input [(ngModel)]="name" (keyup.enter)="registerNew()" [placeholder]="'login.givenNamePh' | transloco" />
          <button class="primary" (click)="registerNew()" [disabled]="busy() || !canRegister()">
            {{ 'login.continue' | transloco }}
          </button>
          <p class="faint" *ngIf="error()">{{ error() }}</p>

          <div class="footer-row">
            <button (click)="reopenProject()">{{ 'login.changeProject' | transloco }}</button>
            <span class="spacer"></span>
            <button (click)="goAdmin()">{{ 'login.administrator' | transloco }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
    .wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: 480px;
      max-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .title-row { display: flex; align-items: center; gap: 8px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 500; }
    label { font-size: 12px; color: var(--text-dim); }
    .readers-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .separator {
      display: flex; align-items: center; gap: 8px;
      color: var(--text-faint); font-size: 12px;
      margin: 8px 0;
    }
    .separator::before, .separator::after {
      content: ''; flex: 1; height: 1px; background: var(--border);
    }
    .footer-row { display: flex; gap: 8px; margin-top: 12px; }
    `,
  ],
})
export class LoginComponent implements OnInit {
  busy = signal(false);
  error = signal<string | null>(null);
  readers = signal<Reader[]>([]);
  name = '';
  surname = '';

  constructor(
    private api: ApiService,
    public appState: AppStateService,
    private router: Router,
  ) {}

  async ngOnInit() {
    if (this.appState.project()) {
      await this.refreshReaders();
    }
  }

  async pickProject() {
    this.error.set(null);
    this.busy.set(true);
    try {
      const path = await this.api.pickProjectFile();
      if (!path) {
        this.busy.set(false);
        return;
      }
      const proj = await this.api.openProject(path);
      this.appState.setProject(proj);
      await this.refreshReaders();
    } catch (e: unknown) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  async reopenProject() {
    this.appState.setProject(null);
    this.appState.clearForLogout();
    this.readers.set([]);
    await this.pickProject();
  }

  async refreshReaders() {
    try {
      this.readers.set(await this.api.listReaders());
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  canRegister(): boolean {
    return this.name.trim().length > 0 && this.surname.trim().length > 0;
  }

  async loginExisting(r: Reader) {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.loginReader(r.id);
      this.appState.setReader(r);
      this.router.navigate(['/session']);
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  async registerNew() {
    if (!this.canRegister()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const reader = await this.api.registerReader(this.name.trim(), this.surname.trim());
      this.appState.setReader(reader);
      this.router.navigate(['/session']);
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  goAdmin() {
    this.router.navigate(['/admin']);
  }

  private errorOf(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  }
}
