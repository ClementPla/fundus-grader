import { Injectable, OnDestroy } from '@angular/core';
import { ApiService } from './api.service';

/**
 * Tracks user activity for the active case. After idleThresholdMs of no
 * interaction, emits an `idle_start` event for the current view. The next
 * interaction emits `idle_end` (along with the interaction itself).
 *
 * Visibility (tab blur, window minimize) is also treated as idle.
 */
@Injectable({ providedIn: 'root' })
export class IdleService implements OnDestroy {
  private timer: number | null = null;
  private idleThresholdMs = 15_000;
  private isIdle = false;
  private currentView: string | null = null;
  private active = false;
  private visHandler = () => this.onVisibilityChange();

  constructor(private api: ApiService) {
    document.addEventListener('visibilitychange', this.visHandler);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.visHandler);
    this.clearTimer();
  }

  start(currentView: string, idleThresholdMs: number) {
    this.idleThresholdMs = Math.max(2000, idleThresholdMs);
    this.currentView = currentView;
    this.active = true;
    this.isIdle = false;
    this.resetTimer();
  }

  stop() {
    this.active = false;
    this.currentView = null;
    this.isIdle = false;
    this.clearTimer();
  }

  setView(view: string) {
    this.currentView = view;
    // Activity-equivalent: switching view resets idle.
    void this.poke('view_switch');
  }

  /** Called on any user interaction on the viewer. */
  async poke(interactionKind: 'interaction' | 'view_switch' | 'overlay_toggle' | 'preprocess_toggle' | 'zoom' | 'pan') {
    if (!this.active || !this.currentView) return;
    if (this.isIdle) {
      this.isIdle = false;
      try {
        await this.api.logEvent({
          event_type: 'idle_end',
          view: this.currentView,
          payload: {},
        });
      } catch (_e) {
        /* swallow */
      }
    }
    this.resetTimer();
  }

  private resetTimer() {
    this.clearTimer();
    this.timer = window.setTimeout(() => this.goIdle('timeout'), this.idleThresholdMs);
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async goIdle(reason: 'timeout' | 'hidden') {
    if (!this.active || this.isIdle || !this.currentView) return;
    this.isIdle = true;
    try {
      await this.api.logEvent({
        event_type: 'idle_start',
        view: this.currentView,
        payload: { reason },
      });
    } catch (_e) {
      /* swallow */
    }
  }

  private onVisibilityChange() {
    if (!this.active) return;
    if (document.hidden) {
      void this.goIdle('hidden');
    } else {
      // Don't auto-resume; require an interaction to come back.
      // But clear timer so it doesn't fire spuriously.
      this.resetTimer();
    }
  }
}
