import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";

interface GradeInfo {
  value: number;
  short: string;
  label: string;
  /** Free-text clinical description shown in the expanded accordion panel.
   *  Edit these strings to refine the guidance shown to readers. */
  desc: string;
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
  imports: [CommonModule],
  template: `
    <div class="grade-info" [class.collapsed]="collapsed()">
      <!-- Collapsed rail: just a button to reopen -->
      <button
        *ngIf="collapsed()"
        class="rail-toggle"
        (click)="collapsed.set(false)"
        title="Show grade guidance"
      >
        <span class="chev">›</span>
        <span class="rail-label">Grades</span>
      </button>

      <ng-container *ngIf="!collapsed()">
        <div class="head">
          <h3>Grade guidance</h3>
          <button
            class="collapse"
            (click)="collapsed.set(true)"
            title="Hide grade guidance"
          >
            ‹
          </button>
        </div>

        <div class="group">
          <div class="group-title">ICDR — diabetic retinopathy</div>
          <div
            class="acc-item"
            *ngFor="let g of icdrInfo"
            [class.open]="openIcdr() === g.value"
            [class.selected]="selectedIcdr === g.value"
          >
            <button class="acc-head" (click)="toggleIcdr(g.value)">
              <span class="badge">{{ g.short }}</span>
              <span class="acc-label">{{ g.label }}</span>
              <span class="chev">{{ openIcdr() === g.value ? "▾" : "▸" }}</span>
            </button>
            <div class="acc-body" *ngIf="openIcdr() === g.value">
              <p>{{ g.desc }}</p>
            </div>
          </div>
        </div>

        <div class="group">
          <div class="group-title">DME — macular edema</div>
          <div
            class="acc-item"
            *ngFor="let g of dmeInfo"
            [class.open]="openDme() === g.value"
            [class.selected]="selectedDme === g.value"
          >
            <button class="acc-head" (click)="toggleDme(g.value)">
              <span class="badge">{{ g.short }}</span>
              <span class="acc-label">{{ g.label }}</span>
              <span class="chev">{{ openDme() === g.value ? "▾" : "▸" }}</span>
            </button>
            <div class="acc-body" *ngIf="openDme() === g.value">
              <p>{{ g.desc }}</p>
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
        border-radius: var(--radius);
        margin-bottom: 6px;
        overflow: hidden;
        background: var(--bg);
      }
      .acc-item.selected {
        border-color: var(--accent);
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
        color: var(--text);
      }
      .acc-label {
        flex: 1;
        font-size: 13px;
        color: var(--text-dim);
      }
      .acc-item.selected .acc-label,
      .acc-item.selected .badge {
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

  // ICDR (International Clinical Diabetic Retinopathy) severity scale.
  // Edit these descriptions to refine the in-app guidance.
  icdrInfo: GradeInfo[] = [
    {
      value: 0,
      short: "R0",
      label: "No DR",
      desc: "No visible abnormalities.",
    },
    {
      value: 1,
      short: "R1",
      label: "Mild NPDR",
      desc: "Microaneurysms only.",
    },
    {
      value: 2,
      short: "R2",
      label: "Moderate NPDR",
      desc: "More than microaneurysms but less than severe NPDR (e.g. dot/blot hemorrhages, hard exudates, cotton-wool spots).",
    },
    {
      value: 3,
      short: "R3",
      label: "Severe NPDR",
      desc: "Any of the 4-2-1 rule and no signs of PDR: >20 intraretinal hemorrhages in each of 4 quadrants; definite venous beading in ≥2 quadrants; prominent IRMA in ≥1 quadrant.",
    },
    {
      value: 4,
      short: "R4",
      label: "PDR",
      desc: "Neovascularization (disc or elsewhere) and/or vitreous or preretinal hemorrhage.",
    },
    {
      value: 6,
      short: "R6",
      label: "Ungradable",
      desc: "Image quality is insufficient to assign a reliable DR grade.",
    },
  ];

  // DME (Diabetic Macular Edema) scale used by this study.
  dmeInfo: GradeInfo[] = [
    {
      value: 0,
      short: "M0",
      label: "No DME",
      desc: "No retinal thickening or hard exudates in the posterior pole.",
    },
    {
      value: 1,
      short: "M1",
      label: "Mild",
      desc: "Retinal thickening or hard exudates in the posterior pole but distant from the center of the macula.",
    },
    {
      value: 2,
      short: "M2",
      label: "Severe",
      desc: "Retinal thickening or hard exudates involving or approaching the center of the macula.",
    },
    {
      value: 6,
      short: "M6",
      label: "Ungradable",
      desc: "Image quality is insufficient to assign a reliable DME grade.",
    },
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
}
