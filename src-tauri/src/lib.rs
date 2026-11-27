//! Nexum Tauri core: window/tray lifecycle, sidecar management and command registry.

mod agent;
mod cleaner;
mod drivers;
mod elevation;
mod external;
mod failsafe;
mod procs;
mod purge_log;
mod safe_fs;
mod self_usage;
mod settings;
mod spec;
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

/// Tray entries that open a view: (menu id = `navigate` payload = ViewId, label).
const TRAY_VIEWS: [(&str, &str); 6] = [
    ("dashboard", "Dashboard"),
    ("sensors", "Sensors"),
    ("system", "System"),
    ("storage", "Storage"),
    ("cooling", "Cooling"),
    ("drivers", "Drivers"),
];

/// `navigate` payload for a tray menu id (CONTRACT §2 tray menu), or `None` for ids that do
/// not navigate.
fn tray_navigation(id: &str) -> Option<&'static str> {
    if id == "clean-caches" {
        return Some("quick-clean");
    }
    TRAY_VIEWS.iter().find(|(v, _)| *v == id).map(|(v, _)| *v)
}

/// Shows, restores and focuses the main window; restores the normal poll interval, the
/// sensor stream and the self-usage readout if the window was hidden in the tray.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let state = app.state::<AppState>();
    if state.in_tray.swap(false, Ordering::SeqCst) {
        agent::apply_interval(app);
        agent::sync_sensor_stream(app, false);
    }
}

/// Hides the main window to the tray: telemetry throttled (>= 5 s), sensor stream off,
/// self-usage paused (CONTRACT §2, minimized to tray).
pub(crate) fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    let state = app.state::<AppState>();
    if !state.in_tray.swap(true, Ordering::SeqCst) {
        agent::apply_interval(app);
        agent::sync_sensor_stream(app, false);
    }
}

/// True when the tray icon exists (hiding the window is only safe with a way back).
fn has_tray(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

fn navigate(app: &AppHandle, target: &str) {
    show_main_window(app);
    let _ = app.emit("navigate", target.to_string());
}

fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    // The sidecar is shut down gracefully in RunEvent::Exit.
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Nexum", true, None::<&str>)?;
    let mut views = Vec::with_capacity(TRAY_VIEWS.len());
    for (id, label) in TRAY_VIEWS {
        views.push(MenuItem::with_id(app, id, label, true, None::<&str>)?);
    }
    let clean = MenuItem::with_id(app, "clean-caches", "Clean caches…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    items.push(&show);
    items.push(&sep1);
    for v in &views {
        items.push(v);
    }
    items.push(&sep2);
    items.push(&clean);
    items.push(&sep3);
    items.push(&quit_item);
    let menu = Menu::with_items(app, &items)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Nexum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => show_main_window(app),
                "quit" => quit(app),
                other => {
                    if let Some(target) = tray_navigation(other) {
                        navigate(app, target);
                    }
                }
            }
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
    // Before anything else (no threads, no WebView yet): drop inherited variables a standard
    // user could have set to load code into this elevated process or its children.
    util::scrub_inherited_environment();

    // Started by `restart_as_admin`: let the previous (non-elevated) instance exit first, or
    // the single-instance plugin would hand this launch back to it.
    elevation::wait_for_previous_instance();

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
            settings::get_settings,
            settings::save_settings,
            agent::get_agent_status,
            agent::restart_agent,
            external::open_external,
            agent::get_sensor_tree,
            agent::set_sensor_stream,
            agent::reset_sensor_stats,
            spec::get_system_spec,
            failsafe::get_fan_failsafe_state,
            failsafe::dismiss_fan_failsafe,
            elevation::restart_as_admin,
            external::open_reliability_monitor,
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

            // MF-13: a fan write-ahead flag left by an earlier run means fans may be stuck at a
            // manual speed. Warn before the agent starts; its `hello` settles the state.
            let flag = failsafe::flag_exists();
            failsafe::update(&handle, |t, now| t.on_app_start(flag, now));

            agent::start(&handle);
            agent::start_watchdog(&handle);
            self_usage::start(&handle);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_ids_map_to_navigate_targets() {
        for (id, _) in TRAY_VIEWS {
            assert_eq!(tray_navigation(id), Some(id));
        }
        assert_eq!(tray_navigation("clean-caches"), Some("quick-clean"));
        assert_eq!(tray_navigation("show"), None);
        assert_eq!(tray_navigation("quit"), None);
        assert_eq!(tray_navigation("fans"), None, "the old view id is gone");
        let ids: Vec<&str> = TRAY_VIEWS.iter().map(|(v, _)| *v).collect();
        assert_eq!(
            ids,
            vec!["dashboard", "sensors", "system", "storage", "cooling", "drivers"]
        );
    }
}
