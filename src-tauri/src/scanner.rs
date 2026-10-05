use crate::db::{self, BookEntry};
use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tauri::Manager;
use walkdir::WalkDir;

// =============================================
// SCAN PROGRESS EVENT
// Emit từ backend → frontend sau mỗi thumbnail render
// Frontend lắng nghe qua window.__TAURI__.event.listen("scan_progress", ...)
// =============================================
#[derive(Serialize, Clone)]
struct ScanProgress {
    current: usize,   // Số file đã xử lý
    total: usize,     // Tổng số file cần xử lý
    file_name: String, // Tên file đang xử lý (để hiện trong status)
    done: bool,        // true khi hoàn thành toàn bộ
}

fn init_pdfium(app_handle: &tauri::AppHandle) -> Result<Pdfium, String> {
    if let Ok(b) = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")) {
        return Ok(Pdfium::new(b));
    }

    if let Ok(res_dir) = app_handle.path().resource_dir() {
        if let Ok(b) = Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(res_dir.to_string_lossy().as_ref()),
        ) {
            return Ok(Pdfium::new(b));
        }
    }

    if let Ok(b) = Pdfium::bind_to_system_library() {
        return Ok(Pdfium::new(b));
    }

    Err("pdfium.dll not found".to_string())
}

// Chạy ngoài main thread (async) — nếu không, cả cửa sổ đứng im trong lúc quét/render.
// Chỉ 1 lần update tại 1 thời điểm (nút ở toolbar và trong Settings đều gọi được).
static UPDATING: AtomicBool = AtomicBool::new(false);

#[tauri::command(async)]
pub fn update_database(app_handle: tauri::AppHandle) -> Result<String, String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err("Update already running.".to_string());
    }
    let result = run_update(&app_handle);
    UPDATING.store(false, Ordering::SeqCst);
    result
}

fn run_update(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let app_dir = db::app_dir(app_handle)?;
    let cache_dir = app_dir.join("cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    // SAFETY BACKUP — export the current database to a JSON file in the app's
    // own data folder before touching anything below. If the update fails
    // partway through, this file is left behind as a recovery point; on a
    // successful update it's deleted again. Fully automatic, no user action.
    let auto_backup_path = app_dir.join(db::AUTO_BACKUP_FILENAME);
    db::export_database(app_handle.clone(), auto_backup_path.to_string_lossy().to_string())?;

    let folders = db::load_folders(app_handle)?;
    let mut existing: HashMap<String, BookEntry> = db::load_books(app_handle)?
        .into_iter()
        .map(|b| (b.path.clone(), b))
        .collect();

    // Quét tất cả PDF trong các folder đã thêm
    let mut seen = HashSet::new();
    let mut physical_paths = Vec::new();
    for folder in &folders {
        for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) && seen.insert(path.to_path_buf()) {
                physical_paths.push(path.to_path_buf());
            }
        }
    }

    // Build danh sách sách mới, giữ nguyên metadata cũ (tên đã đổi, tags, hidden, starred, descriptions)
    let now_ts = db::now();
    let mut final_books: Vec<BookEntry> = physical_paths
        .iter()
        .map(|pdf_path| {
            let path = pdf_path.to_string_lossy().to_string();
            let thumbnail_path = cache_dir
                .join(format!("thumb_{}.jpg", db::path_hash(&path)))
                .to_string_lossy()
                .to_string();
            match existing.remove(&path) {
                Some(old) => BookEntry {
                    date_added: if old.date_added == 0 { now_ts } else { old.date_added },
                    path,
                    thumbnail_path,
                    ..old
                },
                None => BookEntry {
                    file_name: pdf_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    path,
                    thumbnail_path,
                    date_added: now_ts,
                    ..Default::default()
                },
            }
        })
        .collect();

    // Còn lại trong `existing` = file không còn tồn tại → xóa thumbnail của chúng
    for old in existing.values().filter(|b| !b.thumbnail_path.is_empty()) {
        let _ = std::fs::remove_file(&old.thumbnail_path);
    }

    final_books.sort_by_key(|b| b.file_name.to_lowercase());
    db::save_books(app_handle, final_books.clone())?;

    // =============================================
    // RENDER THUMBNAIL + EMIT PROGRESS
    // Emit event "scan_progress" sau mỗi file — frontend update progress bar
    // =============================================
    let missing: Vec<&BookEntry> = final_books
        .iter()
        .filter(|b| !Path::new(&b.thumbnail_path).exists())
        .collect();
    let total = missing.len();
    let emit = |current: usize, file_name: &str, done: bool| {
        let _ = app_handle.emit("scan_progress", ScanProgress {
            current,
            total,
            file_name: file_name.to_string(),
            done,
        });
    };
    emit(0, "Scanning...", false);

    let mut rendered = 0;
    let mut failed = 0;
    match get_pdfium(app_handle) {
        Ok(pdfium) => {
            for (i, book) in missing.iter().enumerate() {
                let file_name = Path::new(&book.path).file_name().unwrap_or_default().to_string_lossy();
                emit(i + 1, &file_name, false);

                let result: Result<(), String> = (|| {
                    let doc = pdfium.load_pdf_from_file(&book.path, None).map_err(|e| e.to_string())?;
                    let page = doc.pages().get(0).map_err(|e| e.to_string())?;
                    let bitmap = page
                        .render_with_config(&PdfRenderConfig::new().set_target_width(150))
                        .map_err(|e| e.to_string())?;
                    bitmap.as_image().save(&book.thumbnail_path).map_err(|e| e.to_string())
                })();
                match result {
                    Ok(_) => rendered += 1,
                    Err(e) => {
                        failed += 1;
                        eprintln!("[thumb FAIL] {} -> {}", book.path, e);
                    }
                }
            }
        }
        Err(_) => eprintln!("[update_db] pdfium failed to initialize — no thumbnails were rendered"),
    }
    emit(total, "Done", true);

    // Update succeeded end-to-end — the safety backup is no longer needed.
    if let Err(e) = std::fs::remove_file(&auto_backup_path) {
        eprintln!("[update_db] could not remove auto backup file: {}", e);
    }

    Ok(format!(
        "Scanned {} books. New: {}, reused: {}, failed: {}.",
        final_books.len(),
        rendered,
        final_books.len() - total,
        failed
    ))
}

