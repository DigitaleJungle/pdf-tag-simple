#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod scanner;
mod ai_service;
mod chatgpt_auth;
mod page_cache;

// ===== OPEN LOCATION =====
// Mở File Explorer và highlight sẵn file đó
// Windows: explorer /select,"path\to\file.pdf"
// macOS:   open -R "path/to/file.pdf"
#[tauri::command]
fn reveal_in_explorer(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Dung lượng file trên disk (bytes) — dùng cho summary panel
#[tauri::command]
fn get_file_size(file_path: String) -> Result<u64, String> {
    std::fs::metadata(&file_path).map(|m| m.len()).map_err(|e| e.to_string())
}

// WebView2 has its own native pinch-to-zoom (page-scale zoom) that's independent of
// the zoomHotkeysEnabled setting and of any touch-action/preventDefault in the page's
// JS. It fights with the reader's own finger-anchored pinch zoom (see f_reader.js),
// so it's disabled here, leaving pinch gestures to be handled entirely by the page.
#[cfg(target_os = "windows")]
fn disable_native_pinch_zoom(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| {
        unsafe {
            if let Ok(core) = webview.controller().CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    if let Ok(settings5) = settings.cast::<ICoreWebView2Settings5>() {
                        let _ = settings5.SetIsPinchZoomEnabled(false);
                    }
                }
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    disable_native_pinch_zoom(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reveal_in_explorer,
            get_file_size,
            db::add_library_folder,
            db::get_library_folders,
            db::remove_library_folder,
            db::get_library_books,
            db::update_book_info,
            db::export_database,
            db::import_database,
            db::check_auto_backup,
            db::restore_auto_backup,
            db::discard_auto_backup,
            db::get_all_tags,
            db::hide_book,
            db::restore_book,
            db::toggle_star,
            db::rename_tag,
            db::delete_tag,
            db::find_duplicates,
            scanner::update_database,
            scanner::get_pdf_page_count,
            scanner::render_pdf_page,
            ai_service::get_ai_settings,
            ai_service::save_ai_settings,
            ai_service::suggest_tags,
            ai_service::check_ollama,
            ai_service::gemini_list_models,
            chatgpt_auth::chatgpt_status,
            chatgpt_auth::chatgpt_sign_in,
            chatgpt_auth::chatgpt_cancel_sign_in,
            chatgpt_auth::chatgpt_sign_out,
            chatgpt_auth::chatgpt_list_models,
            page_cache::get_page_cache_settings,
            page_cache::save_page_cache_settings,
            page_cache::clear_page_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
