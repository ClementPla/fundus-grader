import { Component, EventEmitter, Input, Output } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TranslocoPipe } from "@jsverse/transloco";

@Component({
  selector: "app-ai-reveal",
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  template: `
    <div class="reveal-card">
      <div class="header">
        <h3>{{ "aiReveal.title" | transloco }}</h3>
        <p class="faint">{{ "aiReveal.intro" | transloco }}</p>
      </div>

      <div class="grades">
        <div class="grade-col">
          <span class="col-label">{{ "aiReveal.yourGrade" | transloco }}</span>
          <div
            class="grade-row"
            [class.match]="bothMatch()"
            [class.ungradable]="humanIcdr === 6"
          >
            <span class="grade-name">ICDR</span>
            <span class="grade-value">R{{ humanIcdr }}</span>
            <span class="grade-desc faint">{{
              "grades.icdr." + humanIcdr + ".label" | transloco
            }}</span>
          </div>
          <div
            class="grade-row"
            [class.match]="bothMatch()"
            [class.ungradable]="humanDme === 6"
          >
            <span class="grade-name">{{ "grading.dme" | transloco }}</span>
            <span class="grade-value">M{{ humanDme }}</span>
            <span class="grade-desc faint">{{
              "grades.dme." + humanDme + ".label" | transloco
            }}</span>
          </div>
        </div>

        <div class="divider"></div>

        <div class="grade-col ai">
          <span class="col-label">{{
            "aiReveal.aiPrediction" | transloco
          }}</span>
          <div
            class="grade-row"
            [class.mismatch]="!icdrMatch()"
            [class.match]="icdrMatch()"
            [class.ungradable]="aiIcdr === 6"
          >
            <span class="grade-name">ICDR</span>
            <span class="grade-value">R{{ aiIcdr }}</span>
            <span class="grade-desc faint">{{
              "grades.icdr." + aiIcdr + ".label" | transloco
            }}</span>
          </div>
          <div
            class="grade-row"
            [class.mismatch]="!dmeMatch()"
            [class.match]="dmeMatch()"
            [class.ungradable]="aiDme === 6"
          >
            <span class="grade-name">{{ "grading.dme" | transloco }}</span>
            <span class="grade-value">M{{ aiDme }}</span>
            <span class="grade-desc faint">{{
              "grades.dme." + aiDme + ".label" | transloco
            }}</span>
          </div>
        </div>
      </div>

      <div class="status" *ngIf="bothMatch()">
        <span class="status-pill agree">{{
          "aiReveal.agrees" | transloco
        }}</span>
      </div>
      <div class="status" *ngIf="!bothMatch()">
        <span class="status-pill disagree">
          {{ "aiReveal.disagreesOn" | transloco }}
          <ng-container *ngIf="!icdrMatch() && !dmeMatch()"
            >ICDR &amp; {{ "grading.dme" | transloco }}</ng-container
          >
          <ng-container *ngIf="!icdrMatch() && dmeMatch()">ICDR</ng-container>
          <ng-container *ngIf="icdrMatch() && !dmeMatch()">{{
            "grading.dme" | transloco
          }}</ng-container>
        </span>
      </div>

      <div class="comment">
        <label>
          {{ "aiReveal.comment" | transloco }}
          <span class="faint">{{ "aiReveal.commentHint" | transloco }}</span>
        </label>
        <textarea
          [(ngModel)]="comment"
          name="adjudicationComment"
          rows="2"
          [placeholder]="'aiReveal.commentPh' | transloco"
        ></textarea>
      </div>

      <div class="actions">
        <button class="primary" (click)="keep.emit(commentOrNull())">
          {{ "aiReveal.keep" | transloco }}
        </button>
        <button (click)="update.emit(commentOrNull())">
          {{ "aiReveal.update" | transloco }}
        </button>
      </div>
      <p class="faint actions-help">{{ "aiReveal.help" | transloco }}</p>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .reveal-card {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 14px;
        height: 100%;
        box-sizing: border-box;
        overflow-y: auto;
      }
      .header h3 {
        margin: 0 0 4px 0;
        font-size: 15px;
        font-weight: 500;
      }
      .header .faint {
        font-size: 12px;
        line-height: 1.45;
      }

      .grades {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 10px;
        align-items: stretch;
        background: var(--bg-elev-2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 12px;
      }
      .grade-col {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .grade-col.ai .col-label {
        color: var(--accent);
      }
      .col-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-dim);
        font-weight: 500;
      }
      .divider {
        width: 1px;
        background: var(--border);
        align-self: stretch;
      }

      .grade-row {
        display: grid;
        grid-template-columns: 36px auto 1fr;
        gap: 4px;
        align-items: baseline;
        padding: 4px 6px;
        border-radius: 4px;
        transition: background 120ms;
      }
      .grade-row.mismatch {
        background: color-mix(in srgb, var(--danger) 14%, transparent);
        border-left: 2px solid var(--danger);
        padding-left: 4px;
      }
      .grade-row.ungradable {
        background: color-mix(in srgb, var(--warn) 12%, transparent);
        border-left: 2px solid var(--warn);
        padding-left: 4px;
      }
      /* mismatch + ungradable: mismatch wins visually */
      .grade-row.mismatch.ungradable {
        background: color-mix(in srgb, var(--danger) 14%, transparent);
        border-left-color: var(--danger);
      }
      .grade-name {
        font-size: 11px;
        color: var(--text-dim);
        font-weight: 500;
      }
      .grade-value {
        font-size: 18px;
        font-weight: 500;
        font-family: var(--font-mono);
      }
      .grade-desc {
        font-size: 11px;
      }

      .status {
        display: flex;
      }
      .status-pill {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 500;
      }
      .status-pill.agree {
        background: color-mix(in srgb, var(--success) 18%, var(--bg-elev-2));
        color: var(--success);
        border: 1px solid var(--success);
      }
      .status-pill.disagree {
        background: color-mix(in srgb, var(--danger) 14%, var(--bg-elev-2));
        color: var(--danger);
        border: 1px solid var(--danger);
      }

      .actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }
      .actions button {
        flex: 1;
      }
      .actions-help {
        font-size: 11px;
        margin: 0;
      }
      .comment {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .comment label {
        font-size: 12px;
        color: var(--text-dim);
        font-weight: 500;
      }
      .comment textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        font-family: inherit;
      }
    `,
  ],
})
export class AiRevealComponent {
  @Input({ required: true }) humanIcdr!: number;
  @Input({ required: true }) humanDme!: number;
  @Input({ required: true }) aiIcdr!: number;
  @Input({ required: true }) aiDme!: number;

  /** Emit the adjudication comment (or null when blank) alongside the decision. */
  @Output() keep = new EventEmitter<string | null>();
  @Output() update = new EventEmitter<string | null>();

  comment = "";

  commentOrNull(): string | null {
    const t = this.comment.trim();
    return t ? t : null;
  }

  icdrMatch(): boolean {
    return this.humanIcdr === this.aiIcdr;
  }
  dmeMatch(): boolean {
    return this.humanDme === this.aiDme;
  }
  bothMatch(): boolean {
    return this.icdrMatch() && this.dmeMatch();
  }
}