// =============================================
// IN-APP READER
// Render bất kỳ trang nào ra JPEG bytes theo yêu cầu, để hiện trong
// reader overlay của frontend (scroll + zoom qua CSS, không re-render mỗi lần zoom)
//
// PERF: pdfium.load_pdf_from_file() re-parses toàn bộ file mỗi lần gọi — rất
// tốn kém khi mở reader (đọc page count) rồi lại đọc lần nữa cho từng trang
// hiện ra khi cuộn. Giữ lại Pdfium + vài PdfDocument đã mở gần nhất trong bộ
// nhớ (static cache) để các lần gọi sau chỉ cần tái sử dụng, không parse lại.
// =============================================
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();
static DOC_CACHE: OnceLock<Mutex<DocCache>> = OnceLock::new();

const MAX_CACHED_DOCS: usize = 6;

struct DocCache {
    docs: HashMap<String, PdfDocument<'static>>,
    order: Vec<String>, // least-recently-used ở đầu
}

impl DocCache {
    fn get_or_load(
        &mut self,
        pdfium: &'static Pdfium,
        pdf_path: &str,
    ) -> Result<&PdfDocument<'static>, String> {
        if self.docs.contains_key(pdf_path) {
            self.order.retain(|p| p != pdf_path);
            self.order.push(pdf_path.to_string());
        } else {
            if self.order.len() >= MAX_CACHED_DOCS {
                let oldest = self.order.remove(0);
                self.docs.remove(&oldest);
            }
            let doc = pdfium
                .load_pdf_from_file(pdf_path, None)
                .map_err(|e| e.to_string())?;
            self.docs.insert(pdf_path.to_string(), doc);
            self.order.push(pdf_path.to_string());
        }
        Ok(self.docs.get(pdf_path).unwrap())
    }
}

