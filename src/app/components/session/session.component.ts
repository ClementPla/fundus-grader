import { Component, OnDestroy, OnInit, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AppStateService } from '../../services/app-state.service';
import { IdleService } from '../../services/idle.service';
import { ViewerComponent } from '../viewer/viewer.component';
import { GradingFormComponent } from '../grading-form/grading-form.component';
import { AiRevealComponent } from '../ai-reveal/ai-reveal.component';
import { AiDecision, CasePayload, SubmitPayload } from '../../types';


type Stage = 'grading' | 'ai_reveal' | 'editing_after_ai';

interface PendingGrade {
  icdr: number;
  dme: number;
  notes: string | null;
  confidence: number;
  difficulty: number;
}

@Component({
  selector: 'app-session',
  standalone: true,
  imports: [CommonModule, ViewerComponent, GradingFormComponent, AiRevealComponent],
  template: `
    <div class="session-root">
      <div class="header">
        <span class="header-item">
          <span class="dim">Reader</span>
          {{ appState.reader()?.surname }}, {{ appState.reader()?.name }}
        </span>
        <span class="header-item">
          <span class="dim">Phase</span>
          <span class="phase-tag" [class.ai]="phase() === 'ai'">
            {{ phase() === 'ai' ? 'AI assisted' : 'No AI' }}
          </span>
        </span>
        <span class="header-item" *ngIf="caseData()?.is_calibration">
          <span class="cal-tag">Calibration case</span>
        </span>
        <span class="header-item">
          <span class="dim">Progress</span>
          {{ progress().done }} / {{ progress().total }}
        </span>
        <span class="spacer"></span>
        <button (click)="quit()">Exit session</button>
      </div>

      <div class="main" *ngIf="caseData() as cd">
        <div class="viewer-pane">
          <app-viewer
            #viewer
            [caseData]="cd"
            [classes]="appState.session()!.classes"
            [overlayStyle]="appState.session()!.overlay_style"
            [preprocessingAvailable]="appState.session()!.preprocessing_available"
          ></app-viewer>
        </div>
        <div class="form-pane">
          <!-- AI reveal swaps in over the form when in ai_reveal stage -->
          <app-ai-reveal
            *ngIf="stage() === 'ai_reveal' && pendingGrade() && cd.ai_icdr !== null && cd.ai_dme !== null"
            [humanIcdr]="pendingGrade()!.icdr"
            [humanDme]="pendingGrade()!.dme"
            [aiIcdr]="cd.ai_icdr!"
            [aiDme]="cd.ai_dme!"
            (keep)="onKeepGrade()"
            (update)="onUpdateGrade()"
          ></app-ai-reveal>

          <app-grading-form
            *ngIf="stage() !== 'ai_reveal'"
            [caseData]="cd"
            [disabled]="busy()"
            [submitLabel]="stage() === 'editing_after_ai' ? 'Confirm final' : 'Submit'"
            (submitGrading)="onSubmit($event)"
            (skip)="onSkip()"
            (fieldChanged)="onFieldChanged($event)"
          ></app-grading-form>
        </div>
      </div>

      <div class="empty" *ngIf="!caseData() && !busy() && !done()">
        <p class="dim">Waiting…</p>
      </div>

      <div class="done" *ngIf="done()">
        <div class="panel">
          <h2>Session complete</h2>
          <p class="dim">You have graded all {{ progress().total }} cases for this phase.</p>
          <p class="dim">Thank you — you may close the application.</p>
          <button (click)="quit()">Exit</button>
        </div>
      </div>

      <div class="error" *ngIf="error()">
        <div class="panel">
          <h2>Error</h2>
          <p>{{ error() }}</p>
          <button (click)="retry()">Retry</button>
          <button (click)="quit()">Exit</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .session-root { display: flex; flex-direction: column; height: 100vh; }
    .header {
      display: flex; align-items: center; gap: 16px;
      padding: 8px 14px;
      background: var(--bg-elev); border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .header-item { display: flex; gap: 6px; align-items: baseline; }
    .dim { color: var(--text-dim); font-size: 12px; }
    .phase-tag {
      padding: 2px 8px; border-radius: 4px;
      background: var(--bg-elev-2); border: 1px solid var(--border); font-size: 12px;
    }
    .phase-tag.ai { background: var(--accent-dim); color: white; border-color: var(--accent); }
    .cal-tag {
      padding: 2px 8px; border-radius: 4px;
      background: var(--warn); color: #1a1a1a; font-size: 12px; font-weight: 500;
    }
    .main {
      flex: 1; display: grid; grid-template-columns: 1fr 380px; min-height: 0;
    }
    .viewer-pane { min-width: 0; min-height: 0; overflow: hidden; }
    .form-pane {
      border-left: 1px solid var(--border);
      background: var(--bg);
      overflow: hidden;
    }
    .empty, .done, .error {
      flex: 1; display: flex; align-items: center; justify-content: center;
    }
    .panel { max-width: 480px; }
  `],
})
export class SessionComponent implements OnInit, OnDestroy {
  @ViewChild('viewer') viewer?: ViewerComponent;

  busy = signal(false);
  error = signal<string | null>(null);
  caseData = signal<CasePayload | null>(null);
  phase = signal<'no_ai' | 'ai'>('no_ai');
  progress = signal({ done: 0, total: 0 });
  done = signal(false);
  idleThresholdMs = 15_000;

  stage = signal<Stage>('grading');
  pendingGrade = signal<PendingGrade | null>(null);
  private aiRevealAt: number | null = null;

  constructor(
    private api: ApiService,
    public appState: AppStateService,
    private router: Router,
    private idle: IdleService,
  ) {}

  async ngOnInit() {
    if (!this.appState.project() || !this.appState.reader()) {
      this.router.navigate(['/login']);
      return;
    }
    await this.startOrRefresh();
  }

