import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CasePayload, SubmitPayload } from '../../types';

/**
 * Reader's grading inputs. The "AI influence" field is gone; the session
 * component handles the post-submit AI reveal flow externally.
 *
 * Two new inputs control the session's two-phase submit:
 *   - `disabled`     — when true, all inputs/buttons are locked
 *                      (session uses this while showing the AI reveal panel)
 *   - `submitLabel`  — text on the submit button (e.g. "Confirm final" when
 *                      the reader is editing after seeing AI)
 */
@Component({
  selector: 'app-grading-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <form class="form" (submit)="onSubmit($event)" [class.disabled]="disabled">
      <div class="section">
        <label>ICDR grade</label>
        <div class="opts">
          <button
            type="button"
            *ngFor="let opt of icdrOpts"
            [class.selected]="icdr() === opt.value"
            (click)="setIcdr(opt.value)"
            [disabled]="disabled"
          >
            <span class="opt-label">{{ opt.value }}</span>
            <span class="faint opt-desc">{{ opt.label }}</span>
          </button>
        </div>
      </div>

      <div class="section">
        <label>DME</label>
        <div class="opts">
          <button
            type="button"
            *ngFor="let opt of dmeOpts"
            [class.selected]="dme() === opt.value"
            (click)="setDme(opt.value)"
            [disabled]="disabled"
          >
            <span class="opt-label">{{ opt.short }}</span>
            <span class="faint opt-desc">{{ opt.label }}</span>
          </button>
        </div>
      </div>

      <div class="section">
        <label>Confidence <span class="faint">— how sure are you?</span></label>
        <div class="compact opts">
          <button
            type="button"
            *ngFor="let n of [1,2,3,4,5]"
            [class.selected]="confidence() === n"
            (click)="setConfidence(n)"
            [disabled]="disabled"
          >
            {{ n }}
          </button>
        </div>
        <span class="compact-help faint">1 = guessing, 5 = certain</span>
      </div>

      <div class="section">
        <label>Difficulty <span class="faint">— how hard was this case?</span></label>
        <div class="opts">
          <button
            type="button"
            *ngFor="let opt of difficultyOpts"
            [class.selected]="difficulty() === opt.value"
            (click)="setDifficulty(opt.value)"
            [disabled]="disabled"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="section">
        <label>Notes <span class="faint">— optional, free text</span></label>
        <textarea
          [(ngModel)]="notes"
          name="notes"
          rows="2"
          [disabled]="disabled"
        ></textarea>
      </div>

      <div class="actions">
        <button
          type="button"
          class="danger"
          (click)="skip.emit()"
          [disabled]="disabled"
        >
          Skip case
        </button>
        <span class="spacer"></span>
        <button
          type="submit"
          class="primary"
          [disabled]="disabled || !isValid()"
        >
          {{ submitLabel }}
        </button>
      </div>
      <p class="faint">Submission is final.</p>
    </form>
  `,
  styles: [`
    .form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 14px;
      height: 100%;
      box-sizing: border-box;
      overflow-y: auto;
    }
    .form.disabled { opacity: 0.55; pointer-events: none; }
    .section { display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 12px; color: var(--text-dim); font-weight: 500; }
    .opts { display: flex; flex-wrap: wrap; gap: 6px; }
    .opts button {
      display: flex; flex-direction: column; align-items: flex-start;
      padding: 8px 10px; min-width: 56px; flex: 1 1 0;
    }
    .opts.compact button {
      flex: 0 0 auto; min-width: 36px; align-items: center; padding: 8px;
    }
    .opt-label { font-size: 14px; font-weight: 500; }
    .opt-desc { font-size: 11px; }
    .opts button.selected {
      background: var(--accent); color: white; border-color: var(--accent);
    }
    .opts button.selected .opt-desc { color: rgba(255,255,255,0.8); }
    textarea {
      width: 100%; box-sizing: border-box; resize: vertical; font-family: inherit;
    }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .compact-help { margin-top: 2px; }
  `],
})
export class GradingFormComponent implements OnChanges {
  @Input({ required: true }) caseData!: CasePayload;
  @Input() disabled = false;
  @Input() submitLabel = 'Submit';

  @Output() submitGrading = new EventEmitter<{ icdr: number; dme: number; notes: string | null; confidence: number; difficulty: number }>();
  @Output() skip = new EventEmitter<void>();
  @Output() fieldChanged = new EventEmitter<{ field: string; value: unknown }>();

  icdr = signal<number | null>(null);
  dme = signal<number | null>(null);
  confidence = signal<number | null>(null);
  difficulty = signal<number | null>(null);
  notes = '';

  icdrOpts = [
    { value: 0, label: 'No DR' },
    { value: 1, label: 'Mild NPDR' },
    { value: 2, label: 'Moderate NPDR' },
    { value: 3, label: 'Severe NPDR' },
    { value: 4, label: 'PDR' },
  ];
  dmeOpts = [
    { value: 0, short: 'No', label: 'No DME' },
    { value: 1, short: 'Mild', label: 'Mild' },
    { value: 2, short: 'Mod', label: 'Moderate' },
    { value: 3, short: 'Sev', label: 'Severe' },
  ];
  difficultyOpts = [
    { value: 1, label: 'Easy' },
    { value: 2, label: 'Moderate' },
    { value: 3, label: 'Hard' },
  ];

  ngOnChanges(changes: SimpleChanges) {
    if (changes['caseData']) this.reset();
  }

  reset() {
    this.icdr.set(null);
    this.dme.set(null);
    this.confidence.set(null);
    this.difficulty.set(null);
    this.notes = '';
  }

  setIcdr(v: number) {
    const prev = this.icdr();
    this.icdr.set(v);
    this.fieldChanged.emit({ field: 'icdr', value: prev !== null && prev !== v ? { from: prev, to: v } : v });
  }
  setDme(v: number) {
    const prev = this.dme();
    this.dme.set(v);
    this.fieldChanged.emit({ field: 'dme', value: prev !== null && prev !== v ? { from: prev, to: v } : v });
  }
  setConfidence(v: number) { this.confidence.set(v); this.fieldChanged.emit({ field: 'confidence', value: v }); }
  setDifficulty(v: number) { this.difficulty.set(v); this.fieldChanged.emit({ field: 'difficulty', value: v }); }

  isValid(): boolean {
    return this.icdr() !== null
        && this.dme() !== null
        && this.confidence() !== null
        && this.difficulty() !== null;
  }

  onSubmit(ev: Event) {
    ev.preventDefault();
    if (!this.isValid() || this.disabled) return;
    this.submitGrading.emit({
      icdr: this.icdr()!,
      dme: this.dme()!,
      notes: this.notes.trim() ? this.notes.trim() : null,
      confidence: this.confidence()!,
      difficulty: this.difficulty()!,
    });
  }
}
