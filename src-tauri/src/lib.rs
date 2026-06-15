mod assignment_gen;
mod commands;
mod error;
mod image_protocol;
mod preprocessing;
mod project_db;
mod results_db;
mod session;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .register_uri_scheme_protocol("fundus", image_protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::list_readers,
            commands::register_reader,
            commands::login_reader,
            commands::start_session,
            commands::start_case,
            commands::log_event,
            commands::submit_case,
            commands::skip_case,
            commands::admin_set_password,
            commands::admin_login,
            commands::admin_logout,
            commands::admin_status,
            commands::admin_set_phase,
            commands::admin_list_submissions,
            commands::admin_revert_submission,
            commands::admin_export_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