  ngOnDestroy() {
    this.idle.stop();
  }

  private async startOrRefresh() {
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await this.api.startSession();
      this.appState.setSession(session);
      this.phase.set(session.phase);
      this.progress.set({ done: session.progress.done, total: session.progress.total });
      const admin = await this.api.adminStatus();
      this.idleThresholdMs = admin.idle_threshold_ms;
      if (!session.next_case) {
        this.done.set(true);
        this.caseData.set(null);
        return;
      }
      await this.loadCase(session.next_case.assignment_id);
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadCase(assignmentId: number) {
    this.idle.stop();
    this.busy.set(true);
    try {
      const data = await this.api.startCase(assignmentId);
      this.caseData.set(data);
      this.stage.set('grading');
      this.pendingGrade.set(null);
      this.aiRevealAt = null;
      this.idle.start('macula', this.idleThresholdMs);
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- Submit pipeline ----------

  /**
   * Form's submit handler. Decides whether to go through AI reveal or
   * straight to finalSubmit based on phase + presence of AI prediction.
   */
  async onSubmit(grade: PendingGrade) {
    const cd = this.caseData();
    if (!cd) return;

    if (this.stage() === 'editing_after_ai') {
      // Second submit after AI reveal: 'changed' if any value differs from
      // pre-AI; otherwise still record as 'changed' since they entered the
      // edit flow (their decision was to update, even if they reverted).
      const pre = this.pendingGrade();
      const payload: SubmitPayload = {
        ...grade,
        pre_ai_icdr: pre?.icdr ?? null,
        pre_ai_dme:  pre?.dme  ?? null,
        ai_icdr_shown: cd.ai_icdr,
        ai_dme_shown:  cd.ai_dme,
        ai_decision: 'changed',
      };
      void this.api.logEvent({
        event_type: 'ai_decision',
        view: null,
        payload: {
          decision: 'changed',
          pre_icdr: pre?.icdr ?? null, pre_dme: pre?.dme ?? null,
          final_icdr: grade.icdr,      final_dme: grade.dme,
          ai_icdr: cd.ai_icdr,         ai_dme: cd.ai_dme,
          latency_ms: this.aiRevealAt !== null ? Date.now() - this.aiRevealAt : null,
        },
      });
      return this.finalSubmit(payload);
    }

    // Initial submit
    if (this.phase() === 'ai' && cd.ai_icdr !== null && cd.ai_dme !== null) {
      // Capture pre-AI grade, swap form for reveal.
      this.pendingGrade.set(grade);
      this.aiRevealAt = Date.now();
      this.stage.set('ai_reveal');
      void this.api.logEvent({
        event_type: 'ai_revealed',
        view: null,
        payload: {
          pre_icdr: grade.icdr, pre_dme: grade.dme,
          ai_icdr: cd.ai_icdr,  ai_dme: cd.ai_dme,
        },
      });
      return;
    }

    // no_ai phase, OR AI phase with no prediction available.
    const decision: AiDecision | null =
      this.phase() === 'ai' ? 'no_prediction' : null;
    const payload: SubmitPayload = {
      ...grade,
      pre_ai_icdr: null,
      pre_ai_dme: null,
      ai_icdr_shown: null,
      ai_dme_shown: null,
      ai_decision: decision,
    };
    return this.finalSubmit(payload);
  }

  onKeepGrade() {
    const cd = this.caseData();
    const pre = this.pendingGrade();
    if (!cd || !pre) return;
    const payload: SubmitPayload = {
      ...pre,
      pre_ai_icdr: pre.icdr,
      pre_ai_dme:  pre.dme,
      ai_icdr_shown: cd.ai_icdr,
      ai_dme_shown:  cd.ai_dme,
      ai_decision: 'kept',
    };
    void this.api.logEvent({
      event_type: 'ai_decision',
      view: null,
      payload: {
        decision: 'kept',
        pre_icdr: pre.icdr,  pre_dme: pre.dme,
        ai_icdr: cd.ai_icdr, ai_dme: cd.ai_dme,
        latency_ms: this.aiRevealAt !== null ? Date.now() - this.aiRevealAt : null,
      },
    });
    void this.finalSubmit(payload);
  }

  onUpdateGrade() {
    this.stage.set('editing_after_ai');
    void this.api.logEvent({
      event_type: 'ai_update_chosen',
      view: null,
      payload: {
        latency_ms: this.aiRevealAt !== null ? Date.now() - this.aiRevealAt : null,
      },
    });
  }

  /** Send the SubmitPayload to backend, advance to next case. */
  private async finalSubmit(payload: SubmitPayload) {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.submitCase(payload);
      this.idle.stop();
      const session = await this.api.startSession();
      this.appState.setSession(session);
      this.phase.set(session.phase);
      this.progress.set({ done: session.progress.done, total: session.progress.total });
      if (!session.next_case) {
        this.done.set(true);
        this.caseData.set(null);
      } else {
        await this.loadCase(session.next_case.assignment_id);
      }
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- misc handlers ----------

  async onSkip() {
    if (!confirm('Skip this case? It will be re-queued at the end.')) return;
    try {
      await this.api.skipCase();
      this.idle.stop();
      await this.startOrRefresh();
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  onFieldChanged(ev: { field: string; value: unknown }) {
    void this.api.logEvent({
      event_type: 'grade_change',
      view: null,
      payload: { field: ev.field, value: ev.value as Record<string, unknown> | string | number | null },
    });
  }

  async retry() {
    await this.startOrRefresh();
  }

  async quit() {
    this.idle.stop();
    this.appState.clearForLogout();
    this.router.navigate(['/login']);
  }

  private errorOf(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
    return String(e);
  }
}
