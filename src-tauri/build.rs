fn main() {
    // The Windows application manifest is produced by the MSVC linker (below) instead of the
    // RT_MANIFEST resource tauri-build would embed. tauri-build links its resource into binaries
    // only, so the library's unit-test executable would get no manifest at all and fail to start
    // (STATUS_ENTRYPOINT_NOT_FOUND: muda / tauri-runtime-wry import `TaskDialogIndirect`, which
    // only exists in Common Controls v6). The resource is still used for the icon and version
    // info; it must not carry a manifest too, or the link fails with a duplicate RT_MANIFEST.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(err) = tauri_build::try_build(attributes) {
        panic!("tauri-build failed: {err:#}");
    }

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        // Every linked artifact (Nexum.exe, the unit-test executable, the cdylib): an embedded
        // manifest with the Common Controls v6 dependency (same as Tauri's default manifest).
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // Only the application binary requests elevation (sensor drivers, C:\Windows\Temp,
        // pnputil). Test executables keep the default asInvoker level so `cargo test --lib` runs
        // from a normal shell. The bin target has `test = false` in Cargo.toml for the same reason.
        println!(
            "cargo:rustc-link-arg-bins=/MANIFESTUAC:level='requireAdministrator' uiAccess='false'"
        );
    }
}
