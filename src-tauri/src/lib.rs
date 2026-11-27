//! Nexum Tauri core: window/tray lifecycle, sidecar management and command registry.

mod agent;
mod cleaner;
mod drivers;
mod external;
mod settings;
mod state;
mod system_info;
mod util;

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use state::AppState;
use util::lock;

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "nexum-tray";

/// Shows, restores and focuses the main window; restores the normal poll interval if the
/// window was hidden in the tray.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let state = app.state::<AppState>();
    if state.in_tray.swap(false, Ordering::SeqCst) {
        agent::apply_interval(app);
    }
}

/// Hides the main window to the tray and throttles telemetry (>= 5 s).
pub(crate) fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    let state = app.state::<AppState>();
    if !state.in_tray.swap(true, Ordering::SeqCst) {
        agent::apply_interval(app);
    }
}

/// True when the tray icon exists (hiding the window is only safe with a way back).
fn has_tray(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

fn navigate(app: &AppHandle, view: &str) {
    show_main_window(app);
    let _ = app.emit("navigate", view.to_string());
}

fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    // The sidecar is shut down gracefully in RunEvent::Exit.
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Nexum", true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Dashboard", true, None::<&str>)?;
    let drivers = MenuItem::with_id(app, "drivers", "Drivers", true, None::<&str>)?;
    let clean = MenuItem::with_id(app, "quick-clean", "Quick Clean", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show, &sep1, &dashboard, &drivers, &clean, &sep2, &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Nexum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "dashboard" => navigate(app, "dashboard"),
            "drivers" => navigate(app, "drivers"),
            "quick-clean" => navigate(app, "cleaner"),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    let launched_minimized = std::env::args()
        .skip(1)
        .any(|a| a.eq_ignore_ascii_case("--minimized"));

    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let minimized = args
                .iter()
                .skip(1)
                .any(|a| a.eq_ignore_ascii_case("--minimized"));
            if !minimized {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            system_info::get_system_info,
            drivers::get_drivers,
            system_info::get_volumes,
            system_info::get_physical_disks,
            cleaner::scan_trash,
            cleaner::purge_trash,
            drivers::export_drivers,
            drivers::backup_drivers,
            agent::set_poll_interval,
            agent::set_fan_preset,
            agent::set_fan_control,
            agent::flush_standby,
            settings::get_settings,
            settings::save_settings,
            agent::get_agent_status,
            agent::restart_agent,
            external::open_external,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let loaded = settings::init(&handle);

            if let Err(e) = build_tray(&handle) {
                eprintln!("[nexum] tray icon unavailable: {e}");
            }

            // The window is created hidden (tauri.conf.json `visible: false`) so a minimized
            // start never flashes it. Without a tray icon there would be no way back to a
            // hidden window, so it is always shown in that case.
            if (launched_minimized || loaded.start_minimized) && has_tray(&handle) {
                hide_to_tray(&handle);
            } else {
                show_main_window(&handle);
            }

            agent::start(&handle);
            settings::refresh_autostart_in_background(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let to_tray = lock(&state.settings).minimize_to_tray && has_tray(app);
                if to_tray && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    hide_to_tray(app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Nexum");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            agent::shutdown(app);
        }
    });
}
