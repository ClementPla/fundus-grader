import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
  computed,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TranslocoPipe } from "@jsverse/transloco";
import { ApiService } from "../../services/api.service";
import { IdleService } from "../../services/idle.service";
import {
  CasePayload,
  CaseView,
  ClassInfo,
  ClassStyle,
  MaskOverlay,
  MouseSample,
  Stage,
} from "../../types";
import {
  OverlayState,
  EtdrsRings,
  ViewState,
  GroupStyle,
  EtdrsConfig,
} from "./interface";
import {
  safeParseContours,
  polygonsToPathD,
  polygonsBoundingGeom,
} from "./utils";
import { formatTauriUri } from "./helper";
import { invoke } from "@tauri-apps/api/core";
const OPTIC_DISC_KEYWORDS = ["optic disc", "optic-disc", "disc"];

@Component({
  selector: "app-viewer",
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  templateUrl: "./viewer.component.html",
  styleUrl: "./viewer.component.scss",
})
export class ViewerComponent
  implements AfterViewInit, OnChanges, OnDestroy, OnInit
{
  @Input({ required: true }) caseData!: CasePayload;
  @Input({ required: true }) classes!: ClassInfo[];
  @Input() overlayStyle: Record<string, ClassStyle> = {};
  @Input() preprocessingAvailable = true;
  @Input() stageTag: Stage | null = null;

  @Output() viewShown = new EventEmitter<"macula" | "od">();
  @Output() interaction = new EventEmitter<"macula" | "od">();
  @Output() overlayToggle = new EventEmitter<{
    classId: number;
    visible: boolean;
  }>();
  @Output() preprocessToggle = new EventEmitter<{
    view: "macula" | "od";
    on: boolean;
  }>();
  @Output() zoomChanged = new EventEmitter<{
    view: "macula" | "od";
    scale: number;
  }>();
  @Output() panChanged = new EventEmitter<{ view: "macula" | "od" }>();

  @ViewChild("stage", { static: true }) stage!: ElementRef<HTMLDivElement>;
  @ViewChild("host", { static: true }) host!: ElementRef<HTMLDivElement>;
  @ViewChild("img", { static: true }) imgEl!: ElementRef<HTMLImageElement>;
  @ViewChild("overlaySvg", { static: true })
  overlaySvg!: ElementRef<SVGSVGElement>;

  viewStates: ViewState[] = [];
  currentView: "macula" | "od" = "macula";

  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOrigTx = 0;
  private dragOrigTy = 0;

  // Touch gesture state: one finger pans, two fingers pinch-zoom.
  private touchMode: "none" | "pan" | "pinch" = "none";
  private touchLastX = 0;
  private touchLastY = 0;
  private pinchPrevDist = 0;
  private pinchPrevMidX = 0;
  private pinchPrevMidY = 0;
  private firstInteractionSentFor = new Set<string>();
  private firstViewSentFor = new Set<string>();
  private zoomEmitTimer: number | null = null;
  private mouseInViewer = false;
  private tabSnapshot: Map<number, boolean> | null = null;

  private mouseSampleBuffer: MouseSample[] = [];
  private mouseSampleLastCaptureMs = 0;
  private mouseSampleLastX = Number.NaN;
  private mouseSampleLastY = Number.NaN;
  private mouseSampleFlushTimer: number | null = null;
  private caseStartedAtPerf = 0;

  private readonly MOUSE_SAMPLE_INTERVAL_MS = 100;
  private readonly MOUSE_SAMPLE_FLUSH_MS = 1500;

  /** Macula (ETDRS center) drag-to-correct state. Public: read by the template
   *  to suppress the auto-dim while the reader is repositioning the center. */
  isDraggingMacula = false;
  private maculaDragOrig: { cx: number; cy: number } | null = null;

  /** Auto-dim state for the macula marker: becomes true a short moment after a
   *  case/view loads so it stops obscuring the fovea. Once dimmed it stays
   *  dimmed regardless of pan/zoom — only hovering the marker restores full
   *  visibility (handled in CSS). */
  maculaIdle = signal(false);
  private maculaIdleTimer: number | null = null;
  private readonly MACULA_IDLE_MS = 1000;

  zoomLabel = signal("100%");
  panelOpen = signal(true);

  /** Whether illumination-corrected (preprocessed) images are shown. This is a
   *  single persistent preference shared across both views (macula/OD) and all
   *  cases — stored in localStorage so it also survives restarts. */
  preprocessOn = signal<boolean>(this.readPreprocessPref());
  private readonly PREPROCESS_STORAGE_KEY = "fg.preprocess";

  // Shared style for all lesion classes
  lesions = signal<GroupStyle>({
    fillOpacity: 0.3,
    strokeWidth: 1.5,
    strokeOpacity: 1.0,
    animate: "none",
  });

  // Optic disc style (no fill by default; dashed outline)
  od = signal<{ strokeWidth: number; strokeOpacity: number; fill: boolean }>({
    strokeWidth: 2.5,
    strokeOpacity: 1.0,
    fill: false,
  });

  etdrs = signal<EtdrsConfig>({
    visible: true,
    ddRadii: [1, 2],
    strokeColor: "#7df9ff",
    strokeWidth: 1.5,
    strokeOpacity: 0.85,
    dashed: true,
  });

  ddRadiiText = computed(() => this.etdrs().ddRadii.join(", "));

  constructor(
    private api: ApiService,
    private idle: IdleService,
  ) {}

  ngOnInit() {
    this.initViewStates();
  }
  ngAfterViewInit() {
    this.caseStartedAtPerf = performance.now();
    queueMicrotask(() => this.switchView(this.currentView, true));
    document.addEventListener("keydown", this.onDocumentKeyDown);
    this.startMouseSampleFlusher();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes["caseData"] && !changes["caseData"].firstChange) {
      this.revokeBlobUrls();
      this.tabSnapshot = null;
      // Reset mouse-sampling state for the new case:
      this.flushMouseSamplesNow();
      this.caseStartedAtPerf = performance.now();
      this.mouseSampleLastCaptureMs = 0;
      this.mouseSampleLastX = Number.NaN;
      this.mouseSampleLastY = Number.NaN;
      this.firstInteractionSentFor.clear();
      this.firstViewSentFor.clear();
      this.initViewStates();
      this.currentView = "macula";
      queueMicrotask(() => this.switchView(this.currentView, true));
    }
  }

  ngOnDestroy() {
    if (this.zoomEmitTimer !== null) window.clearTimeout(this.zoomEmitTimer);
    if (this.styleEmitTimer !== null) window.clearTimeout(this.styleEmitTimer);
    if (this.etdrsEmitTimer !== null) window.clearTimeout(this.etdrsEmitTimer);
    if (this.maculaIdleTimer !== null) window.clearTimeout(this.maculaIdleTimer);
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    this.stopMouseSampleFlusher(); // flushes any remaining samples
    this.revokeBlobUrls();
  }

  trackByClassId = (_i: number, ov: OverlayState) => ov.classId;
  fmtPct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }
  togglePanel() {
    this.panelOpen.set(!this.panelOpen());
  }

  // ---------- init ----------

  private initViewStates() {
    this.viewStates = this.caseData.views.map((v) => {
      const overlays = v.masks.map((m) => this.buildOverlay(m));
      return {
        view: v.view,
        loaded: false,
        width: v.width,
        height: v.height,
        overlays,
        etdrs: this.computeEtdrs(overlays, v),
        scale: 1,
        tx: 0,
        ty: 0,
      };
    });
  }

  private buildOverlay(m: MaskOverlay): OverlayState {
    const cls = this.classes.find((c) => c.class_id === m.class_id);
    const styleFromProject = this.overlayStyle[String(m.class_id)] ?? {};
    const baseStyle: ClassStyle = {
      ...(cls?.default_style ?? {}),
      ...styleFromProject,
    };
    const polys = safeParseContours(m.contours_json);
    const name = cls?.name ?? `class_${m.class_id}`;
    const isOpticDisc = OPTIC_DISC_KEYWORDS.some((kw) =>
      name.toLowerCase().includes(kw),
    );
    const swatch = baseStyle.stroke || baseStyle.fill || "#888";
    return {
      classId: m.class_id,
      name,
      visible: baseStyle.visible_by_default !== false,
      pathD: polygonsToPathD(polys),
      baseStyle,
      swatch,
      isOpticDisc,
      geom: polygonsBoundingGeom(polys),
    };
  }

  private computeEtdrs(
    overlays: OverlayState[],
    v: CaseView,
  ): EtdrsRings | null {
    const od = overlays.find((o) => o.isOpticDisc && o.geom);
    const maculaAnchor = (v.anatomy ?? []).find((a) => a.kind === "macula");

    // Need at least one of (OD polygon, macula anchor) to do anything useful.
    if (!od?.geom && !maculaAnchor) return null;

    // Macula center: prefer the real anchor over the geometric estimate.
    let cx: number;
    let cy: number;
    if (maculaAnchor) {
      cx = maculaAnchor.x;
      cy = maculaAnchor.y;
    } else {
      // Geometric fallback: 2.5 disc-diameters from the OD center, on whichever
      // side puts the macula closer to image center.
      const offset = 2.5 * 2 * od!.geom!.r;
      const left = od!.geom!.cx - offset;
      const right = od!.geom!.cx + offset;
      const imgCx = v.width / 2;
      cx = Math.abs(left - imgCx) < Math.abs(right - imgCx) ? left : right;
      cy = od!.geom!.cy;
    }

    // Ring sizing: OD radius if we have it, else the macula's own radius as a
    // rough proxy (typical macula radius ≈ optic-disc radius).
    const odRadius = od?.geom?.r ?? maculaAnchor?.r ?? null;
    if (odRadius == null) return null;

    const cfg = this.etdrs();
    return {
      cx,
      cy,
      ddRadii: [...cfg.ddRadii],
      // 1 disc-diameter (DD) of radial distance = 2 * disc-radius
      pxRadii: cfg.ddRadii.map((dd) => dd * odRadius * 2),
    };
  }

  currentViewState(): ViewState | undefined {
    return this.viewStates.find((v) => v.view === this.currentView);
  }

  lesionOverlays(cs: ViewState): OverlayState[] {
    return cs.overlays.filter((o) => !o.isOpticDisc);
  }

  opticDiscOverlay(): OverlayState | undefined {
    return this.currentViewState()?.overlays.find((o) => o.isOpticDisc);
  }

  anyLesionVisible(cs: ViewState): boolean {
    return cs.overlays.some((o) => !o.isOpticDisc && o.visible);
  }

  /** Per-overlay style resolvers — decide whether to use lesions or od group config. */
  resolveFillOpacity(ov: OverlayState): number {
    if (ov.isOpticDisc) return this.od().fill ? 0.2 : 0;
    return this.lesions().fillOpacity;
  }
  resolveAnimate(ov: OverlayState): "none" | "march" | "pulse" {
    return ov.isOpticDisc ? "none" : this.lesions().animate;
  }
  resolveDasharray(ov: OverlayState): string | null {
    if (ov.isOpticDisc) {
      return ov.baseStyle.stroke_dasharray ?? "6 4";
    }
    if (this.lesions().animate === "march") {
      return ov.baseStyle.stroke_dasharray ?? "6 4";
    }
    return ov.baseStyle.stroke_dasharray ?? null;
  }

  // ---------- view machinery ----------

  private viewData(view: "macula" | "od"): CaseView | undefined {
    return this.caseData.views.find((v) => v.view === view);
  }

  switchView(view: "macula" | "od", initial = false) {
    if (!this.viewStates.find((v) => v.view === view)) return;
    const previous = this.currentView;
    this.currentView = view;
    const state = this.currentViewState()!;

    void this.applyImageSource();
    this.updateSvgViewBox(state);
    this.applyTransform();
    this.resetMaculaIdle();

    if (!initial) {
      this.idle.setView(view);
      void this.api.logEvent({
        event_type: "view_switch",
        view,
        payload: { from: previous, to: view },
      });
    }

    if (!this.firstViewSentFor.has(view)) {
      this.firstViewSentFor.add(view);
      void this.api.logEvent({ event_type: "view_shown", view, payload: {} });
      this.viewShown.emit(view);
    } else {
      void this.api.logEvent({
        event_type: "view_shown",
        view,
        payload: { resumed: true },
      });
    }
  }

  onImageLoaded() {
    const img = this.imgEl.nativeElement;
    const state = this.currentViewState();
    if (!state) return;
    if (!state.width) state.width = img.naturalWidth;
    if (!state.height) state.height = img.naturalHeight;
    state.loaded = true;
    this.updateSvgViewBox(state);
    if (state.scale === 1 && state.tx === 0 && state.ty === 0) {
      this.fitView(state);
    } else {
      this.applyTransform();
    }
  }

  private updateSvgViewBox(state: ViewState) {
    if (!state.width || !state.height) return;
    const svg = this.overlaySvg.nativeElement;
    svg.setAttribute("viewBox", `0 0 ${state.width} ${state.height}`);
    svg.setAttribute("width", String(state.width));
    svg.setAttribute("height", String(state.height));
  }

  private fitView(state: ViewState) {
    const stage = this.stage.nativeElement;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!state.width || !state.height || !sw || !sh) return;
    const scale = Math.min(sw / state.width, sh / state.height);
    state.scale = scale;
    state.tx = (sw - state.width * scale) / 2;
    state.ty = (sh - state.height * scale) / 2;
    this.applyTransform();
  }

  resetView() {
    const state = this.currentViewState();
    if (!state) return;
    this.fitView(state);
    void this.api.logEvent({
      event_type: "zoom_reset",
      view: state.view,
      payload: {},
    });
    void this.idle.poke("interaction");
  }

  private applyTransform() {
    const state = this.currentViewState();
    if (!state) return;
    const host = this.host.nativeElement;
    host.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    this.zoomLabel.set(`${Math.round(state.scale * 100)}%`);
  }

  // ---------- pan/zoom interactions ----------

  onWheel(ev: WheelEvent) {
    ev.preventDefault();
    const state = this.currentViewState();
    if (!state) return;
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newScale = Math.max(0.05, Math.min(20, state.scale * factor));
    state.tx = px - (px - state.tx) * (newScale / state.scale);
    state.ty = py - (py - state.ty) * (newScale / state.scale);
    state.scale = newScale;
    this.applyTransform();
    this.markInteraction();
    this.debouncedZoomEmit();
  }

  private debouncedZoomEmit() {
    const state = this.currentViewState();
    if (!state) return;
    if (this.zoomEmitTimer !== null) window.clearTimeout(this.zoomEmitTimer);
    this.zoomEmitTimer = window.setTimeout(() => {
      void this.api.logEvent({
        event_type: "zoom",
        view: state.view,
        payload: { scale: Number(state.scale.toFixed(4)) },
      });
      this.zoomChanged.emit({ view: state.view, scale: state.scale });
      void this.idle.poke("zoom");
    }, 120);
  }

  onMouseDown(ev: MouseEvent) {
    if (ev.button !== 0 && ev.button !== 1) return;
    const state = this.currentViewState();
    if (!state) return;
    this.dragging = true;
    this.stage.nativeElement.classList.add("dragging");
    this.dragStartX = ev.clientX;
    this.dragStartY = ev.clientY;
    this.dragOrigTx = state.tx;
    this.dragOrigTy = state.ty;
  }

  onMouseMove(ev: MouseEvent) {
    // Macula correction takes priority over pan/sample while active.
    if (this.isDraggingMacula) {
      this.moveMaculaTo(ev);
      return;
    }
    // Existing drag logic:
    if (this.dragging) {
      const state = this.currentViewState();
      if (!state) return;
      state.tx = this.dragOrigTx + (ev.clientX - this.dragStartX);
      state.ty = this.dragOrigTy + (ev.clientY - this.dragStartY);
      this.applyTransform();
    }
    // New: sample mouse position (regardless of drag state).
    this.maybeSampleMouse(ev);
  }

  onMouseUp(ev: MouseEvent) {
    if (this.isDraggingMacula) {
      this.endDragMacula(ev);
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    this.stage.nativeElement.classList.remove("dragging");
    const state = this.currentViewState();
    if (!state) return;
    void this.api.logEvent({
      event_type: "pan",
      view: state.view,
      payload: { tx: Math.round(state.tx), ty: Math.round(state.ty) },
    });
    this.panChanged.emit({ view: state.view });
    this.markInteraction();
    void this.idle.poke("pan");
  }

  // ---------- touch (pan + pinch-zoom) ----------

  onTouchStart(ev: TouchEvent) {
    const state = this.currentViewState();
    if (!state) return;
    // Suppress synthesized mouse events so the gesture isn't double-handled.
    ev.preventDefault();
    if (ev.touches.length >= 2) {
      this.touchMode = "pinch";
      this.setPinchRef(ev);
    } else if (ev.touches.length === 1) {
      this.touchMode = "pan";
      this.touchLastX = ev.touches[0].clientX;
      this.touchLastY = ev.touches[0].clientY;
    }
  }

  onTouchMove(ev: TouchEvent) {
    const state = this.currentViewState();
    if (!state) return;
    ev.preventDefault();

    if (this.touchMode === "pinch" && ev.touches.length >= 2) {
      const rect = this.stage.nativeElement.getBoundingClientRect();
      const a = ev.touches[0];
      const b = ev.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midX = (a.clientX + b.clientX) / 2 - rect.left;
      const midY = (a.clientY + b.clientY) / 2 - rect.top;
      if (this.pinchPrevDist > 0) {
        // Zoom about the pinch midpoint (same math as the wheel handler)…
        const factor = dist / this.pinchPrevDist;
        const newScale = Math.max(0.05, Math.min(20, state.scale * factor));
        state.tx = midX - (midX - state.tx) * (newScale / state.scale);
        state.ty = midY - (midY - state.ty) * (newScale / state.scale);
        state.scale = newScale;
        // …then pan by however far the midpoint itself moved.
        state.tx += midX - this.pinchPrevMidX;
        state.ty += midY - this.pinchPrevMidY;
        this.applyTransform();
        this.markInteraction();
      }
      this.pinchPrevDist = dist;
      this.pinchPrevMidX = midX;
      this.pinchPrevMidY = midY;
    } else if (this.touchMode === "pan" && ev.touches.length === 1) {
      const t = ev.touches[0];
      state.tx += t.clientX - this.touchLastX;
      state.ty += t.clientY - this.touchLastY;
      this.touchLastX = t.clientX;
      this.touchLastY = t.clientY;
      this.applyTransform();
    }
  }

  onTouchEnd(ev: TouchEvent) {
    const state = this.currentViewState();
    if (ev.touches.length === 0) {
      // Gesture fully ended — flush the appropriate analytics.
      if (this.touchMode === "pinch") {
        this.debouncedZoomEmit();
      } else if (this.touchMode === "pan" && state) {
        void this.api.logEvent({
          event_type: "pan",
          view: state.view,
          payload: { tx: Math.round(state.tx), ty: Math.round(state.ty) },
        });
        this.panChanged.emit({ view: state.view });
        void this.idle.poke("pan");
      }
      this.touchMode = "none";
      this.markInteraction();
    } else if (ev.touches.length === 1) {
      // Dropped from pinch to a single finger: emit the zoom and continue panning.
      this.debouncedZoomEmit();
      this.touchMode = "pan";
      this.touchLastX = ev.touches[0].clientX;
      this.touchLastY = ev.touches[0].clientY;
    } else if (ev.touches.length >= 2) {
      // A finger lifted but two remain: re-seed the pinch reference.
      this.setPinchRef(ev);
    }
  }

  private setPinchRef(ev: TouchEvent) {
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const a = ev.touches[0];
    const b = ev.touches[1];
    this.pinchPrevDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchPrevMidX = (a.clientX + b.clientX) / 2 - rect.left;
    this.pinchPrevMidY = (a.clientY + b.clientY) / 2 - rect.top;
  }

  private maybeSampleMouse(ev: MouseEvent) {
    const nowPerf = performance.now();
    if (nowPerf - this.mouseSampleLastCaptureMs < this.MOUSE_SAMPLE_INTERVAL_MS)
      return;

    const state = this.currentViewState();
    if (!state || !state.width || !state.height || state.scale <= 0) return;

    // Screen → image coordinate transform (inverse of applyTransform).
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const imgX = Math.round((sx - state.tx) / state.scale);
    const imgY = Math.round((sy - state.ty) / state.scale);

    // Reject samples outside the image bounds (cursor on letterbox).
    if (imgX < 0 || imgX >= state.width || imgY < 0 || imgY >= state.height)
      return;

    // Dedup against last accepted sample.
    if (imgX === this.mouseSampleLastX && imgY === this.mouseSampleLastY)
      return;

    this.mouseSampleLastCaptureMs = nowPerf;
    this.mouseSampleLastX = imgX;
    this.mouseSampleLastY = imgY;

    this.mouseSampleBuffer.push({
      ts_ms_since_case_start: Math.round(nowPerf - this.caseStartedAtPerf),
      stage: this.stageTag,
      view: this.currentView,
      x: imgX,
      y: imgY,
      scale: Number(state.scale.toFixed(3)),
    });
  }

  private readPreprocessPref(): boolean {
    try {
      return localStorage.getItem("fg.preprocess") === "1";
    } catch {
      return false;
    }
  }

  /** Set the displayed image for the current view according to preprocessOn,
   *  lazily computing & caching the processed image per view on first use. */
  private async applyImageSource() {
    const view = this.currentView;
    const data = this.viewData(view);
    if (!data) return;

    if (!this.preprocessOn()) {
      this.imgEl.nativeElement.src = formatTauriUri(data.raw_uri);
      return;
    }

    // Lazy-compute the processed image; cache the blob URL on the view so
    // subsequent switches/toggles are instant.
    if (!data.preprocessed_uri || !data.preprocessed_uri.startsWith("blob:")) {
      try {
        const buf = await invoke<ArrayBuffer>("preprocess_case_image", {
          caseId: this.caseData.case_id,
          view,
        });
        const blob = new Blob([buf], { type: "image/jpeg" });
        data.preprocessed_uri = URL.createObjectURL(blob);
      } catch (err) {
        console.error("preprocess_case_image failed:", err);
        this.preprocessOn.set(false);
        this.imgEl.nativeElement.src = formatTauriUri(data.raw_uri);
        return;
      }
    }
    // A view switch may have raced the await — don't clobber the new image.
    if (this.currentView !== view) return;
    // Blob URLs are normal URLs — no formatTauriUri wrapping needed.
    this.imgEl.nativeElement.src = data.preprocessed_uri!;
  }

  async togglePreprocessing() {
    this.preprocessOn.set(!this.preprocessOn());
    try {
      localStorage.setItem(
        this.PREPROCESS_STORAGE_KEY,
        this.preprocessOn() ? "1" : "0",
      );
    } catch {
      // Persistence is best-effort.
    }

    await this.applyImageSource();

    // applyImageSource may have flipped the flag back off on failure.
    const on = this.preprocessOn();
    void this.api.logEvent({
      event_type: "preprocess_toggle",
      view: this.currentView,
      payload: { on },
    });
    this.preprocessToggle.emit({ view: this.currentView, on });
    this.markInteraction();
    void this.idle.poke("preprocess_toggle");
  }
  private startMouseSampleFlusher() {
    this.stopMouseSampleFlusher();
    this.mouseSampleFlushTimer = window.setInterval(
      () => this.flushMouseSamplesNow(),
      this.MOUSE_SAMPLE_FLUSH_MS,
    );
  }

  private stopMouseSampleFlusher() {
    if (this.mouseSampleFlushTimer !== null) {
      window.clearInterval(this.mouseSampleFlushTimer);
      this.mouseSampleFlushTimer = null;
    }
    this.flushMouseSamplesNow();
  }

  private flushMouseSamplesNow() {
    if (!this.mouseSampleBuffer.length) return;
    const batch = this.mouseSampleBuffer.splice(
      0,
      this.mouseSampleBuffer.length,
    );
    // Fire-and-forget; backend errors are non-fatal for the user.
    void this.api.pushMouseSamples(batch).catch((err) => {
      console.warn("pushMouseSamples failed:", err);
    });
  }
  private revokeBlobUrls() {
    if (!this.caseData?.views) return;
    for (const v of this.caseData.views) {
      if (v.preprocessed_uri?.startsWith("blob:")) {
        URL.revokeObjectURL(v.preprocessed_uri);
        v.preprocessed_uri = null;
      }
    }
  }
  private onDocumentKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Tab") return;
    if (!this.mouseInViewer) return; // form-panel Tab nav unaffected
    // Belt-and-suspenders: if focus happens to be inside a form field that
    // somehow ended up under the viewer's host bounds, leave it alone.
    const t = ev.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    ) {
      return;
    }
    ev.preventDefault();
    this.toggleAllLesionsTab();
  };
  private toggleAllLesionsTab() {
    const cs = this.currentViewState();
    if (!cs) return;
    const lesions = this.lesionOverlays(cs);
    if (!lesions.length) return;

    const anyVisible = lesions.some((l) => l.visible);
    let action: "hide" | "restore" | "show";

    if (anyVisible) {
      this.tabSnapshot = new Map(lesions.map((l) => [l.classId, l.visible]));
      for (const ov of lesions) ov.visible = false;
      action = "hide";
    } else if (this.tabSnapshot) {
      for (const ov of lesions) {
        ov.visible = this.tabSnapshot.get(ov.classId) ?? true;
      }
      this.tabSnapshot = null;
      action = "restore";
    } else {
      for (const ov of lesions) ov.visible = true;
      action = "show";
    }

    void this.api.logEvent({
      event_type: "overlay_tab_toggle",
      view: this.currentView,
      payload: { action, n_lesions: lesions.length },
    });
    this.markInteraction();
    void this.idle.poke("overlay_toggle");
  }

  // ---------- panel handlers ----------

  setVisible(ov: OverlayState, on: boolean) {
    ov.visible = on;
    this.tabSnapshot = null; // ← add this
    void this.api.logEvent({
      event_type: "overlay_toggle",
      view: this.currentView,
      payload: { class_id: ov.classId, visible: on },
    });
    this.overlayToggle.emit({ classId: ov.classId, visible: on });
    this.markInteraction();
    void this.idle.poke("overlay_toggle");
  }

  showAllLesions(cs: ViewState) {
    for (const ov of cs.overlays) {
      if (!ov.isOpticDisc && !ov.visible) this.setVisible(ov, true);
    }
  }
  hideAllLesions(cs: ViewState) {
    for (const ov of cs.overlays) {
      if (!ov.isOpticDisc && ov.visible) this.setVisible(ov, false);
    }
  }

  updateLesions(patch: Partial<GroupStyle>, field: string) {
    this.lesions.update((s) => ({ ...s, ...patch }));
    this.logGroup("lesions", field, (patch as Record<string, unknown>)[field]);
  }

  updateOd(
    patch: Partial<{
      strokeWidth: number;
      strokeOpacity: number;
      fill: boolean;
    }>,
    field: string,
  ) {
    this.od.update((s) => ({ ...s, ...patch }));
    this.logGroup("od", field, (patch as Record<string, unknown>)[field]);
  }

  updateEtdrs(patch: Partial<EtdrsConfig>, field: string) {
    this.etdrs.update((s) => ({ ...s, ...patch }));
    this.logGroup("etdrs", field, (patch as Record<string, unknown>)[field]);
  }

  setDdRadiiText(s: string) {
    const parsed = s
      .split(/[,\s]+/)
      .map((t) => parseFloat(t))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (!parsed.length) return;
    this.etdrs.update((c) => ({ ...c, ddRadii: parsed }));
    for (const vs of this.viewStates) {
      if (!vs.etdrs) continue;
      const od = vs.overlays.find((o) => o.isOpticDisc && o.geom);
      // Use OD radius if available, otherwise fall back to the macula anchor's r
      // (matches the same priority used by computeEtdrs).
      const view = this.caseData.views.find((v) => v.view === vs.view);
      const macula = view?.anatomy?.find((a) => a.kind === "macula");
      const odRadius = od?.geom?.r ?? macula?.r ?? null;
      if (odRadius == null) continue;
      vs.etdrs = {
        ...vs.etdrs,
        ddRadii: parsed,
        pxRadii: parsed.map((dd) => dd * odRadius * 2),
      };
    }
    this.logGroup("etdrs", "dd_radii", parsed);
  }

  private styleEmitTimer: number | null = null;
  private etdrsEmitTimer: number | null = null;
  /** Throttled, group-tagged log emit. */
  private logGroup(
    group: "lesions" | "od" | "etdrs",
    field: string,
    value: unknown,
  ) {
    const fire = () => {
      void this.api.logEvent({
        event_type: "overlay_style",
        view: this.currentView,
        payload: { group, field, value: value as any },
      });
      void this.idle.poke("overlay_toggle");
    };
    if (group === "etdrs") {
      if (this.etdrsEmitTimer !== null)
        window.clearTimeout(this.etdrsEmitTimer);
      this.etdrsEmitTimer = window.setTimeout(fire, 150);
    } else {
      if (this.styleEmitTimer !== null)
        window.clearTimeout(this.styleEmitTimer);
      this.styleEmitTimer = window.setTimeout(fire, 150);
    }
    this.markInteraction();
  }

  private markInteraction() {
    const v = this.currentView;
    if (!this.firstInteractionSentFor.has(v)) {
      this.firstInteractionSentFor.add(v);
      void this.api.logEvent({
        event_type: "interaction",
        view: v,
        payload: {},
      });
      this.interaction.emit(v);
    }
  }

  @HostListener("mouseenter")
  onHostMouseEnter() {
    this.mouseInViewer = true;
  }

  @HostListener("mouseleave")
  onHostMouseLeave() {
    this.mouseInViewer = false;
  }

  // ---------- macula (ETDRS center) drag-to-correct ----------

  /** Begin dragging the macula center. Stops propagation so the stage's
   *  pan handler doesn't also fire. */
  startDragMacula(event: MouseEvent) {
    if (event.button !== 0) return;
    const state = this.currentViewState();
    if (!state || !state.etdrs) return;
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingMacula = true;
    this.maculaDragOrig = { cx: state.etdrs.cx, cy: state.etdrs.cy };
  }

  /** Convert the pointer position to image coords and move the center there,
   *  clamped to the image bounds. The rings follow automatically since they're
   *  drawn relative to (cx, cy). */
  private moveMaculaTo(event: MouseEvent) {
    const state = this.currentViewState();
    if (!state || !state.etdrs || !state.width || !state.height) return;
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const imgX = Math.round((sx - state.tx) / state.scale);
    const imgY = Math.round((sy - state.ty) / state.scale);
    state.etdrs.cx = Math.max(0, Math.min(state.width - 1, imgX));
    state.etdrs.cy = Math.max(0, Math.min(state.height - 1, imgY));
  }

  /** Show the macula marker, then arm a timer to dim it again shortly after.
   *  Called on case/view load so the marker is briefly visible before fading;
   *  it is intentionally NOT called on pan/zoom — once dimmed it only comes
   *  back on hover. */
  private resetMaculaIdle() {
    if (this.maculaIdle()) this.maculaIdle.set(false);
    if (this.maculaIdleTimer !== null) window.clearTimeout(this.maculaIdleTimer);
    this.maculaIdleTimer = window.setTimeout(() => {
      this.maculaIdle.set(true);
    }, this.MACULA_IDLE_MS);
  }

  private endDragMacula(event: MouseEvent) {
    this.moveMaculaTo(event);
    this.isDraggingMacula = false;
    const state = this.currentViewState();
    const orig = this.maculaDragOrig;
    this.maculaDragOrig = null;
    if (!state || !state.etdrs || !orig) return;
    // Ignore no-op drags (a click that didn't actually move the center).
    if (orig.cx === state.etdrs.cx && orig.cy === state.etdrs.cy) return;
    void this.api.logEvent({
      event_type: "macula_corrected",
      view: state.view,
      payload: {
        from: { x: orig.cx, y: orig.cy },
        to: { x: state.etdrs.cx, y: state.etdrs.cy },
      },
    });
    this.markInteraction();
    void this.idle.poke("interaction");
  }
}
