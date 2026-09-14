use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

// =============================================
// page_cache.rs — On-disk cache of rendered reader pages
//
// render_pdf_page() (scanner.rs) rasterizes a page via pdfium on every call —
// even for a page the user already viewed a moment ago, or a book they read
// yesterday. This caches the resulting JPEG bytes on disk (under
// <app_data_dir>/cache/pages/) so a repeat request is a plain file read.
//
// Cache key = pdf path + the source file's own mtime + page index + render
// width, all baked into the file name:
//
//   page_<sha1(pdf_path)>_<mtime_secs>_<page_index>_<width>.jpg
//
// Baking the source's mtime into the name gets two things for free, with no
// separate manifest/database needed:
//   - Staleness: if the PDF is edited (mtime changes), its old cached pages
//     simply stop matching and are never served again.
//   - Eviction: the requested policy is "evict by the *original PDF's* own
//     creation/update date, oldest first" rather than a classic LRU-by-access
//     log. Since that date is already sitting right there in the file name,
//     eviction just sorts cache files by their embedded mtime — no need to
//     track access times or re-stat every source PDF.
// =============================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PageCacheSettings {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    // Cap in megabytes for the whole page cache. 0 = unlimited.
    #[serde(default = "default_max_mb")]
    pub max_size_mb: u64,
}

fn default_enabled() -> bool {
    true
}

// ~500MB is a few thousand cached pages at the reader's 1600px render width —
// enough to keep several recently-read books instantly reopenable without
// silently eating a large chunk of the user's disk.
fn default_max_mb() -> u64 {
    500
}

impl Default for PageCacheSettings {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            max_size_mb: default_max_mb(),
        }
    }
}

// ===== SETTINGS I/O =====
// Same convention as ai_service.rs: a small JSON file next to the book database.

fn settings_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("page_cache_settings.json"))
}

pub fn get_page_cache_settings(app_handle: &tauri::AppHandle) -> Result<PageCacheSettings, String> {
    let path = settings_path(app_handle)?;
    if !path.exists() {
        return Ok(PageCacheSettings::default());
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

pub fn save_page_cache_settings(
    app_handle: &tauri::AppHandle,
    settings: PageCacheSettings,
) -> Result<String, String> {
    let path = settings_path(app_handle)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Apply a lowered cap immediately rather than waiting for future page
    // renders to slowly trim the cache down.
    if let Ok(dir) = cache_dir(app_handle) {
        evict_if_needed(&dir, settings.max_size_mb);
    }
    Ok("Settings saved".to_string())
}

// ===== CACHE STORAGE =====

fn cache_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("pages");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn path_hash(pdf_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(pdf_path.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn source_mtime_secs(pdf_path: &str) -> Option<u64> {
    fs::metadata(pdf_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn cache_file_name(pdf_path: &str, mtime: u64, page_index: u16, width: i32) -> String {
    format!("page_{}_{}_{}_{}.jpg", path_hash(pdf_path), mtime, page_index, width)
}

// Cache hit → path to the cached JPEG. None on a miss, when the cache is
// disabled, or when the source PDF can't be stat'd (e.g. removable media
// briefly unavailable — falls back to a normal render in that case).
pub fn lookup(
    app_handle: &tauri::AppHandle,
    settings: &PageCacheSettings,
    pdf_path: &str,
    page_index: u16,
    width: i32,
) -> Option<PathBuf> {
    if !settings.enabled {
        return None;
    }
    let mtime = source_mtime_secs(pdf_path)?;
    let dir = cache_dir(app_handle).ok()?;
    let file = dir.join(cache_file_name(pdf_path, mtime, page_index, width));
    if file.exists() {
        Some(file)
    } else {
        None
    }
}

// Best-effort write-through after a fresh render — never fails the render
// itself if the cache write or eviction pass has a problem.
pub fn store(
    app_handle: &tauri::AppHandle,
    settings: &PageCacheSettings,
    pdf_path: &str,
    page_index: u16,
    width: i32,
    bytes: &[u8],
) {
    if !settings.enabled {
        return;
    }
    let Some(mtime) = source_mtime_secs(pdf_path) else { return; };
    let Ok(dir) = cache_dir(app_handle) else { return; };
    let file = dir.join(cache_file_name(pdf_path, mtime, page_index, width));
    if fs::write(&file, bytes).is_ok() {
        evict_if_needed(&dir, settings.max_size_mb);
    }
}

// Deletes cache files, oldest source-PDF mtime first (parsed straight back out
// of the file name — see module doc), until under the cap. max_size_mb == 0
// means unlimited, so it's a no-op.
fn evict_if_needed(dir: &Path, max_size_mb: u64) {
    if max_size_mb == 0 {
        return;
    }
    let cap_bytes = max_size_mb.saturating_mul(1024 * 1024);

    let Ok(read_dir) = fs::read_dir(dir) else { return; };
    let mut entries: Vec<(PathBuf, u64, u64)> = Vec::new(); // (path, source mtime, size)
    let mut total: u64 = 0;
    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue; };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        entries.push((path.clone(), mtime_from_file_name(&path).unwrap_or(0), meta.len()));
    }

    if total <= cap_bytes {
        return;
    }

    entries.sort_by_key(|(_, mtime, _)| *mtime); // oldest source PDF first

    let mut over = total - cap_bytes;
    for (path, _, size) in entries {
        if over == 0 {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            over = over.saturating_sub(size);
        }
    }
}

fn mtime_from_file_name(path: &Path) -> Option<u64> {
    // "page_<hash>_<mtime>_<page_index>_<width>"
    let stem = path.file_stem()?.to_str()?;
    stem.split('_').nth(2)?.parse::<u64>().ok()
}

// Deletes every cached page unconditionally — for the "Purge reader cache"
// settings button, not part of the automatic size-cap eviction above.
pub fn clear_page_cache(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let dir = cache_dir(app_handle)?;

    let mut count: u64 = 0;
    let mut freed: u64 = 0;
    if let Ok(read_dir) = fs::read_dir(&dir) {
        for entry in read_dir.filter_map(|e| e.ok()) {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue; };
            if !meta.is_file() {
                continue;
            }
            let size = meta.len();
            if fs::remove_file(&path).is_ok() {
                count += 1;
                freed += size;
            }
        }
    }

    Ok(format!(
        "Cleared {} cached page(s), freed {:.1} MB.",
        count,
        freed as f64 / (1024.0 * 1024.0)
    ))
}
