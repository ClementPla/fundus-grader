import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  AdminStatus,
  CasePayload,
  MouseSample,
  OpenProjectResult,
  Reader,
  SessionStart,
  SubmissionRow,
  SubmitPayload,
} from "../types";

export interface EventIn {
  event_type: string;
  view?: string | null;
  payload: Record<string, unknown>;
}

@Injectable({ providedIn: "root" })
export class ApiService {
  async pickProjectFile(): Promise<string | null> {
    const sel = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }],
    });
    if (!sel) return null;
    return Array.isArray(sel) ? sel[0] : sel;
  }

  async pickSavePath(defaultName: string): Promise<string | null> {
    const sel = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "SQLite", extensions: ["sqlite"] }],
    });
    return sel ?? null;
  }

  openProject(path: string) {
    return invoke<OpenProjectResult>("open_project", { path });
  }

  listReaders() {
    return invoke<Reader[]>("list_readers");
  }

  registerReader(name: string, surname: string) {
    return invoke<Reader>("register_reader", { name, surname });
  }

  loginReader(readerId: number) {
    return invoke<void>("login_reader", { readerId });
  }

  startSession() {
    return invoke<SessionStart>("start_session");
  }

  startCase(assignmentId: number) {
    return invoke<CasePayload>("start_case", { assignmentId });
  }

  logEvent(ev: EventIn) {
    return invoke<void>("log_event", { ev });
  }

  submitCase(submission: SubmitPayload) {
    return invoke<void>("submit_case", { submission });
  }

  skipCase() {
    return invoke<void>("skip_case");
  }

  adminSetPassword(newPassword: string) {
    return invoke<void>("admin_set_password", { newPassword });
  }
  adminLogin(password: string) {
    return invoke<void>("admin_login", { password });
  }
  adminLogout() {
    return invoke<void>("admin_logout");
  }
  adminStatus() {
    return invoke<AdminStatus>("admin_status");
  }
  adminSetPhase(phase: "no_ai" | "ai") {
    return invoke<void>("admin_set_phase", { phase });
  }
  adminListSubmissions() {
    return invoke<SubmissionRow[]>("admin_list_submissions");
  }
  adminRevertSubmission(submissionId: number, reason: string) {
    return invoke<void>("admin_revert_submission", { submissionId, reason });
  }
  adminExportResults(destPath: string) {
    return invoke<string>("admin_export_results", { destPath });
  }
  async pushMouseSamples(samples: MouseSample[]): Promise<void> {
    if (samples.length === 0) return;
    return invoke<void>("push_mouse_samples", { samples });
  }
}