fn get_pdfium(app_handle: &tauri::AppHandle) -> Result<&'static Pdfium, String> {
    if let Some(p) = PDFIUM.get() {
        return Ok(p);
    }
    let p = init_pdfium(app_handle)?;
    let _ = PDFIUM.set(p); // ignore race — another call may have set it first
    Ok(PDFIUM.get().expect("Pdfium just initialized"))
}

fn doc_cache() -> &'static Mutex<DocCache> {
    DOC_CACHE.get_or_init(|| {
        Mutex::new(DocCache {
            docs: HashMap::new(),
            order: Vec::new(),
        })
    })
}

#[tauri::command(async)]
pub fn get_pdf_page_count(app_handle: tauri::AppHandle, book_path: String) -> Result<u16, String> {
    let pdfium = get_pdfium(&app_handle)?;
    let mut cache = doc_cache().lock().map_err(|e| e.to_string())?;
    let doc = cache.get_or_load(pdfium, &book_path)?;
    Ok(doc.pages().len())
}

#[tauri::command(async)]
pub fn render_pdf_page(
    app_handle: tauri::AppHandle,
    book_path: String,
    page_index: u16,
    target_width: i32,
) -> Result<Vec<u8>, String> {
    let cache_settings = crate::page_cache::get_page_cache_settings(app_handle.clone()).unwrap_or_default();

    if let Some(cached) = crate::page_cache::lookup(&app_handle, &cache_settings, &book_path, page_index, target_width) {
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(bytes);
        }
    }

    let bytes = render_page_jpeg(&app_handle, &book_path, page_index, target_width)?;

    crate::page_cache::store(&app_handle, &cache_settings, &book_path, page_index, target_width, &bytes);

    Ok(bytes)
}

// Render 1 trang ra JPEG, không đọc/ghi page cache trên disk
fn render_page_jpeg(
    app_handle: &tauri::AppHandle,
    pdf_path: &str,
    page_index: u16,
    target_width: i32,
) -> Result<Vec<u8>, String> {
    let pdfium = get_pdfium(app_handle)?;
    let mut cache = doc_cache().lock().map_err(|e| e.to_string())?;
    let doc = cache.get_or_load(pdfium, pdf_path)?;
    let page = doc.pages().get(page_index).map_err(|e| e.to_string())?;
    let bitmap = page
        .render_with_config(&PdfRenderConfig::new().set_target_width(target_width))
        .map_err(|e| e.to_string())?;

    let mut bytes: Vec<u8> = Vec::new();
    bitmap
        .as_image()
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

// AI tagging ("Filename + all pages"): render mọi trang ở độ rộng nhỏ.
// Không ghi vào page cache của reader — các bản render nhỏ này reader không dùng.
// Lock doc cache theo từng trang để reader không phải chờ cả quyển.
pub fn render_all_pages_jpeg(
    app_handle: &tauri::AppHandle,
    pdf_path: &str,
    target_width: i32,
) -> Result<Vec<Vec<u8>>, String> {
    let page_count = get_pdf_page_count(app_handle.clone(), pdf_path.to_string())?;
    (0..page_count)
        .map(|index| render_page_jpeg(app_handle, pdf_path, index, target_width))
        .collect()
}

// AI tagging ("Filename + PDF text"): text layer của mọi trang, có đánh dấu số trang.
// Nhanh hơn render ảnh rất nhiều (~0.1s cho 20 trang). PDF scan không có text → chuỗi rỗng.
pub fn extract_pdf_text(app_handle: &tauri::AppHandle, pdf_path: &str) -> Result<String, String> {
    let pdfium = get_pdfium(app_handle)?;
    let mut cache = doc_cache().lock().map_err(|e| e.to_string())?;
    let doc = cache.get_or_load(pdfium, pdf_path)?;
    let mut out = String::new();
    for (index, page) in doc.pages().iter().enumerate() {
        let text = page.text().map(|t| t.all()).unwrap_or_default();
        let text = text.trim();
        if !text.is_empty() {
            out.push_str(&format!("[Page {}]\n{}\n\n", index + 1, text));
        }
    }
    Ok(out)
}
