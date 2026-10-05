use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// ===== CÁC STRUCT DỮ LIỆU =====
// Đây là các "khuôn" dữ liệu. Rust dùng để đọc/ghi JSON.
// Serialize = có thể chuyển sang JSON
// Deserialize = có thể đọc từ JSON

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct FolderDatabase {
    pub folders: Vec<String>, // Danh sách đường dẫn folder đã thêm
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BookEntry {
    pub path: String,           // Đường dẫn đầy đủ tới file PDF
    pub file_name: String,      // Tên hiển thị (có thể đổi tên)
    pub thumbnail_path: String, // Đường dẫn tới ảnh bìa đã render
    pub tags: Vec<String>,      // Danh sách tags
    #[serde(default)]
    pub date_added: i64,        // Timestamp lúc thêm vào thư viện
    // hidden: true = sách đang trong thùng rác
    // #[serde(default)] nghĩa là: nếu file JSON cũ chưa có field này
    // thì tự động hiểu là false — KHÔNG bị lỗi khi đọc dữ liệu cũ
    #[serde(default)]
    pub hidden: bool,
    // starred: true = sách được đánh dấu yêu thích
    // Sách starred luôn hiện đầu grid bất chấp sort
    #[serde(default)]
    pub starred: bool,
    // description: free-form notes about the book (empty = none)
    #[serde(default)]
    pub description: String,
    // short_description: one-line summary (empty = none)
    #[serde(default)]
    pub short_description: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BookDatabase {
    pub books: Vec<BookEntry>, // Toàn bộ sách trong thư viện
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RemoveFolderResult {
    pub folders: Vec<String>,  // Danh sách folder còn lại
    pub removed_books: usize,  // Số sách đã bị xóa khỏi database vì thuộc folder này
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BackupData {
    pub version: u32,          // Phiên bản backup (để sau này nâng cấp định dạng)
    pub exported_at: i64,      // Timestamp lúc export
    pub folders: Vec<String>,  // Danh sách folder
    pub books: Vec<BookEntry>, // Toàn bộ sách (kể cả sách hidden)
}

// Tên file backup tự động tạo bởi scanner.rs trước mỗi lần "Update DB"
pub const AUTO_BACKUP_FILENAME: &str = "auto_backup_before_update.json";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutoBackupInfo {
    pub exported_at: i64,
    pub book_count: usize,
    pub folder_count: usize,
}

// ===== HÀM TIỆN ÍCH (dùng chung cho cả crate) =====

// Timestamp hiện tại (số giây từ 1970)
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// SHA1 của 1 chuỗi (đường dẫn) — dùng đặt tên file thumbnail / page cache
pub fn path_hash(s: &str) -> String {
    use sha1::{Digest, Sha1};
    format!("{:x}", Sha1::digest(s.as_bytes()))
}

// Thư mục data của app (nơi lưu database.json, library_books.json...). Tự tạo nếu chưa có.
pub fn app_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

// Đọc file JSON. Chưa có file hoặc JSON hỏng → giá trị mặc định (rỗng).
pub fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

// ===== LOAD / SAVE =====
// Folders: database.json — Books: library_books.json

pub fn load_folders(app_handle: &tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(read_json::<FolderDatabase>(&app_dir(app_handle)?.join("database.json"))?.folders)
}

fn save_folders(app_handle: &tauri::AppHandle, folders: Vec<String>) -> Result<(), String> {
    write_json(&app_dir(app_handle)?.join("database.json"), &FolderDatabase { folders })
}

pub fn load_books(app_handle: &tauri::AppHandle) -> Result<Vec<BookEntry>, String> {
    Ok(read_json::<BookDatabase>(&app_dir(app_handle)?.join("library_books.json"))?.books)
}

pub fn save_books(app_handle: &tauri::AppHandle, books: Vec<BookEntry>) -> Result<(), String> {
    write_json(&app_dir(app_handle)?.join("library_books.json"), &BookDatabase { books })
}

// Sửa 1 sách theo path rồi lưu lại. Trả về kết quả của `edit`.
fn update_book<R>(
    app_handle: &tauri::AppHandle,
    book_path: &str,
    edit: impl FnOnce(&mut BookEntry) -> R,
) -> Result<R, String> {
    let mut books = load_books(app_handle)?;
    let book = books
        .iter_mut()
        .find(|b| b.path == book_path)
        .ok_or("Book not found")?;
    let result = edit(book);
    save_books(app_handle, books)?;
    Ok(result)
}

// ===== FOLDERS =====

#[tauri::command]
pub fn get_library_folders(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    load_folders(&app_handle)
}

// Thêm folder mới vào danh sách, trả về danh sách folder mới nhất
#[tauri::command]
pub fn add_library_folder(app_handle: tauri::AppHandle, new_path: String) -> Result<Vec<String>, String> {
    let mut folders = load_folders(&app_handle)?;
    if !folders.contains(&new_path) {
        folders.push(new_path);
        folders.sort_by_key(|f| f.to_lowercase());
        save_folders(&app_handle, folders.clone())?;
    }
    Ok(folders)
}

// Xóa folder khỏi danh sách theo dõi, đồng thời xóa luôn mọi sách thuộc
// folder đó khỏi database (không xóa file PDF thật trên đĩa).
#[tauri::command]
pub fn remove_library_folder(
    app_handle: tauri::AppHandle,
    folder_path: String,
) -> Result<RemoveFolderResult, String> {
    let mut folders = load_folders(&app_handle)?;
    folders.retain(|f| f != &folder_path);
    save_folders(&app_handle, folders.clone())?;

    let mut books = load_books(&app_handle)?;
    let prefix = format!("{}/", folder_path.replace('\\', "/").trim_end_matches('/'));
    let before = books.len();
    books.retain(|b| !b.path.replace('\\', "/").starts_with(&prefix));
    let removed_books = before - books.len();
    save_books(&app_handle, books)?;

    Ok(RemoveFolderResult { folders, removed_books })
}

// ===== BOOKS =====

// Lấy toàn bộ sách (cả hidden lẫn không hidden) — frontend tự lọc library / trash
#[tauri::command]
pub fn get_library_books(app_handle: tauri::AppHandle) -> Result<Vec<BookEntry>, String> {
    load_books(&app_handle)
}

// Danh sách tags + số lần dùng, chỉ đếm sách KHÔNG hidden
#[tauri::command]
pub fn get_all_tags(app_handle: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let mut map: HashMap<String, i64> = HashMap::new();
    for book in load_books(&app_handle)?.into_iter().filter(|b| !b.hidden) {
        for tag in book.tags {
            *map.entry(tag).or_insert(0) += 1;
        }
    }
    let mut tags: Vec<(String, i64)> = map.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(tags
        .into_iter()
        .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
        .collect())
}

// Cập nhật tên hiển thị, tags và description của 1 sách
// new_description / new_short_description = None → giữ nguyên giá trị cũ (bulk tag edit, AI auto-tag)
#[tauri::command]
pub fn update_book_info(
    app_handle: tauri::AppHandle,
    book_path: String,
    new_name: String,
    new_tags: Vec<String>,
    new_description: Option<String>,
    new_short_description: Option<String>,
) -> Result<String, String> {
    update_book(&app_handle, &book_path, |book| {
        book.file_name = new_name;
        book.tags = new_tags;
        if let Some(desc) = new_description {
            book.description = desc;
        }
        if let Some(short) = new_short_description {
            book.short_description = short;
        }
    })?;
    Ok("Cập nhật thành công".to_string())
}

// ===== THÙNG RÁC =====
// Không xóa file thật. Chỉ đánh dấu hidden = true/false trong database.

#[tauri::command]
pub fn hide_book(app_handle: tauri::AppHandle, book_path: String) -> Result<(), String> {
    update_book(&app_handle, &book_path, |book| book.hidden = true)
}

#[tauri::command]
pub fn restore_book(app_handle: tauri::AppHandle, book_path: String) -> Result<(), String> {
    update_book(&app_handle, &book_path, |book| book.hidden = false)
}

// Toggle starred, trả về trạng thái mới để frontend cập nhật UI ngay
#[tauri::command]
pub fn toggle_star(app_handle: tauri::AppHandle, book_path: String) -> Result<bool, String> {
    update_book(&app_handle, &book_path, |book| {
        book.starred = !book.starred;
        book.starred
    })
}

// ===== TAG MANAGEMENT =====

// Đổi tên tag (không phân biệt hoa thường) trên tất cả sách có tag đó
#[tauri::command]
pub fn rename_tag(app_handle: tauri::AppHandle, old_name: String, new_name: String) -> Result<String, String> {
    let mut books = load_books(&app_handle)?;
    let old_lower = old_name.to_lowercase();
    let mut count = 0;
    for tag in books.iter_mut().flat_map(|b| b.tags.iter_mut()) {
        if tag.to_lowercase() == old_lower {
            *tag = new_name.clone();
            count += 1;
        }
    }
    save_books(&app_handle, books)?;
    Ok(format!("Renamed '{}' → '{}' in {} books", old_name, new_name, count))
}

// Xóa tag khỏi tất cả sách có tag đó
#[tauri::command]
pub fn delete_tag(app_handle: tauri::AppHandle, tag_name: String) -> Result<String, String> {
    let mut books = load_books(&app_handle)?;
    let lower = tag_name.to_lowercase();
    let mut count = 0;
    for book in books.iter_mut() {
        let before = book.tags.len();
        book.tags.retain(|t| t.to_lowercase() != lower);
        if book.tags.len() < before {
            count += 1;
        }
    }
    save_books(&app_handle, books)?;
    Ok(format!("Deleted '{}' from {} books", tag_name, count))
}

// ===== DUPLICATE DETECTION =====
// Tính SHA1 của nội dung file để tìm duplicate — on-demand, không lưu vào database.
// Emit progress event "duplicate_progress" để frontend hiện progress bar

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DuplicateGroup {
    pub file_hash: String,          // SHA1 hash chung của nhóm
    pub books: Vec<BookEntry>,      // Danh sách sách trùng nhau
}

#[tauri::command(async)]
pub fn find_duplicates(app_handle: tauri::AppHandle) -> Result<Vec<DuplicateGroup>, String> {
    use sha1::{Digest, Sha1};
    use tauri::Emitter;

    let books: Vec<BookEntry> = load_books(&app_handle)?.into_iter().filter(|b| !b.hidden).collect();
    let total = books.len();
    let progress = |current: usize, done: bool| {
        let _ = app_handle.emit("duplicate_progress", serde_json::json!({
            "current": current, "total": total, "done": done
        }));
    };
    progress(0, false);

    let mut hash_map: HashMap<String, Vec<BookEntry>> = HashMap::new();
    for (i, book) in books.into_iter().enumerate() {
        // Bỏ qua file không đọc được
        let Ok(bytes) = std::fs::read(&book.path) else { continue };
        hash_map.entry(format!("{:x}", Sha1::digest(&bytes))).or_default().push(book);
        // Emit progress mỗi 10 file để không spam
        if i % 10 == 0 {
            progress(i + 1, false);
        }
    }
    progress(total, true);

    // Chỉ trả về nhóm có > 1 sách, sort theo tên file của sách đầu tiên
    let mut groups: Vec<DuplicateGroup> = hash_map
        .into_iter()
        .filter(|(_, books)| books.len() > 1)
        .map(|(file_hash, books)| DuplicateGroup { file_hash, books })
        .collect();
    groups.sort_by_key(|g| g.books[0].file_name.to_lowercase());
    Ok(groups)
}

// ===== EXPORT / IMPORT =====
// Backup toàn bộ database ra file JSON (kể cả sách hidden)

#[tauri::command]
pub fn export_database(app_handle: tauri::AppHandle, save_path: String) -> Result<String, String> {
    let backup = BackupData {
        version: 1,
        exported_at: now(),
        folders: load_folders(&app_handle)?,
        books: load_books(&app_handle)?,
    };
    write_json(Path::new(&save_path), &backup)?;
    Ok(format!(
        "Exported {} sách, {} folder → {}",
        backup.books.len(),
        backup.folders.len(),
        save_path
    ))
}

// Import backup — ghi đè toàn bộ database hiện tại.
// Sau khi import cần bấm "Update Database" để render lại thumbnail
#[tauri::command]
pub fn import_database(app_handle: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let s = std::fs::read_to_string(&source_path).map_err(|e| format!("Không mở được file: {}", e))?;
    let backup: BackupData = serde_json::from_str(&s).map_err(|e| format!("File không hợp lệ: {}", e))?;
    let message = format!(
        "Imported {} sách, {} folder. Bấm Update Database để render thumbnail.",
        backup.books.len(),
        backup.folders.len()
    );
    save_folders(&app_handle, backup.folders)?;
    save_books(&app_handle, backup.books)?;
    Ok(message)
}

// ===== AUTO BACKUP (trước mỗi lần "Update DB") =====
// scanner.rs tự tạo file AUTO_BACKUP_FILENAME trước khi update, xóa lại nếu
// thành công. Nếu app khởi động mà vẫn thấy file này còn tồn tại → update lần
// trước có thể đã bị gián đoạn giữa chừng, hỏi user có muốn khôi phục không.

// Kiểm tra có file auto-backup còn sót lại không. None = không có gì để hỏi.
#[tauri::command]
pub fn check_auto_backup(app_handle: tauri::AppHandle) -> Result<Option<AutoBackupInfo>, String> {
    let path = app_dir(&app_handle)?.join(AUTO_BACKUP_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let backup: BackupData = read_json(&path)?;
    Ok(Some(AutoBackupInfo {
        exported_at: backup.exported_at,
        book_count: backup.books.len(),
        folder_count: backup.folders.len(),
    }))
}

// Khôi phục database từ auto-backup, rồi xóa file backup đi
#[tauri::command]
pub fn restore_auto_backup(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = app_dir(&app_handle)?.join(AUTO_BACKUP_FILENAME);
    let result = import_database(app_handle, path.to_string_lossy().to_string())?;
    if let Err(e) = std::fs::remove_file(&path) {
        eprintln!("[auto_backup] could not remove backup after restore: {}", e);
    }
    Ok(result)
}

// Bỏ qua auto-backup — chỉ xóa file, không đụng vào database hiện tại
#[tauri::command]
pub fn discard_auto_backup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = app_dir(&app_handle)?.join(AUTO_BACKUP_FILENAME);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
