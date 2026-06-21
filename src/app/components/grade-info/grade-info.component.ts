import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { TranslocoPipe } from "@jsverse/transloco";

interface GradeInfo {
  value: number;
  /** Universal short code (e.g. "R0", "M2"); not translated. The label and
   *  description are pulled from the `grades.*` translation keys by value. */
  short: string;
  image: string | null;
}

/**
 * Collapsible left panel for the editor: a vertical accordion with one panel
 * per grade (ICDR "R" grades and DME "M" grades), each holding a short
 * description of that disease stage.
 *
 * A panel auto-expands either when the reader clicks its header, or when the
 * matching grade is chosen in the grading form. Within each group (R / M) only
 * one panel is open at a time; R and M are independent, so one of each can be
 * open simultaneously. When the whole panel is collapsed the accordion state is
 * still tracked internally — it just isn't visible.
 */
@Component({
  selector: "app-grade-info",
  standalone: true,
  imports: [CommonModule, TranslocoPipe],
  template: `
    <div class="grade-info" [class.collapsed]="collapsed()">
      <!-- Collapsed rail: just a button to reopen -->
      <button
        *ngIf="collapsed()"
        class="rail-toggle"
        (click)="collapsed.set(false)"
        [title]="'gradeInfo.show' | transloco"
      >
        <span class="chev">›</span>
        <span class="rail-label">{{ "gradeInfo.grades" | transloco }}</span>
      </button>

      <ng-container *ngIf="!collapsed()">
        <div class="head">
          <h3>{{ "gradeInfo.title" | transloco }}</h3>
          <button
            class="collapse"
            (click)="collapsed.set(true)"
            [title]="'gradeInfo.hide' | transloco"
          >
            ‹
          </button>
        </div>

        <div class="group">
          <div class="group-title">{{ "gradeInfo.icdrGroup" | transloco }}</div>
          <div
            class="acc-item"
            *ngFor="let g of icdrInfo"
            [class.open]="openIcdr() === g.value"
            [class.selected]="selectedIcdr === g.value"
            [style.--sev-color]="severityColor('icdr', g.value)"
          >
            <button class="acc-head" (click)="toggleIcdr(g.value)">
              <span class="badge">{{ g.short }}</span>
              <span class="acc-label">{{
                "grades.icdr." + g.value + ".label" | transloco
              }}</span>
              <span class="chev">{{ openIcdr() === g.value ? "▾" : "▸" }}</span>
            </button>
            <div class="acc-body" *ngIf="openIcdr() === g.value">
              <p>{{ "grades.icdr." + g.value + ".desc" | transloco }}</p>
            @if(g.image){
              <img [src]="g.image" [alt]="g.short" />
            }
            </div>

          </div>
        </div>

        <div class="group">
          <div class="group-title">{{ "gradeInfo.dmeGroup" | transloco }}</div>
          <div
            class="acc-item"
            *ngFor="let g of dmeInfo"
            [class.open]="openDme() === g.value"
            [class.selected]="selectedDme === g.value"
            [style.--sev-color]="severityColor('dme', g.value)"
          >
            <button class="acc-head" (click)="toggleDme(g.value)">
              <span class="badge">{{ g.short }}</span>
              <span class="acc-label">{{
                "grades.dme." + g.value + ".label" | transloco
              }}</span>
              <span class="chev">{{ openDme() === g.value ? "▾" : "▸" }}</span>
            </button>
            <div class="acc-body" *ngIf="openDme() === g.value">
              <p>{{ "grades.dme." + g.value + ".desc" | transloco }}</p>
            </div>
          </div>
        </div>
      </ng-container>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .grade-info {
        height: 100%;
        box-sizing: border-box;
        background: var(--bg-elev);
        border-right: 1px solid var(--border);
        overflow-y: auto;
        padding: 12px;
        width: 280px;
      }
      .grade-info.collapsed {
        width: 40px;
        padding: 8px 0;
        overflow: hidden;
      }
      .rail-toggle {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        width: 100%;
        background: none;
        border: none;
        color: var(--text-dim);
        padding: 8px 0;
      }
      .rail-toggle .rail-label {
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-size: 12px;
        letter-spacing: 0.05em;
      }
      .rail-toggle .chev {
        font-size: 16px;
      }
      .head {
        display: flex;
        align-items: center;
        margin-bottom: 12px;
      }
      .head h3 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        flex: 1;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-dim);
      }
      .collapse {
        padding: 2px 8px;
        font-size: 14px;
      }
      .group {
        margin-bottom: 16px;
      }
      .group-title {
        font-size: 11px;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 6px;
      }
      .acc-item {
        border: 1px solid var(--border);
        /* Subtle severity cue: a muted left stripe (green→red, set per grade
           via the --sev-color custom property). */
        border-left: 3px solid
          color-mix(in srgb, var(--sev-color, var(--border)) 55%, transparent);
        border-radius: var(--radius);
        margin-bottom: 6px;
        overflow: hidden;
        background: var(--bg);
      }
      .acc-item.selected {
        border-color: var(--accent);
        /* Keep the severity stripe legible (a touch stronger) when selected. */
        border-left-color: color-mix(
          in srgb,
          var(--sev-color, var(--accent)) 75%,
          transparent
        );
      }
      .acc-head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        background: none;
        border: none;
        border-radius: 0;
        text-align: left;
        padding: 8px 10px;
      }
      .acc-item.selected .acc-head {
        background: var(--accent-dim);
      }
      .badge {
        font-family: var(--font-mono);
        font-size: 12px;
        font-weight: 600;
        min-width: 28px;
        /* Tint the grade code with its severity color (subtle secondary cue). */
        color: color-mix(in srgb, var(--sev-color, var(--text)) 80%, var(--text));
      }
      .acc-label {
        flex: 1;
        font-size: 13px;
        color: var(--text-dim);
      }
      .acc-item.selected .acc-label {
        color: var(--text);
      }
      .chev {
        color: var(--text-faint);
        font-size: 12px;
      }
      .acc-body {
        padding: 0 10px 10px 10px;
      }
      .acc-body p {
        margin: 6px 0 0 0;
        font-size: 12.5px;
        line-height: 1.45;
        color: var(--text-dim);
        /* Honor \n line breaks in multi-line grade descriptions. */
        white-space: pre-line;
      }
      .acc-body img {
        display: block;
        width: 100%;
        height: auto;
        margin-top: 8px;
        border-radius: 4px;
        border: 1px solid var(--border);
      }
    `,
  ],
})
export class GradeInfoComponent implements OnChanges {
  /** Currently selected grades in the form; drive auto-expansion. */
  @Input() selectedIcdr: number | null = null;
  @Input() selectedDme: number | null = null;

