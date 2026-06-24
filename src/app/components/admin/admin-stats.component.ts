import { Component, OnInit, computed, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { ApiService } from "../../services/api.service";
import { CaseRecord, Reader, ReaderStats } from "../../types";

type PhaseFilter = "all" | "no_ai" | "ai";
type CompareTarget = "reference" | "ai";

const ICDR_DOMAIN = [0, 1, 2, 3, 4, 6];
const DME_DOMAIN = [0, 1, 2, 6];
const ICDR_LABEL: Record<number, string> = {
  0: "R0", 1: "R1", 2: "R2", 3: "R3", 4: "R4", 6: "R6",
};
const DME_LABEL: Record<number, string> = { 0: "M0", 1: "M1", 2: "M2", 6: "M6" };
// Severity ramp (green→red), grey for ungradable. Mirrors the grade-info panel.
const ICDR_COLOR: Record<number, string> = {
  0: "#5fb874", 1: "#9bbf5f", 2: "#e0a437", 3: "#e0793f", 4: "#e35d6a", 6: "#6b7280",
};
const DME_COLOR: Record<number, string> = {
  0: "#5fb874", 1: "#e0a437", 2: "#e35d6a", 6: "#6b7280",
};

interface Bar {
  label: string;
  value: number;
  pct: number;
  color: string;
}
interface Confusion {
  rows: number[];
  cols: number[];
  grid: number[][];
  rowTotals: number[];
  colTotals: number[];
  max: number;
  total: number;
  diagonal: number;
  labelOf: (v: number) => string;
}

@Component({
  selector: "app-admin-stats",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./admin-stats.component.html",
  styleUrl: "./admin-stats.component.scss",
})
export class AdminStatsComponent implements OnInit {
  readers = signal<Reader[]>([]);
  selectedReaderId = signal<number | null>(null);
  raw = signal<ReaderStats | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);

  // Admin controls
  phaseFilter = signal<PhaseFilter>("all");
  includeCalibration = signal(true);
  compareTarget = signal<CompareTarget>("reference");
  // Binary-problem controls: when on, grades are thresholded (positive if
  // grade >= threshold) and binary metrics (precision/sensitivity/specificity)
  // are reported. Ungradable (6) is always excluded from agreement metrics.
  binarize = signal(false);
  icdrThreshold = signal(2);
  dmeThreshold = signal(1);
  readonly icdrThresholds = [1, 2, 3, 4];
  readonly dmeThresholds = [1, 2];
  sortKey = signal<keyof CaseRecord | "total_ms">("submitted_at");
  sortDir = signal<1 | -1>(1);

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try {
      this.readers.set(await this.api.listReaders());
    } catch (e) {
      this.error.set(this.errorOf(e));
    }
  }

  async load(readerId: number | null) {
    this.selectedReaderId.set(readerId);
    this.raw.set(null);
    if (readerId == null) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      this.raw.set(await this.api.adminReaderStats(readerId));
    } catch (e) {
      this.error.set(this.errorOf(e));
    } finally {
      this.loading.set(false);
    }
  }

  onReaderChange(v: string) {
    this.load(v ? Number(v) : null);
  }

  // ---------- filtered slices ----------

  cases = computed<CaseRecord[]>(() => {
    const r = this.raw();
    if (!r) return [];
    const ph = this.phaseFilter();
    const cal = this.includeCalibration();
    return r.cases.filter(
      (c) => (ph === "all" || c.phase === ph) && (cal || !c.is_calibration),
    );
  });
  submitted = computed(() => this.cases().filter((c) => c.submitted_at != null));
  aiCases = computed(() =>
    this.submitted().filter(
      (c) => c.ai_icdr_shown != null && c.ai_dme_shown != null,
    ),
  );

  // ---------- helpers ----------

  totalMs(c: CaseRecord): number {
    return (c.active_ms_macula ?? 0) + (c.active_ms_od ?? 0);
  }
  private mean(xs: number[]): number {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }
  private quantile(xs: number[], q: number): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return s[base + 1] !== undefined
      ? s[base] + rest * (s[base + 1] - s[base])
      : s[base];
  }
  fmtDuration(ms: number | null | undefined): string {
    if (ms == null || Number.isNaN(ms)) return "—";
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s % 60)}s`;
  }
  pct(n: number, d: number): string {
    if (!d) return "—";
    return `${Math.round((100 * n) / d)}%`;
  }
  ratio01(n: number, d: number): number {
    return d ? n / d : 0;
  }

  // ---------- KPI summary ----------

  graded = computed(() => this.submitted().length);
  pendingCount = computed(
    () =>
      this.cases().filter(
        (c) => c.status === "pending" || c.status === "in_progress",
      ).length,
  );
  meanTotalMs = computed(() => this.mean(this.submitted().map((c) => this.totalMs(c))));
  medianTotalMs = computed(() =>
    this.quantile(this.submitted().map((c) => this.totalMs(c)), 0.5),
  );
  totalCorrections = computed(() =>
    this.submitted().reduce((a, c) => a + c.n_macula_corrections, 0),
  );
  casesWithCorrection = computed(
    () => this.submitted().filter((c) => c.n_macula_corrections > 0).length,
  );
  meanCorrectionDist = computed(() => {
    const ds = this.submitted()
      .map((c) => c.macula_correction_dist_px)
      .filter((d): d is number => d != null);
    return ds.length ? this.mean(ds) : null;
  });
  ungradableCount = computed(
    () => this.submitted().filter((c) => c.icdr === 6 || c.dme === 6).length,
  );

  // ---------- AI behaviour ----------

  aiDecisionCounts = computed(() => {
    const a = this.aiCases();
    return {
      kept: a.filter((c) => c.ai_decision === "kept").length,
      changed: a.filter((c) => c.ai_decision === "changed").length,
      noPrediction: this.submitted().filter(
        (c) => c.ai_decision === "no_prediction",
      ).length,
      total: a.length,
    };
  });
  icdrDisagree = computed(
    () => this.aiCases().filter((c) => c.icdr !== c.ai_icdr_shown).length,
  );
  dmeDisagree = computed(
    () => this.aiCases().filter((c) => c.dme !== c.ai_dme_shown).length,
  );
  changedAfterReveal = computed(
    () =>
      this.aiCases().filter(
        (c) =>
          c.pre_ai_icdr != null &&
          (c.pre_ai_icdr !== c.icdr || c.pre_ai_dme !== c.dme),
      ).length,
  );
  movedTowardAI = computed(() => {
    let n = 0;
    for (const c of this.aiCases()) {
      if (c.pre_ai_icdr !== c.icdr && c.icdr === c.ai_icdr_shown) n++;
      if (c.pre_ai_dme !== c.dme && c.dme === c.ai_dme_shown) n++;
    }
    return n;
  });
  movedAwayFromAI = computed(() => {
    let n = 0;
    for (const c of this.aiCases()) {
      if (
        c.pre_ai_icdr !== c.icdr &&
        c.pre_ai_icdr === c.ai_icdr_shown &&
        c.icdr !== c.ai_icdr_shown
      )
        n++;
      if (
        c.pre_ai_dme !== c.dme &&
        c.pre_ai_dme === c.ai_dme_shown &&
        c.dme !== c.ai_dme_shown
      )
        n++;
    }
    return n;
  });
  aiDecisionBar = computed<Bar[]>(() => {
    const d = this.aiDecisionCounts();
    const tot = d.kept + d.changed + d.noPrediction || 1;
    return [
      { label: "Kept", value: d.kept, pct: (100 * d.kept) / tot, color: "#5fb874" },
      { label: "Changed", value: d.changed, pct: (100 * d.changed) / tot, color: "#e0a437" },
      { label: "No prediction", value: d.noPrediction, pct: (100 * d.noPrediction) / tot, color: "#6b7280" },
    ];
  });

  // ---------- accuracy vs reference / AI ----------

  private targetIcdr(c: CaseRecord): number | null {
    return this.compareTarget() === "reference" ? c.ref_icdr : c.ai_icdr_shown;
  }
  private targetDme(c: CaseRecord): number | null {
    return this.compareTarget() === "reference" ? c.ref_dme : c.ai_dme_shown;
  }
  icdrAgreement = computed(() => {
    const xs = this.submitted().filter((c) => this.targetIcdr(c) != null);
    const exact = xs.filter((c) => c.icdr === this.targetIcdr(c)).length;
    const within1 = xs.filter(
      (c) =>
        c.icdr !== 6 &&
        this.targetIcdr(c) !== 6 &&
        Math.abs((c.icdr ?? 0) - (this.targetIcdr(c) ?? 0)) <= 1,
    ).length;
    return { n: xs.length, exact, within1 };
  });
  dmeAgreement = computed(() => {
    const xs = this.submitted().filter((c) => this.targetDme(c) != null);
    const exact = xs.filter((c) => c.dme === this.targetDme(c)).length;
    return { n: xs.length, exact };
  });
  // Did AI change accuracy? pre-reveal vs final exact agreement with reference.
  aiAccuracyShift = computed(() => {
    const xs = this.aiCases().filter(
      (c) => c.ref_icdr != null && c.pre_ai_icdr != null,
    );
    if (!xs.length) return null;
    const preIcdr = xs.filter((c) => c.pre_ai_icdr === c.ref_icdr).length;
    const postIcdr = xs.filter((c) => c.icdr === c.ref_icdr).length;
    const preDme = xs.filter((c) => c.pre_ai_dme === c.ref_dme).length;
    const postDme = xs.filter((c) => c.dme === c.ref_dme).length;
    return { n: xs.length, preIcdr, postIcdr, preDme, postDme };
  });

  /** Exclude ungradable (6); else map to binary {0,1} at the threshold. */
  private binVal(v: number | null, thr: number): number | null {
    if (v == null || v === 6) return null;
    return v >= thr ? 1 : 0;
  }

  icdrConfusion = computed(() => {
    if (this.binarize()) {
      const t = this.icdrThreshold();
      return this.buildConfusion(
        [0, 1],
        (c) => this.binVal(c.icdr, t),
        (c) => this.binVal(this.targetIcdr(c), t),
        (i) => (i === 1 ? `≥ R${t}` : `< R${t}`),
      );
    }
    return this.buildConfusion(ICDR_DOMAIN, (c) => c.icdr, (c) => this.targetIcdr(c), (v) => ICDR_LABEL[v]);
  });
  dmeConfusion = computed(() => {
    if (this.binarize()) {
      const t = this.dmeThreshold();
      return this.buildConfusion(
        [0, 1],
        (c) => this.binVal(c.dme, t),
        (c) => this.binVal(this.targetDme(c), t),
        (i) => (i === 1 ? `≥ M${t}` : `< M${t}`),
      );
    }
    return this.buildConfusion(DME_DOMAIN, (c) => c.dme, (c) => this.targetDme(c), (v) => DME_LABEL[v]);
  });

  // ---------- agreement metrics ----------

  icdrMetrics = computed(() => this.computeMetrics("icdr"));
  dmeMetrics = computed(() => this.computeMetrics("dme"));

  private computeMetrics(kind: "icdr" | "dme") {
    const isIcdr = kind === "icdr";
    const ordinal = isIcdr ? [0, 1, 2, 3, 4] : [0, 1, 2];
    const thr = isIcdr ? this.icdrThreshold() : this.dmeThreshold();
    const readerOf = (c: CaseRecord) => (isIcdr ? c.icdr : c.dme);
    const targetOf = (c: CaseRecord) => (isIcdr ? this.targetIcdr(c) : this.targetDme(c));

    // Gradable (reader & target both present and not ungradable).
    const pairs: [number, number][] = [];
    let excluded = 0;
    for (const c of this.submitted()) {
      const rv = readerOf(c);
      const tv = targetOf(c);
      if (rv == null || tv == null) continue;
      if (rv === 6 || tv === 6) {
        excluded++;
        continue;
      }
      pairs.push([rv, tv]);
    }
    const n = pairs.length;
    const correct = pairs.filter(([r, t]) => r === t).length;

    let binary = null;
    if (this.binarize()) {
      let tp = 0, fp = 0, fn = 0, tn = 0;
      for (const [r, t] of pairs) {
        const rp = r >= thr; // reader positive
        const tt = t >= thr; // target (truth) positive
        if (rp && tt) tp++;
        else if (rp && !tt) fp++;
        else if (!rp && tt) fn++;
        else tn++;
      }
      const safe = (a: number, b: number) => (b ? a / b : NaN);
      binary = {
        thr,
        tp, fp, fn, tn,
        precision: safe(tp, tp + fp),
        sensitivity: safe(tp, tp + fn),
        specificity: safe(tn, tn + fp),
        accuracy: safe(tp + tn, n),
        f1: safe(2 * tp, 2 * tp + fp + fn),
        kappa: this.cohen(
          pairs.map(([r, t]) => [r >= thr ? 1 : 0, t >= thr ? 1 : 0]),
          [0, 1],
          false,
        ),
      };
    }
    return {
      n,
      excluded,
      accuracy: n ? correct / n : NaN,
      kappa: this.cohen(pairs, ordinal, false),
      kappaQuad: this.cohen(pairs, ordinal, true),
      binary,
    };
  }

  /** Cohen's kappa over a fixed ordinal `domain`. Quadratic weights when
   *  requested (penalty grows with the squared distance between categories). */
  private cohen(pairs: [number, number][], domain: number[], quadratic: boolean): number {
    const k = domain.length;
    const index = new Map(domain.map((v, i) => [v, i]));
    const obs = domain.map(() => domain.map(() => 0));
    let total = 0;
    for (const [r, t] of pairs) {
      const ri = index.get(r);
      const ci = index.get(t);
      if (ri == null || ci == null) continue;
      obs[ri][ci]++;
      total++;
    }
    if (!total) return NaN;
    const row = obs.map((r) => r.reduce((a, b) => a + b, 0));
    const col = domain.map((_, j) => obs.reduce((a, r) => a + r[j], 0));
    let num = 0;
    let den = 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const d = quadratic ? (i - j) ** 2 / (k - 1) ** 2 : i === j ? 0 : 1;
        num += d * obs[i][j];
        den += (d * row[i] * col[j]) / total;
      }
    }
    return den === 0 ? NaN : 1 - num / den;
  }

  fmtKappa(x: number): string {
    return Number.isNaN(x) ? "—" : x.toFixed(3);
  }
  fmtRate(x: number): string {
    return Number.isNaN(x) ? "—" : `${(100 * x).toFixed(0)}%`;
  }
  private buildConfusion(
    domain: number[],
    rowOf: (c: CaseRecord) => number | null,
    colOf: (c: CaseRecord) => number | null,
    labelOf: (v: number) => string,
  ): Confusion {
    const grid = domain.map(() => domain.map(() => 0));
    let max = 0;
    let total = 0;
    let diagonal = 0;
    for (const c of this.submitted()) {
      const rv = rowOf(c);
      const cv = colOf(c);
      if (rv == null || cv == null) continue;
      const ri = domain.indexOf(rv);
      const ci = domain.indexOf(cv);
      if (ri < 0 || ci < 0) continue;
      grid[ri][ci]++;
      total++;
      if (ri === ci) diagonal++;
      if (grid[ri][ci] > max) max = grid[ri][ci];
    }
    const rowTotals = grid.map((r) => r.reduce((a, b) => a + b, 0));
    const colTotals = domain.map((_, ci) => grid.reduce((a, r) => a + r[ci], 0));
    return { rows: domain, cols: domain, grid, rowTotals, colTotals, max, total, diagonal, labelOf };
  }
  cellColor(v: number, max: number): string {
    if (!v) return "transparent";
    const a = 0.12 + 0.6 * (v / (max || 1));
    return `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)`;
  }

  // ---------- distributions ----------

  icdrDist = computed(() =>
    this.dist(this.submitted().map((c) => c.icdr), ICDR_DOMAIN, ICDR_LABEL, ICDR_COLOR),
  );
  dmeDist = computed(() =>
    this.dist(this.submitted().map((c) => c.dme), DME_DOMAIN, DME_LABEL, DME_COLOR),
  );
  confidenceDist = computed(() =>
    this.dist(
      this.submitted().map((c) => c.confidence),
      [1, 2, 3, 4, 5],
      { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5" },
      { 1: "#e35d6a", 2: "#e0793f", 3: "#e0a437", 4: "#9bbf5f", 5: "#5fb874" },
    ),
  );
  difficultyDist = computed(() =>
    this.dist(
      this.submitted().map((c) => c.difficulty),
      [1, 2, 3],
      { 1: "Easy", 2: "Moderate", 3: "Hard" },
      { 1: "#5fb874", 2: "#e0a437", 3: "#e35d6a" },
    ),
  );
  private dist(
    values: (number | null)[],
    domain: number[],
    labels: Record<number, string>,
    colors: Record<number, string>,
  ): Bar[] {
    const counts = domain.map((v) => values.filter((x) => x === v).length);
    const max = Math.max(1, ...counts);
    return domain.map((v, i) => ({
      label: labels[v],
      value: counts[i],
      pct: (100 * counts[i]) / max,
      color: colors[v] ?? "var(--accent)",
    }));
  }

  // ---------- timing breakdown ----------

  timing = computed(() => {
    const s = this.submitted();
    const sum = (f: (c: CaseRecord) => number) => s.reduce((a, c) => a + f(c), 0);
    const macula = sum((c) => c.active_ms_macula ?? 0);
    const od = sum((c) => c.active_ms_od ?? 0);
    const preAi = sum((c) => (c.active_ms_macula_pre_ai ?? 0) + (c.active_ms_od_pre_ai ?? 0));
    const postAi = sum((c) => (c.active_ms_macula_post_ai ?? 0) + (c.active_ms_od_post_ai ?? 0));
    return {
      macula,
      od,
      preAi,
      postAi,
      meanFirstMacula: this.mean(
        s.map((c) => c.first_interaction_ms_macula).filter((x): x is number => x != null),
      ),
      p25: this.quantile(s.map((c) => this.totalMs(c)), 0.25),
      p75: this.quantile(s.map((c) => this.totalMs(c)), 0.75),
    };
  });
  maculaOdSplit = computed(() => {
    const t = this.timing();
    const tot = t.macula + t.od || 1;
    return { macula: (100 * t.macula) / tot, od: (100 * t.od) / tot };
  });

  // ---------- tool usage ----------

  tools = computed(() => {
    const s = this.submitted();
    const n = s.length || 1;
    const sum = (f: (c: CaseRecord) => number) => s.reduce((a, c) => a + f(c), 0);
    return [
      { label: "Zoom", total: sum((c) => c.n_zoom), per: sum((c) => c.n_zoom) / n },
      { label: "Pan", total: sum((c) => c.n_pan), per: sum((c) => c.n_pan) / n },
      { label: "Overlay toggle", total: sum((c) => c.n_overlay_toggle), per: sum((c) => c.n_overlay_toggle) / n },
      { label: "Preprocess", total: sum((c) => c.n_preprocess_toggle), per: sum((c) => c.n_preprocess_toggle) / n },
      { label: "View switch", total: sum((c) => c.n_view_switch), per: sum((c) => c.n_view_switch) / n },
      { label: "Idle spells", total: sum((c) => c.n_idle), per: sum((c) => c.n_idle) / n },
    ];
  });

  // ---------- per-case table ----------

  sortedCases = computed<CaseRecord[]>(() => {
    const key = this.sortKey();
    const dir = this.sortDir();
    const get = (c: CaseRecord): number | string => {
      if (key === "total_ms") return this.totalMs(c);
      const v = c[key] as unknown;
      if (v == null) return -Infinity;
      return v as number | string;
    };
    return [...this.cases()].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  });
  setSort(key: keyof CaseRecord | "total_ms") {
    if (this.sortKey() === key) this.sortDir.set((this.sortDir() * -1) as 1 | -1);
    else {
      this.sortKey.set(key);
      this.sortDir.set(1);
    }
  }
  icdrLabel(v: number | null): string {
    return v == null ? "—" : (ICDR_LABEL[v] ?? String(v));
  }
  dmeLabel(v: number | null): string {
    return v == null ? "—" : (DME_LABEL[v] ?? String(v));
  }
  agreeClass(a: number | null, b: number | null): string {
    if (a == null || b == null) return "";
    return a === b ? "ok" : "bad";
  }

  exportCsv() {
    const cols: (keyof CaseRecord | "total_ms")[] = [
      "case_id", "phase", "status", "is_calibration", "submitted_at",
      "icdr", "dme", "ref_icdr", "ref_dme", "ai_icdr_shown", "ai_dme_shown",
      "pre_ai_icdr", "pre_ai_dme", "ai_decision", "confidence", "difficulty",
      "total_ms", "active_ms_macula", "active_ms_od",
      "n_macula_corrections", "macula_correction_dist_px",
      "n_zoom", "n_pan", "n_overlay_toggle", "n_preprocess_toggle",
      "n_view_switch", "n_idle", "n_mouse_samples",
      "has_notes", "has_adjudication_notes",
    ];
    const esc = (v: unknown) =>
      v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const rows = this.cases().map((c) =>
      cols
        .map((k) => esc(k === "total_ms" ? this.totalMs(c) : (c[k] as unknown)))
        .join(","),
    );
    const csv = [cols.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reader_${this.selectedReaderId()}_cases.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private errorOf(e: unknown): string {
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e)
      return String((e as { message: unknown }).message);
    return String(e);
  }
}
