import { Injectable, computed, signal } from '@angular/core';
import { OpenProjectResult, Reader, SessionStart } from '../types';

@Injectable({ providedIn: 'root' })
export class AppStateService {
  private _project = signal<OpenProjectResult | null>(null);
  private _reader = signal<Reader | null>(null);
  private _session = signal<SessionStart | null>(null);

  readonly project = this._project.asReadonly();
  readonly reader = this._reader.asReadonly();
  readonly session = this._session.asReadonly();

  readonly ready = computed(
    () => this._project() !== null && this._reader() !== null && this._session() !== null,
  );

  setProject(p: OpenProjectResult | null) { this._project.set(p); }
  setReader(r: Reader | null) { this._reader.set(r); }
  setSession(s: SessionStart | null) { this._session.set(s); }

  clearForLogout() {
    this._reader.set(null);
    this._session.set(null);
  }
}
