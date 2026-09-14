use crate::db::{BookDatabase, BookEntry};
use image::ImageFormat;
use pdfium_render::prelude::*;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs::create_dir_all;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri::Emitter;
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

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn generate_thumb_name(pdf_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(pdf_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("thumb_{}.jpg", hash)
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

pub fn perform_update_database(app_handle: tauri::AppHandle) -> Result<String, String> {
    // PERF LOGGING — "Update Database" has several distinct phases (disk walk,
    // JSON load/write, per-PDF thumbnail render) and slowness reports could come
    // from any of them. Timed with eprintln! (no logging crate in the project
    // yet) so `cargo tauri dev`'s terminal shows where the time actually goes.
    let total_start = Instant::now();

    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache_dir = app_dir.join("cache");
    if !cache_dir.exists() {
        create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }

    // SAFETY BACKUP — export the current database to a JSON file in the app's
    // own data folder before touching anything below. If the update fails
    // partway through, this file is left behind as a recovery point; on a
    // successful update it's deleted again. Fully automatic, no user action.
    let auto_backup_path = app_dir.join(crate::db::AUTO_BACKUP_FILENAME);
    crate::db::export_database(
        app_handle.clone(),
        auto_backup_path.to_string_lossy().to_string(),
    )?;

    let folders = crate::db::get_folders_list(&app_handle);
    eprintln!("[update_db] {} registered folder(s)", folders.len());
    let now_ts = current_timestamp();
    let book_db_path = app_dir.join("library_books.json");

    // Load database cũ để giữ tags, hidden, date_added
    let load_db_start = Instant::now();
    let existing_books: Vec<BookEntry> = if book_db_path.exists() {
        let s = std::fs::read_to_string(&book_db_path).unwrap_or_default();
        serde_json::from_str::<BookDatabase>(&s)
            .unwrap_or(BookDatabase { books: Vec::new() })
            .books
    } else {
        Vec::new()
    };
    eprintln!(
        "[update_db] loaded {} existing entries in {:?}",
        existing_books.len(),
        load_db_start.elapsed()
    );

    let existing_map: HashMap<String, BookEntry> = existing_books
        .into_iter()
        .map(|b| (b.path.clone(), b))
        .collect();

    // Quét tất cả PDF trong các folder đã thêm
    let walk_start = Instant::now();
    let mut physical_paths = Vec::new();
    let mut seen_paths = HashSet::new();

    for folder in &folders {
        let folder_start = Instant::now();
        let mut found_in_folder = 0;
        for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext.to_string_lossy().eq_ignore_ascii_case("pdf")) {
                let path_str = path.to_string_lossy().to_string();
                if seen_paths.insert(path_str.clone()) {
                    physical_paths.push(path.to_path_buf());
                    found_in_folder += 1;
                }
            }
        }
        eprintln!(
            "[update_db]   walked '{}': {} pdf(s) in {:?}",
            folder,
            found_in_folder,
            folder_start.elapsed()
        );
    }
    eprintln!(
        "[update_db] disk walk found {} pdf(s) total in {:?}",
        physical_paths.len(),
        walk_start.elapsed()
    );

    // Xóa thumbnail của file không còn tồn tại
    let cleanup_start = Instant::now();
    let physical_set: HashSet<String> = physical_paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let mut removed_thumbs = 0;
    for old in existing_map.values() {
        if !physical_set.contains(&old.path) && !old.thumbnail_path.is_empty() {
            let _ = std::fs::remove_file(&old.thumbnail_path);
            removed_thumbs += 1;
        }
    }
    eprintln!(
        "[update_db] removed {} orphaned thumbnail(s) in {:?}",
        removed_thumbs,
        cleanup_start.elapsed()
    );

    // Build danh sách sách mới, giữ nguyên metadata cũ
    let mut final_books: Vec<BookEntry> = Vec::new();

    for pdf_path in &physical_paths {
        let pdf_str = pdf_path.to_string_lossy().to_string();

        let old = existing_map.get(&pdf_str);
        // Giữ nguyên tên đã đổi (custom given name) — chỉ dùng tên file vật lý
        // cho sách mới chưa từng có trong database
        let file_name = old.map(|b| b.file_name.clone()).unwrap_or_else(|| {
            pdf_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
        let tags = old.map(|b| b.tags.clone()).unwrap_or_default();
        let date_added = old
            .map(|b| if b.date_added == 0 { now_ts } else { b.date_added })
            .unwrap_or(now_ts);
        // Giữ nguyên trạng thái hidden — không reset khi Update Database
        let hidden = old.map(|b| b.hidden).unwrap_or(false);
        // Giữ nguyên trạng thái starred — không reset khi Update Database
        let starred = old.map(|b| b.starred).unwrap_or(false);

        let thumb_path = cache_dir.join(generate_thumb_name(&pdf_str));
        let thumb_str = thumb_path.to_string_lossy().to_string();

        final_books.push(BookEntry {
            path: pdf_str,
            file_name,
            thumbnail_path: thumb_str,
            tags,
            date_added,
            hidden,
            starred,
        });
    }

    final_books.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));

    // Lưu database
    let write_start = Instant::now();
    let json = serde_json::to_string_pretty(&BookDatabase {
        books: final_books.clone(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&book_db_path, json).map_err(|e| e.to_string())?;
    eprintln!(
        "[update_db] wrote database json ({} books) in {:?}",
        final_books.len(),
        write_start.elapsed()
    );

    // =============================================
    // RENDER THUMBNAIL + EMIT PROGRESS
    // Emit event "scan_progress" sau mỗi file
    // Frontend lắng nghe để update progress bar
    //
    // PERF: chạy tuần tự (không rayon) và load_pdf_from_file lại từ đầu cho
    // mỗi file — đây gần như chắc chắn là phần tốn thời gian nhất của cả quá
    // trình update khi có nhiều PDF chưa có thumbnail, nhất là ở debug build
    // (xem log elapsed bên dưới để xác nhận).
    // =============================================
    let render_loop_start = Instant::now();
    let mut render_new = 0;
    let mut render_reused = 0;
    let mut render_fail = 0;

    // Đếm số file cần render mới (chưa có thumbnail)
    let to_render: Vec<_> = physical_paths
        .iter()
        .filter(|p| {
            let thumb = cache_dir.join(generate_thumb_name(&p.to_string_lossy()));
            !thumb.exists()
        })
        .collect();

    let total_new = to_render.len();
    eprintln!(
        "[update_db] {} pdf(s) need a new thumbnail ({} already cached)",
        total_new,
        physical_paths.len() - total_new
    );

    // Emit event bắt đầu (để frontend hiện progress bar)
    let _ = app_handle.emit("scan_progress", ScanProgress {
        current: 0,
        total: total_new,
        file_name: "Scanning...".to_string(),
        done: false,
    });

    if let Ok(pdfium) = init_pdfium(&app_handle) {
        let mut current = 0;

        for pdf_path in &physical_paths {
            let pdf_str = pdf_path.to_string_lossy().to_string();
            let thumb_path = cache_dir.join(generate_thumb_name(&pdf_str));

            if thumb_path.exists() {
                render_reused += 1;
                continue;
            }

            let file_name = pdf_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            current += 1;

            // Emit progress sau mỗi file bắt đầu render
            let _ = app_handle.emit("scan_progress", ScanProgress {
                current,
                total: total_new,
                file_name: file_name.clone(),
                done: false,
            });

            let file_start = Instant::now();
            let result: Result<(), String> = (|| {
                let doc = pdfium
                    .load_pdf_from_file(pdf_path, None)
                    .map_err(|e| e.to_string())?;
                let page = doc.pages().get(0).map_err(|e| e.to_string())?;
                let bitmap = page
                    .render_with_config(&PdfRenderConfig::new().set_target_width(150))
                    .map_err(|e| e.to_string())?;
                bitmap
                    .as_image()
                    .save(&thumb_path)
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            let file_elapsed = file_start.elapsed();

            // Flag individually slow files so a handful of huge/broken PDFs
            // can be spotted instead of just seeing a slow total.
            if file_elapsed.as_millis() > 500 {
                eprintln!("[update_db]   SLOW thumbnail: {} took {:?}", pdf_str, file_elapsed);
            }

            match result {
                Ok(_) => render_new += 1,
                Err(e) => {
                    render_fail += 1;
                    eprintln!("[thumb FAIL] {} -> {}", pdf_path.display(), e);
                }
            }
        }
    } else {
        eprintln!("[update_db] pdfium failed to initialize — no thumbnails were rendered");
    }

    let render_elapsed = render_loop_start.elapsed();
    eprintln!(
        "[update_db] thumbnail pass done in {:?} — new: {}, reused: {}, failed: {}{}",
        render_elapsed,
        render_new,
        render_reused,
        render_fail,
        if render_new > 0 {
            format!(" (avg {:?}/new file)", render_elapsed / render_new as u32)
        } else {
            String::new()
        }
    );

    // Emit event hoàn thành
    let _ = app_handle.emit("scan_progress", ScanProgress {
        current: total_new,
        total: total_new,
        file_name: "Done".to_string(),
        done: true,
    });

    eprintln!("[update_db] TOTAL update_database time: {:?}", total_start.elapsed());

    // Update succeeded end-to-end — the safety backup is no longer needed.
    if let Err(e) = std::fs::remove_file(&auto_backup_path) {
        eprintln!("[update_db] could not remove auto backup file: {}", e);
    }

    Ok(format!(
        "Scanned {} books. New: {}, reused: {}, failed: {}.",
        final_books.len(),
        render_new,
        render_reused,
        render_fail
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

pub fn get_pdf_page_count(app_handle: &tauri::AppHandle, pdf_path: &str) -> Result<u16, String> {
    let pdfium = get_pdfium(app_handle)?;
    let mut cache = doc_cache().lock().map_err(|e| e.to_string())?;
    let doc = cache.get_or_load(pdfium, pdf_path)?;
    Ok(doc.pages().len())
}

pub fn render_pdf_page(
    app_handle: &tauri::AppHandle,
    pdf_path: &str,
    page_index: u16,
    target_width: i32,
) -> Result<Vec<u8>, String> {
    let cache_settings = crate::page_cache::get_page_cache_settings(app_handle).unwrap_or_default();

    if let Some(cached) = crate::page_cache::lookup(app_handle, &cache_settings, pdf_path, page_index, target_width) {
        if let Ok(bytes) = std::fs::read(&cached) {
            return Ok(bytes);
        }
    }

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

    crate::page_cache::store(app_handle, &cache_settings, pdf_path, page_index, target_width, &bytes);

    Ok(bytes)
}