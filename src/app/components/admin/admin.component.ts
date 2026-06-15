import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AppStateService } from '../../services/app-state.service';
import { AdminStatus, SubmissionRow } from '../../types';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="root">
      <div class="bar">
        <button (click)="back()">← Back</button>
        <h2>Administrator</h2>
        <span class="spacer"></span>
        <button *ngIf="status()?.authed" (click)="logout()">Sign out</button>
      </div>

      <div class="content">
        <!-- Project required -->
        <div class="panel" *ngIf="!appState.project()">
          <p class="dim">No project file is open.</p>
          <button (click)="back()">Go back</button>
        </div>

        <!-- First-time setup -->
        <div class="panel" *ngIf="appState.project() && status() && !appState.project()!.admin_configured && !status()!.authed">
          <h3>Set administrator password</h3>
          <p class="dim">No password is set for this project yet. Choose one now.</p>
          <input type="password" [(ngModel)]="newPassword" placeholder="New password (min 6 chars)" />
          <input type="password" [(ngModel)]="newPassword2" placeholder="Confirm" />
          <button class="primary" (click)="setPassword()" [disabled]="busy() || !canSetPassword()">
            Set password
          </button>
          <p class="faint" *ngIf="error()">{{ error() }}</p>
        </div>

        <!-- Login -->
        <div class="panel" *ngIf="appState.project() && status() && appState.project()!.admin_configured && !status()!.authed">
          <h3>Administrator login</h3>
          <input type="password" [(ngModel)]="password" placeholder="Password" (keyup.enter)="login()" />
          <button class="primary" (click)="login()" [disabled]="busy() || !password">Sign in</button>
          <p class="faint" *ngIf="error()">{{ error() }}</p>
        </div>

        <!-- Authenticated panes -->
        <ng-container *ngIf="status() && status()!.authed">
          <div class="panel">
            <h3>Study phase</h3>
            <p class="dim">
              Current phase: <strong>{{ status()!.phase === 'ai' ? 'AI assisted' : 'No AI' }}</strong>
            </p>
            <div class="row">
              <button [disabled]="status()!.phase === 'no_ai'" (click)="setPhase('no_ai')">No AI</button>
              <button [disabled]="status()!.phase === 'ai'" (click)="setPhase('ai')">AI assisted</button>
            </div>
            <p class="faint">
              Changing the phase affects all new sessions immediately. Readers in an active session
              must restart to see the change.
            </p>
          </div>

          <div class="panel">
            <h3>Submissions</h3>
            <p class="dim faint">Most recent 500. Use revert to allow a reader to re-grade a case.</p>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Reader</th>
                  <th>Phase</th>
                  <th>Case</th>
                  <th>ICDR</th>
                  <th>DME</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let s of submissions()" [class.reverted]="s.reverted">
                  <td class="mono">{{ s.submitted_at | slice:0:19 }}</td>
                  <td>{{ s.reader_surname }}, {{ s.reader_name }}</td>
                  <td>{{ s.phase }}</td>
                  <td class="mono">{{ s.case_id }}</td>
                  <td>{{ s.icdr }}</td>
                  <td>{{ s.dme }}</td>
                  <td>
                    <button
                      *ngIf="!s.reverted"
                      class="danger"
                      (click)="revert(s)"
                    >
                      Revert
                    </button>
                    <span *ngIf="s.reverted" class="faint">reverted</span>
                  </td>
                </tr>
                <tr *ngIf="submissions().length === 0">
                  <td colspan="7" class="faint">No submissions yet.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="panel">
            <h3>Export</h3>
            <p class="dim faint">
              Copy the current results SQLite file to a chosen location.
            </p>
            <button (click)="exportResults()" [disabled]="busy()">Export results…</button>
            <p class="faint" *ngIf="lastExport()">Exported to: <span class="mono">{{ lastExport() }}</span></p>
          </div>

          <div class="panel">
            <h3>Change password</h3>
            <input type="password" [(ngModel)]="newPassword" placeholder="New password" />
            <input type="password" [(ngModel)]="newPassword2" placeholder="Confirm" />
            <button (click)="setPassword()" [disabled]="busy() || !canSetPassword()">Update password</button>
          </div>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    .root { display: flex; flex-direction: column; height: 100vh; }
    .bar {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 12px;
      background: var(--bg-elev);
      border-bottom: 1px solid var(--border);
    }
    .bar h2 { margin: 0; font-size: 16px; font-weight: 500; }
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 900px;
      width: 100%;
      box-sizing: border-box;
      margin: 0 auto;
    }
    h3 { margin: 0 0 8px 0; font-size: 14px; font-weight: 500; }
    .panel { display: flex; flex-direction: column; gap: 10px; }
    input { width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--text-dim); font-weight: 500; font-size: 11px; }
    tr.reverted td { opacity: 0.5; }
    .mono { font-family: var(--font-mono); }
  `],
})
export class AdminComponent implements OnInit {
  busy = signal(false);
  error = signal<string | null>(null);
  status = signal<AdminStatus | null>(null);
  submissions = signal<SubmissionRow[]>([]);
  lastExport = signal<string | null>(null);
  password = '';
  newPassword = '';
  newPassword2 = '';

  constructor(
    private api: ApiService,
    public appState: AppStateService,
    private router: Router,
  ) {}

  async ngOnInit() {
    if (!this.appState.project()) {
      this.status.set(null);
      return;
    }
    try {
      this.status.set(await this.api.adminStatus());
      if (this.status()!.authed) {
        await this.refreshSubmissions();
      }
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  back() {
    this.router.navigate(['/login']);
  }

  canSetPassword(): boolean {
    return this.newPassword.length >= 6 && this.newPassword === this.newPassword2;
  }

  async setPassword() {
    if (!this.canSetPassword()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.adminSetPassword(this.newPassword);
      this.newPassword = '';
      this.newPassword2 = '';
      // Refresh project info to flip admin_configured.
      const proj = this.appState.project();
      if (proj) this.appState.setProject({ ...proj, admin_configured: true });
      this.status.set(await this.api.adminStatus());
      if (this.status()!.authed) {
        await this.refreshSubmissions();
      }
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  async login() {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.adminLogin(this.password);
      this.password = '';
      this.status.set(await this.api.adminStatus());
      await this.refreshSubmissions();
    } catch (e) {
      this.error.set('Incorrect password');
    } finally {
      this.busy.set(false);
    }
  }

  async logout() {
    await this.api.adminLogout();
    this.status.set(await this.api.adminStatus());
  }

  async setPhase(phase: 'no_ai' | 'ai') {
    this.busy.set(true);
    try {
      await this.api.adminSetPhase(phase);
      this.status.set(await this.api.adminStatus());
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  async refreshSubmissions() {
    try {
      this.submissions.set(await this.api.adminListSubmissions());
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  async revert(s: SubmissionRow) {
    const reason = prompt(
      `Revert submission of case ${s.case_id} by ${s.reader_surname}? Provide a reason:`,
      '',
    );
    if (!reason) return;
    try {
      await this.api.adminRevertSubmission(s.id, reason);
      await this.refreshSubmissions();
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  async exportResults() {
    this.busy.set(true);
    try {
      const dest = await this.api.pickSavePath(`fundus-grader-export-${new Date().toISOString().slice(0,10)}.sqlite`);
      if (!dest) {
        this.busy.set(false);
        return;
      }
      const path = await this.api.adminExportResults(dest);
      this.lastExport.set(path);
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  private errorOf(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  }
}