  collapsed = signal(false);
  openIcdr = signal<number | null>(null);
  openDme = signal<number | null>(null);

  // ICDR (International Clinical Diabetic Retinopathy) severity scale. Labels
  // and descriptions live under `grades.icdr.*` in the translation dictionaries.
  icdrInfo: GradeInfo[] = [
    { value: 0, short: "R0", image: null },
    { value: 1, short: "R1", image: null },
    { value: 2, short: "R2", image: "assets/HEM_4.png" },
    { value: 3, short: "R3", image: "assets/irregularities.png" },
    { value: 4, short: "R4", image: "assets/IRMA.png" },
    { value: 6, short: "R6", image: null },
  ];

  // DME (Diabetic Macular Edema) scale. Labels and descriptions live under
  // `grades.dme.*` in the translation dictionaries.
  dmeInfo: GradeInfo[] = [
    { value: 0, short: "M0", image: null },
    { value: 1, short: "M1", image: null },
    { value: 2, short: "M2", image: null },
    { value: 6, short: "M6", image: null },
  ];

  ngOnChanges(changes: SimpleChanges) {
    // Auto-expand the panel matching a newly chosen grade (closing the other in
    // its group). A null selection (e.g. on case reset) collapses the group.
    if (changes["selectedIcdr"]) this.openIcdr.set(this.selectedIcdr);
    if (changes["selectedDme"]) this.openDme.set(this.selectedDme);
  }

  toggleIcdr(value: number) {
    this.openIcdr.set(this.openIcdr() === value ? null : value);
  }
  toggleDme(value: number) {
    this.openDme.set(this.openDme() === value ? null : value);
  }

  // Severity color ramp (green → red), kept close to the theme's success/warn/
  // danger hues. Ungradable (6) is neutral grey since it isn't a severity.
  private readonly SEVERITY_COLORS: Record<"icdr" | "dme", Record<number, string>> = {
    icdr: {
      0: "#5fb874", // No DR — green (--success)
      1: "#9bbf5f", // Mild — yellow-green
      2: "#e0a437", // Moderate — amber (--warn)
      3: "#e0793f", // Severe — orange
      4: "#e35d6a", // PDR — red (--danger)
      6: "#6b7280", // Ungradable — grey (--text-faint)
    },
    dme: {
      0: "#5fb874", // No DME — green
      1: "#e0a437", // Mild — amber
      2: "#e35d6a", // Severe — red
      6: "#6b7280", // Ungradable — grey
    },
  };

  severityColor(scale: "icdr" | "dme", value: number): string {
    return this.SEVERITY_COLORS[scale][value] ?? "#6b7280";
  }
}
