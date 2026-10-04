use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

// =============================================
// AI SERVICE — Auto-tag sách bằng AI
//
// Hỗ trợ 5 provider:
//   OpenAI  — online với API key, filename + thumbnail
//   Gemini  — online với Google AI Studio API key, filename + thumbnail
//   Gemini free tier — như Gemini nhưng tự giãn request để không vượt rate limit miễn phí
//   ChatGPT — online, sign in với account ChatGPT (dùng plan của user) — xem chatgpt_auth.rs
//   Ollama  — local, filename only hoặc + thumbnail (vision model)
//
// Flow:
//   1. Frontend gọi ai_suggest_tags với danh sách books
//   2. Backend build prompt, gọi API
//   3. Trả về Vec<AiTagSuggestion> để frontend preview
//   4. User confirm → frontend gọi api.updateBook để apply
// =============================================

// ===== SETTINGS =====
// Lưu trong settings.json cùng thư mục với database.json

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AiSettings {
    // Bật/tắt toàn bộ tính năng AI — khi false, frontend ẩn AI Settings + nút AI Auto-Tag
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    // Provider: "openai" | "gemini" | "gemini_free" | "chatgpt" | "ollama"
    pub provider: String,

    // OpenAI
    pub openai_api_key: String,
    pub openai_model: String,      // "gpt-4o-mini" là default

    // Gemini (dùng chung cho "gemini" và "gemini_free")
    #[serde(default)]
    pub gemini_api_key: String,
    #[serde(default)]
    pub gemini_model: String,      // model id, vd "gemini-3.8-flash" — lấy từ models list

    // ChatGPT (sign in) — slug model lấy từ catalog của account
    #[serde(default)]
    pub chatgpt_model: String,

    // Ollama
    pub ollama_host: String,       // "http://localhost:11434"
    pub ollama_model: String,      // "llama3.2" hoặc "llava" cho vision

    // Input mode
    // "filename"  — chỉ dùng tên file (nhanh, rẻ)
    // "thumbnail" — tên file + ảnh bìa (chính xác hơn, cần vision model)
    // "pages"     — tên file + ảnh của mọi trang (chính xác nhất, chậm/tốn nhất, cần vision model)
    pub input_mode: String,

    // Tag vocabulary — danh sách tag cho phép
    // Nếu rỗng → AI suggest tự do
    // Nếu có → AI chỉ dùng tags trong danh sách này
    pub tag_vocabulary: Vec<String>,

    // Skip sách đã có đủ tags
    pub skip_if_tags_gte: u32,     // Mặc định 5

    // Số tag tối đa AI gợi ý cho mỗi sách
    #[serde(default = "default_max_tags")]
    pub max_tags: u32,

    // Ngôn ngữ tag
    // "auto" — AI tự theo ngôn ngữ tên file
    // "en"   — luôn tag tiếng Anh
    // "vi"   — luôn tag tiếng Việt
    #[serde(default = "default_tag_language")]
    pub tag_language: String,

    // Prompt soạn sẵn — chọn trong modal AI auto làm "Extra instructions"
    #[serde(default)]
    pub saved_prompts: Vec<SavedPrompt>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SavedPrompt {
    pub name: String,
    pub text: String,
}

fn default_tag_language() -> String { "auto".to_string() }
fn default_max_tags() -> u32 { 5 }
fn default_enabled() -> bool { true }

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "openai".to_string(),
            openai_api_key: "".to_string(),
            openai_model: "gpt-4o-mini".to_string(),
            gemini_api_key: "".to_string(),
            gemini_model: "".to_string(),
            chatgpt_model: "".to_string(),
            ollama_host: "http://localhost:11434".to_string(),
            ollama_model: "llama3.2".to_string(),
            input_mode: "filename".to_string(),
            tag_vocabulary: Vec::new(),
            skip_if_tags_gte: 5,
            max_tags: default_max_tags(),
            tag_language: "auto".to_string(),
            saved_prompts: Vec::new(),
        }
    }
}

// ===== INPUT / OUTPUT =====

// Thông tin 1 sách gửi lên để AI tag
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BookToTag {
    pub path: String,
    pub file_name: String,
    pub thumbnail_path: String,  // Dùng khi input_mode = "thumbnail"
    pub current_tags: Vec<String>,
}

// Kết quả AI suggest cho 1 sách
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AiTagSuggestion {
    pub path: String,
    pub file_name: String,
    pub suggested_tags: Vec<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub error: Option<String>,  // Nếu có lỗi khi tag sách này
}

impl AiTagSuggestion {
    fn failed(path: String, file_name: String, error: String) -> Self {
        Self { path, file_name, suggested_tags: Vec::new(), short_description: None, description: None, error: Some(error) }
    }
}

// Những gì user muốn AI điền (checkbox trong modal AI)
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AiFillOptions {
    #[serde(default = "default_true")]
    pub tags: bool,
    #[serde(default)]
    pub short_description: bool,
    #[serde(default)]
    pub description: bool,
    // Hướng dẫn thêm cho lần chạy này (từ prompt soạn sẵn hoặc tự gõ) — rỗng = không gửi
    #[serde(default)]
    pub extra_prompt: String,
}

fn default_true() -> bool { true }

// Những phần cần điền cho 1 sách cụ thể (tags bị bỏ nếu sách đã đủ tags)
#[derive(Debug, Clone, Copy)]
struct Wanted {
    tags: bool,
    short_description: bool,
    description: bool,
}

impl Wanted {
    fn any_text(&self) -> bool {
        self.short_description || self.description
    }
}

// ===== SETTINGS I/O =====

fn settings_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ai_settings.json"))
}

pub fn get_ai_settings(app_handle: tauri::AppHandle) -> Result<AiSettings, String> {
    let path = settings_path(&app_handle)?;
    if !path.exists() {
        return Ok(AiSettings::default());
    }
    let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub fn save_ai_settings(
    app_handle: tauri::AppHandle,
    settings: AiSettings,
) -> Result<String, String> {
    let path = settings_path(&app_handle)?;
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok("Settings saved".to_string())
}

// ===== PROMPT BUILDER =====

fn build_prompt(
    file_name: &str,
    vocabulary: &[String],
    tag_language: &str,
    max_tags: u32,
    image_note: &str,
    want: Wanted,
    extra_prompt: &str,
) -> String {
    let language = match tag_language {
        "en" => "English",
        "vi" => "Vietnamese",
        "zh" => "Chinese (Simplified)",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "id" => "Indonesian",
        _ => "",
    };
    let subject = match (want.tags, want.any_text()) {
        (true, true) => "All tags and descriptions",
        (false, true) => "All descriptions",
        _ => "All tags",
    };
    let language_rule = if language.is_empty() {
        "Use the same language as the filename.".to_string()
    } else {
        format!("{} must be in {}.", subject, language)
    };

    let mut tasks: Vec<String> = Vec::new();
    let mut rules: Vec<String> = Vec::new();

    if want.tags {
        let count = if max_tags <= 1 {
            "exactly 1 tag".to_string()
        } else {
            format!("{}-{} tags", max_tags.min(2), max_tags)
        };
        tasks.push(if vocabulary.is_empty() {
            format!("Suggest {} (short and relevant).", count)
        } else {
            format!(
                "Preferred tag list: [{}]. \
                Use tags from this list when they fit. \
                You may add tags outside the list only if nothing in the list is a good match. \
                Suggest {} total.",
                vocabulary.join(", "),
                count
            )
        });
        rules.push("- Tags must be short (1-3 words max)".to_string());
        rules.push("- No duplicates".to_string());
        rules.push(
            "- Series rule: if the filename clearly belongs to a named series followed by a number or volume \
            (e.g. \"My Pals Are Here 3\", \"DK Eyewitness Travel Paris\", \"Goosebumps 12\"), \
            add the series name as a tag WITHOUT the number (e.g. \"My Pals Are Here\", \"DK Eyewitness Travel\"). \
            Do NOT create series tags for standalone books (e.g. \"Nguyen Van 6\", \"Toan 7\") \
            where the number is just a grade level, not a volume in a named series."
                .to_string(),
        );
    }
    if want.short_description {
        tasks.push("Write a short description: one sentence (at most about 150 characters) saying what the book is.".to_string());
    }
    if want.description {
        tasks.push("Write a longer description: one paragraph of 3-6 sentences about the book's subject, contents and intended reader.".to_string());
    }
    if want.any_text() {
        let source = if image_note.is_empty() { "the filename" } else { "the filename and the provided content" };
        rules.push(format!(
            "- Descriptions: only state what you can tell from {}. Don't invent specific details such as authors, dates or plot points. If the content is unclear, keep it general.",
            source
        ));
    }

    // Chỉ tags → giữ định dạng JSON array như trước; có description → JSON object
    let output = if want.any_text() {
        let mut keys: Vec<&str> = Vec::new();
        let mut example = serde_json::Map::new();
        if want.tags {
            keys.push("\"tags\" (array of strings)");
            example.insert("tags".into(), serde_json::json!(["self-help", "productivity"]));
        }
        if want.short_description {
            keys.push("\"short_description\" (string)");
            example.insert("short_description".into(), serde_json::json!("A practical guide to building better daily habits."));
        }
        if want.description {
            keys.push("\"description\" (string)");
            example.insert(
                "description".into(),
                serde_json::json!("This book explains how small daily habits add up over time. It covers ways to start, keep and track new routines. It is written for readers who want practical steps rather than theory."),
            );
        }
        format!(
            "- Respond with ONLY a JSON object with these keys, nothing else: {}.\nExample response: {}",
            keys.join(", "),
            serde_json::Value::Object(example)
        )
    } else {
        "- Respond with ONLY a JSON array of strings, nothing else.\n\
        Example response: [\"self-help\", \"productivity\", \"My Pals Are Here\"]"
            .to_string()
    };

    // Hướng dẫn của user đặt trước phần định dạng trả lời, để không làm hỏng JSON
    let extra = extra_prompt.trim();
    let extra_block = if extra.is_empty() {
        String::new()
    } else {
        format!(
            "Additional instructions from the user (follow them, but keep the response format below):\n{}\n",
            extra
        )
    };

    let role = if want.any_text() { "You are a librarian cataloguing PDF books." } else { "You are a librarian tagging PDF books." };
    format!(
        "{} Given the filename: \"{}\"\n{}{}\nLanguage rule: {}\nRules:\n{}\n{}{}",
        role,
        file_name,
        image_note,
        tasks.join("\n"),
        language_rule,
        rules.join("\n"),
        extra_block,
        output
    )
}

// ===== THUMBNAIL HELPER =====

// Đọc thumbnail và encode base64 để gửi lên API
fn thumbnail_to_base64(thumbnail_path: &str) -> Option<String> {
    if thumbnail_path.is_empty() {
        return None;
    }
    let path = PathBuf::from(thumbnail_path);
    if !path.exists() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(general_purpose::STANDARD.encode(&bytes))
}

// ===== PAGE IMAGES ("Filename + all pages") =====

// 512px rộng: đủ đọc tiêu đề/đề mục, giữ request nhỏ
const AI_PAGE_WIDTH: i32 = 512;
// Giới hạn tổng dung lượng ảnh (base64) cho 1 sách — dưới giới hạn request của các provider
const MAX_PAGES_PAYLOAD_BYTES: usize = 15 * 1024 * 1024;

async fn pages_to_base64(app_handle: &tauri::AppHandle, pdf_path: &str) -> Result<Vec<String>, String> {
    let app = app_handle.clone();
    let path = pdf_path.to_string();
    // pdfium render là blocking — chạy ngoài async runtime
    let pages = tokio::task::spawn_blocking(move || crate::scanner::render_all_pages_jpeg(&app, &path, AI_PAGE_WIDTH))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not render the pages: {}", e))?;

    let images: Vec<String> = pages.iter().map(|bytes| general_purpose::STANDARD.encode(bytes)).collect();
    let total: usize = images.iter().map(String::len).sum();
    if total > MAX_PAGES_PAYLOAD_BYTES {
        return Err(format!(
            "This PDF has too many pages to send at once ({} pages, ~{} MB). Use \"Filename + PDF text\" for books this long.",
            images.len(),
            total / (1024 * 1024)
        ));
    }
    Ok(images)
}

// ===== PDF FILE / PDF TEXT =====

// Gemini nhận PDF inline tới 50 MB, OpenAI tới 50 MB/file — giữ dưới mức đó (base64 to hơn ~33%)
const MAX_PDF_FILE_BYTES: u64 = 30 * 1024 * 1024;
// ~25k tokens — đủ để tag/mô tả, giữ chi phí và context của model hợp lý
const MAX_PDF_TEXT_CHARS: usize = 100_000;

// PDF gốc gửi kèm ("Filename + PDF file")
struct PdfAttachment {
    filename: String,
    base64: String,
}

async fn pdf_to_base64(pdf_path: &str) -> Result<PdfAttachment, String> {
    let size = std::fs::metadata(pdf_path)
        .map_err(|e| format!("Could not read the PDF: {}", e))?
        .len();
    if size > MAX_PDF_FILE_BYTES {
        return Err(format!(
            "This PDF is too large to send ({} MB, limit {} MB). Use \"Filename + PDF text\" for this book.",
            size / (1024 * 1024),
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        ));
    }
    let filename = std::path::Path::new(pdf_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.pdf".to_string());
    let path = pdf_path.to_string();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not read the PDF: {}", e))?;
    Ok(PdfAttachment { filename, base64: general_purpose::STANDARD.encode(bytes) })
}

// Text layer của PDF, cắt ở MAX_PDF_TEXT_CHARS. Trả về (text, đã bị cắt?)
async fn pdf_text(app_handle: &tauri::AppHandle, pdf_path: &str) -> Result<(String, bool), String> {
    let app = app_handle.clone();
    let path = pdf_path.to_string();
    let text = tokio::task::spawn_blocking(move || crate::scanner::extract_pdf_text(&app, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not read the PDF text: {}", e))?;
    if text.chars().filter(|c| !c.is_whitespace()).count() < 50 {
        return Err("This PDF has (almost) no text — it's probably scanned. Use \"Filename + all pages\" or \"Filename + PDF file\" for this book.".to_string());
    }
    if text.chars().count() > MAX_PDF_TEXT_CHARS {
        return Ok((text.chars().take(MAX_PDF_TEXT_CHARS).collect(), true));
    }
    Ok((text, false))
}

// Nội dung gửi kèm theo input_mode: (ảnh, PDF gốc, ghi chú đặt vào prompt)
async fn prepare_content(
    app_handle: &tauri::AppHandle,
    input_mode: &str,
    book: &BookToTag,
) -> Result<(Vec<String>, Option<PdfAttachment>, String), String> {
    match input_mode {
        "thumbnail" => {
            let images: Vec<String> = thumbnail_to_base64(&book.thumbnail_path).into_iter().collect();
            let note = if images.is_empty() { String::new() } else { "The attached image is the book's cover.\n".to_string() };
            Ok((images, None, note))
        }
        "pages" => {
            let images = pages_to_base64(app_handle, &book.path).await?;
            let note = format!("The attached images are the pages of the PDF, in order ({} pages).\n", images.len());
            Ok((images, None, note))
        }
        "pdf" => {
            let pdf = pdf_to_base64(&book.path).await?;
            Ok((Vec::new(), Some(pdf), "The PDF file itself is attached.\n".to_string()))
        }
        "text" => {
            let (text, truncated) = pdf_text(app_handle, &book.path).await?;
            let note = format!(
                "Text extracted from the PDF{}:\n<<<\n{}\n>>>\n",
                if truncated { " (first part only)" } else { "" },
                text.trim_end()
            );
            Ok((Vec::new(), None, note))
        }
        _ => Ok((Vec::new(), None, String::new())),
    }
}

// Bỏ trùng (không phân biệt hoa thường) và cắt theo max_tags — phòng khi AI trả nhiều hơn yêu cầu
fn limit_tags(tags: Vec<String>, max_tags: u32) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for tag in tags {
        if !unique.iter().any(|t| t.to_lowercase() == tag.to_lowercase()) {
            unique.push(tag);
        }
    }
    unique.truncate(max_tags.max(1) as usize);
    unique
}

// ===== PARSE AI RESPONSE =====

// Parse JSON array từ response AI
// Handle case AI trả thêm text xung quanh
fn parse_tags_from_response(text: &str) -> Vec<String> {
    // Tìm JSON array trong response
    let start = text.find('[');
    let end = text.rfind(']');

    if let (Some(s), Some(e)) = (start, end) {
        let json_str = &text[s..=e];
        if let Ok(tags) = serde_json::from_str::<Vec<String>>(json_str) {
            return tags
                .into_iter()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
        }
    }
    Vec::new()
}

// Đọc câu trả lời theo những gì đã yêu cầu: JSON array (chỉ tags) hoặc JSON object
fn parse_ai_response(text: &str, want: Wanted) -> Result<(Vec<String>, Option<String>, Option<String>), String> {
    if !want.any_text() {
        return Ok((parse_tags_from_response(text), None, None));
    }
    if let (Some(s), Some(e)) = (text.find('{'), text.rfind('}')) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[s..=e]) {
            let tags: Vec<String> = if want.tags {
                v["tags"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let field = |key: &str, wanted: bool| -> Option<String> {
                if !wanted {
                    return None;
                }
                v[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string)
            };
            let short = field("short_description", want.short_description);
            let long = field("description", want.description);
            if !tags.is_empty() || short.is_some() || long.is_some() {
                return Ok((tags, short, long));
            }
        }
    }
    Err("The AI's answer couldn't be read. Try again, or choose another model.".to_string())
}

// ===== OPENAI =====

async fn call_openai(
    api_key: &str,
    model: &str,
    prompt: &str,
    images: &[String],
    pdf: Option<&PdfAttachment>,
    max_output_tokens: u32,
) -> Result<String, String> {
    // PDF gốc: Chat Completions không nhận PDF base64 → dùng Responses API
    if let Some(pdf) = pdf {
        return call_openai_with_pdf(api_key, model, prompt, pdf, max_output_tokens).await;
    }

    let client = reqwest::Client::new();

    // Build message content — ảnh (bìa hoặc các trang, theo thứ tự) + text
    let mut parts: Vec<serde_json::Value> = images
        .iter()
        .map(|b64| serde_json::json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:image/jpeg;base64,{}", b64),
                "detail": "low"  // low = rẻ hơn, đủ để tag
            }
        }))
        .collect();
    parts.push(serde_json::json!({ "type": "text", "text": prompt }));
    let content = serde_json::Value::Array(parts);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": content
            }
        ],
        "max_tokens": max_output_tokens,
        "temperature": 0.3  // Thấp = consistent hơn
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI error {}: {}", status, text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse response failed: {}", e))?;

    let text = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");

    Ok(text.to_string())
}

// OpenAI Responses API với PDF gốc (input_file, base64 data URL)
async fn call_openai_with_pdf(
    api_key: &str,
    model: &str,
    prompt: &str,
    pdf: &PdfAttachment,
    max_output_tokens: u32,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "input": [{
            "role": "user",
            "content": [
                {
                    "type": "input_file",
                    "filename": pdf.filename,
                    "file_data": format!("data:application/pdf;base64,{}", pdf.base64)
                },
                { "type": "input_text", "text": prompt }
            ]
        }],
        "max_output_tokens": max_output_tokens
    });

    let response = reqwest::Client::new()
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {}", e))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OpenAI error {}: {}", status, text));
    }
    let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Parse response failed: {}", e))?;

    // output[] → message → content[] → output_text
    let answer: String = data["output"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item["type"].as_str() == Some("message"))
                .flat_map(|item| item["content"].as_array().cloned().unwrap_or_default())
                .filter(|c| c["type"].as_str() == Some("output_text"))
                .filter_map(|c| c["text"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(answer)
}

// ===== GEMINI =====
// generateContent REST API, key gửi qua header x-goog-api-key (không để trong URL)
// Free/paid do billing của Google Cloud project chứa key quyết định, không phải app

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
// Free tier ~10 request/phút trên các model Flash → mỗi request cách nhau 6.5s
const GEMINI_FREE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(6500);
static GEMINI_LAST_REQUEST: tokio::sync::Mutex<Option<std::time::Instant>> = tokio::sync::Mutex::const_new(None);

#[derive(Serialize, Debug, Clone)]
pub struct GeminiModel {
    pub id: String,
    pub display_name: String,
    // Ghi chú tạm thời từ lần thử, vd "busy right now" — rỗng nếu model trả lời bình thường
    pub note: String,
}

// Kết quả thử 1 model bằng 1 request nhỏ
enum GeminiProbe {
    Usable(String),   // dùng được (kèm ghi chú nếu đang bận / tạm hết quota)
    Unusable,         // không dùng được với key này: đã ngừng, không có quota, không trả text
    KeyError(String), // key sai — lỗi cho cả danh sách
}

async fn probe_gemini_model(client: reqwest::Client, api_key: String, id: String) -> GeminiProbe {
    let body = serde_json::json!({ "contents": [{ "role": "user", "parts": [{ "text": "Reply with OK" }] }] });
    let response = match client
        .post(format!("{}/models/{}:generateContent", GEMINI_BASE, id))
        .header("x-goog-api-key", &api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        // Lỗi mạng tạm thời — vẫn giữ model trong danh sách
        Err(_) => return GeminiProbe::Usable("couldn't be checked".to_string()),
    };
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();

    if status.is_success() {
        let has_text = data["candidates"][0]["content"]["parts"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|p| p["thought"].as_bool() != Some(true) && p["text"].as_str().is_some_and(|t| !t.trim().is_empty())));
        return if has_text { GeminiProbe::Usable(String::new()) } else { GeminiProbe::Unusable };
    }
    let (message, _) = gemini_error(status, &data, &text);
    match status.as_u16() {
        400 | 401 | 403 if message.contains("API key") => GeminiProbe::KeyError(message),
        // "limit: 0" = model không có trong gói (vd Pro / Omni trên free tier)
        429 if text.contains("limit: 0") => GeminiProbe::Unusable,
        429 => GeminiProbe::Usable("limit reached right now".to_string()),
        500 | 503 | 504 => GeminiProbe::Usable("busy right now".to_string()),
        // 404 = đã ngừng cho user mới; các lỗi khác = không dùng được
        _ => GeminiProbe::Unusable,
    }
}

// Model dùng được để tag: Gemini, hỗ trợ generateContent, không phải model ảnh/audio/embedding.
// Models list vẫn liệt kê model đã ngừng hoặc không có trong gói, nên thử từng model
// bằng 1 request nhỏ (chạy song song) và chỉ giữ model trả lời được.
pub async fn list_gemini_models(api_key: &str) -> Result<Vec<GeminiModel>, String> {
    if api_key.trim().is_empty() {
        return Err("Enter a Gemini API key first.".to_string());
    }
    let response = reqwest::Client::new()
        .get(format!("{}/models?pageSize=1000", GEMINI_BASE))
        .header("x-goog-api-key", api_key.trim())
        .send()
        .await
        .map_err(|e| format!("Could not reach Gemini: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    if !status.is_success() {
        return Err(gemini_error(status, &data, &text).0);
    }

    const EXCLUDE: [&str; 10] = [
        "embedding", "image", "tts", "audio", "live", "computer-use", "robotics", "aqa", "transcribe", "customtools",
    ];
    let mut models: Vec<GeminiModel> = Vec::new();
    for m in data["models"].as_array().cloned().unwrap_or_default() {
        let supports_generate = m["supportedGenerationMethods"]
            .as_array()
            .is_some_and(|methods| methods.iter().any(|x| x.as_str() == Some("generateContent")));
        let id = m["name"].as_str().unwrap_or("").trim_start_matches("models/").to_string();
        if !supports_generate || !id.starts_with("gemini") || EXCLUDE.iter().any(|x| id.contains(x)) {
            continue;
        }
        if models.iter().any(|existing| existing.id == id) {
            continue;
        }
        let display_name = m["displayName"].as_str().unwrap_or(&id).to_string();
        models.push(GeminiModel { id, display_name, note: String::new() });
    }

    let client = reqwest::Client::new();
    let mut probes = tokio::task::JoinSet::new();
    for (index, model) in models.iter().enumerate() {
        let (client, key, id) = (client.clone(), api_key.trim().to_string(), model.id.clone());
        probes.spawn(async move { (index, probe_gemini_model(client, key, id).await) });
    }
    let mut outcomes: Vec<Option<GeminiProbe>> = models.iter().map(|_| None).collect();
    while let Some(joined) = probes.join_next().await {
        if let Ok((index, outcome)) = joined {
            outcomes[index] = Some(outcome);
        }
    }

    let mut usable = Vec::new();
    for (mut model, outcome) in models.into_iter().zip(outcomes) {
        match outcome {
            Some(GeminiProbe::KeyError(message)) => return Err(message),
            Some(GeminiProbe::Usable(note)) => {
                model.note = note;
                usable.push(model);
            }
            Some(GeminiProbe::Unusable) => {}
            None => usable.push(model),
        }
    }
    Ok(usable)
}

// Err = (thông báo, fatal). Fatal = dừng cả batch (key sai, hết quota ngày, model không tồn tại)
fn gemini_error(status: reqwest::StatusCode, data: &serde_json::Value, raw: &str) -> (String, bool) {
    let message = data["error"]["message"].as_str().unwrap_or("").to_string();
    let key_problem = message.to_lowercase().contains("api key");
    match status.as_u16() {
        401 | 403 => ("Gemini API key is invalid or has no access. Check it in AI Settings.".to_string(), true),
        400 if key_problem => ("Gemini API key is invalid. Check it in AI Settings.".to_string(), true),
        402 => ("Gemini prepaid credit is used up. Add credit in Google AI Studio.".to_string(), true),
        404 => ("This Gemini model is no longer available. Choose another model in AI Settings.".to_string(), true),
        // "limit: 0" = model không có quota trong gói này (vd Pro / Omni trên free tier)
        429 if raw.contains("limit: 0") => (
            "This Gemini model isn't included in your plan (the free tier has no quota for it). Choose another model in AI Settings.".to_string(),
            true,
        ),
        429 if raw.contains("PerDay") || raw.to_lowercase().contains("per day") => (
            "Gemini's daily request limit is reached. Try again tomorrow, or enable billing on the key's Google Cloud project.".to_string(),
            true,
        ),
        429 => ("Gemini rate limit reached. Try again in a minute.".to_string(), false),
        500 | 503 | 504 => ("Gemini is temporarily unavailable. Try again later.".to_string(), false),
        _ => (format!("Gemini error {}: {}", status, if message.is_empty() { raw.to_string() } else { message }), false),
    }
}

// retryDelay from RetryInfo, e.g. "31s"
fn gemini_retry_delay(data: &serde_json::Value) -> Option<u64> {
    data["error"]["details"].as_array()?.iter().find_map(|d| {
        let delay = d["retryDelay"].as_str()?;
        delay.trim_end_matches('s').parse::<f64>().ok().map(|secs| secs.ceil() as u64)
    })
}

// Free tier: chờ đủ GEMINI_FREE_INTERVAL kể từ request trước (giữ qua các batch)
async fn gemini_pace() {
    let mut last = GEMINI_LAST_REQUEST.lock().await;
    if let Some(previous) = *last {
        let elapsed = previous.elapsed();
        if elapsed < GEMINI_FREE_INTERVAL {
            tokio::time::sleep(GEMINI_FREE_INTERVAL - elapsed).await;
        }
    }
    *last = Some(std::time::Instant::now());
}

async fn call_gemini(
    api_key: &str,
    model: &str,
    prompt: &str,
    images: &[String],
    pdf: Option<&PdfAttachment>,
    free_tier: bool,
) -> Result<String, (String, bool)> {
    let mut parts = vec![serde_json::json!({ "text": prompt })];
    for b64 in images {
        parts.push(serde_json::json!({ "inlineData": { "mimeType": "image/jpeg", "data": b64 } }));
    }
    if let Some(pdf) = pdf {
        parts.push(serde_json::json!({ "inlineData": { "mimeType": "application/pdf", "data": pdf.base64 } }));
    }
    let body = serde_json::json!({ "contents": [{ "role": "user", "parts": parts }] });
    let url = format!("{}/models/{}:generateContent", GEMINI_BASE, model);

    let client = reqwest::Client::new();
    let mut attempt = 0;
    let data = loop {
        if free_tier {
            gemini_pace().await;
        }
        let response = client
            .post(&url)
            .header("x-goog-api-key", api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| (format!("Gemini request failed: {}", e), false))?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        if status.is_success() {
            break data;
        }

        let (message, fatal) = gemini_error(status, &data, &text);
        // Rate limit theo phút / lỗi tạm thời: chờ rồi thử lại tối đa 2 lần
        if !fatal && attempt < 2 && (status.as_u16() == 429 || status.is_server_error()) {
            let wait = gemini_retry_delay(&data).unwrap_or(10 * (attempt as u64 + 1)).min(60);
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            continue;
        }
        return Err((message, fatal));
    };

    if let Some(reason) = data["promptFeedback"]["blockReason"].as_str() {
        return Err((format!("Gemini blocked this request ({}).", reason), false));
    }
    let candidate = &data["candidates"][0];
    // Bỏ qua thought parts, chỉ lấy text trả lời
    let text: String = candidate["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["thought"].as_bool() != Some(true))
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.is_empty() {
        let reason = candidate["finishReason"].as_str().unwrap_or("no answer");
        return Err((format!("Gemini returned no answer ({}).", reason), false));
    }

    Ok(text)
}

// ===== CHATGPT (SIGN IN) =====
// Responses API với OAuth access token — bắt buộc store:false + stream:true,
// không hỗ trợ temperature/max_output_tokens (xem preview limitations trong docs)

fn chatgpt_error_message(code: Option<&str>, fallback: String) -> String {
    match code {
        Some("subscription_sharing_usage_limit_exceeded") => {
            "ChatGPT plan usage limit reached for PDF Tag Simple. Check ChatGPT Settings > Usage, or try again later.".to_string()
        }
        Some("subscription_sharing_usage_unavailable") | Some("subscription_sharing_user_unavailable") => {
            "ChatGPT plan usage is temporarily unavailable. Try again later.".to_string()
        }
        Some("subscription_sharing_user_not_eligible") => {
            "This ChatGPT account isn't eligible to use its plan in other apps.".to_string()
        }
        Some("subscription_sharing_unsupported_capability") => {
            "This request isn't supported with ChatGPT sign-in. If Input Mode includes the cover image, switch to filename only.".to_string()
        }
        Some("subscription_sharing_invalid_user") => {
            "Your ChatGPT session is no longer valid. Sign in again under Settings > AI Settings.".to_string()
        }
        _ => fallback,
    }
}

async fn call_chatgpt(
    access_token: &str,
    model: &str,
    prompt: &str,
    images: &[String],
    pdf: Option<&PdfAttachment>,
) -> Result<String, String> {
    let mut content: Vec<serde_json::Value> = images
        .iter()
        .map(|b64| serde_json::json!({
            "type": "input_image",
            "image_url": format!("data:image/jpeg;base64,{}", b64),
            "detail": "low"
        }))
        .collect();
    if let Some(pdf) = pdf {
        content.push(serde_json::json!({
            "type": "input_file",
            "filename": pdf.filename,
            "file_data": format!("data:application/pdf;base64,{}", pdf.base64)
        }));
    }
    content.push(serde_json::json!({ "type": "input_text", "text": prompt }));

    let body = serde_json::json!({
        "model": model,
        "input": [{ "role": "user", "content": content }],
        "store": false,
        "stream": true
    });

    let response = reqwest::Client::new()
        .post(format!("{}/responses", crate::chatgpt_auth::RESOURCE))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ChatGPT request failed: {}", e))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| format!("ChatGPT request failed: {}", e))?;

    if !status.is_success() {
        let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let code = crate::chatgpt_auth::error_code(&data);
        return Err(chatgpt_error_message(code.as_deref(), format!("ChatGPT error {}: {}", status, text)));
    }

    // Parse SSE: gom các delta, chỉ coi là thành công khi có response.completed
    let mut output = String::new();
    let mut completed = false;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) else { continue };
        match event["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => output.push_str(event["delta"].as_str().unwrap_or("")),
            "response.completed" => completed = true,
            "response.failed" | "error" => {
                let err = if event["response"]["error"].is_object() { &event["response"]["error"] } else { &event["error"] };
                let code = err["code"].as_str().or_else(|| event["code"].as_str());
                let message = err["message"].as_str().or_else(|| event["message"].as_str()).unwrap_or("unknown error");
                return Err(chatgpt_error_message(code, format!("ChatGPT error: {}", message)));
            }
            "response.incomplete" => return Err("ChatGPT response was incomplete.".to_string()),
            _ => {}
        }
    }
    if !completed {
        return Err("ChatGPT response ended unexpectedly.".to_string());
    }

    Ok(output)
}

// ===== OLLAMA =====

async fn call_ollama(
    host: &str,
    model: &str,
    prompt: &str,
    images: &[String],
    max_output_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    // Ollama API: /api/chat
    // images field chỉ dùng khi model hỗ trợ vision
    let mut message = serde_json::json!({
        "role": "user",
        "content": prompt
    });

    if !images.is_empty() {
        message["images"] = serde_json::json!(images);
    }

    let body = serde_json::json!({
        "model": model,
        "messages": [message],
        "stream": false,
        "options": {
            "temperature": 0.3,
            "num_predict": max_output_tokens
        }
    });

    let url = format!("{}/api/chat", host.trim_end_matches('/'));

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {}. Is Ollama running?", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse response failed: {}", e))?;

    let text = data["message"]["content"].as_str().unwrap_or("");
    Ok(text.to_string())
}

// ===== MAIN ENTRY POINT =====
// Gọi từ main.rs → frontend

// Suggest tags cho 1 batch sách
// Trả về Vec<AiTagSuggestion> để frontend hiện preview
pub async fn suggest_tags_batch(
    app_handle: tauri::AppHandle,
    books: Vec<BookToTag>,
    options: AiFillOptions,
) -> Result<Vec<AiTagSuggestion>, String> {
    let settings = get_ai_settings(app_handle.clone())?;

    if !options.tags && !options.short_description && !options.description {
        return Err("Choose at least one thing for the AI to fill in.".to_string());
    }

    // Validate
    if settings.provider == "openai" && settings.openai_api_key.is_empty() {
        return Err("OpenAI API key is not set. Please configure in AI Settings.".to_string());
    }
    let is_gemini = settings.provider == "gemini" || settings.provider == "gemini_free";
    if is_gemini && settings.gemini_api_key.trim().is_empty() {
        return Err("Gemini API key is not set. Please configure in AI Settings.".to_string());
    }
    if is_gemini && settings.gemini_model.is_empty() {
        return Err("No Gemini model selected. Please choose one in AI Settings.".to_string());
    }
    if settings.provider == "chatgpt" && settings.chatgpt_model.is_empty() {
        return Err("No ChatGPT model selected. Please choose one in AI Settings.".to_string());
    }
    if settings.provider == "ollama" && settings.input_mode == "pdf" {
        return Err("Ollama can't read PDF files. Choose \"Filename + PDF text\" as Input Mode in AI Settings.".to_string());
    }

    let mut results = Vec::new();

    for book in books {
        // Tags: bỏ qua nếu sách đã có đủ tags. Description: luôn tạo nếu được chọn.
        let want = Wanted {
            tags: options.tags && book.current_tags.len() < settings.skip_if_tags_gte as usize,
            short_description: options.short_description,
            description: options.description,
        };
        if !want.tags && !want.any_text() {
            continue;
        }
        // Đủ chỗ cho description dài; chỉ tags thì giữ giới hạn nhỏ như trước
        let max_output_tokens = if want.any_text() { 1500 } else { 100 };

        // Nội dung gửi kèm theo input_mode: không có / ảnh bìa / mọi trang / PDF gốc / text
        let (images, pdf, source_note) = match prepare_content(&app_handle, &settings.input_mode, &book).await {
            Ok(content) => content,
            Err(e) => {
                results.push(AiTagSuggestion::failed(book.path, book.file_name, e));
                continue;
            }
        };

        let prompt = build_prompt(
            &book.file_name,
            &settings.tag_vocabulary,
            &settings.tag_language,
            settings.max_tags,
            &source_note,
            want,
            &options.extra_prompt,
        );

        let tag_result = match settings.provider.as_str() {
            "openai" => {
                call_openai(
                    &settings.openai_api_key,
                    &settings.openai_model,
                    &prompt,
                    &images,
                    pdf.as_ref(),
                    max_output_tokens,
                )
                .await
            }
            "gemini" | "gemini_free" => match call_gemini(
                &settings.gemini_api_key,
                &settings.gemini_model,
                &prompt,
                &images,
                pdf.as_ref(),
                settings.provider == "gemini_free",
            )
            .await
            {
                Ok(tags) => Ok(tags),
                // Key sai / hết quota ngày: dừng batch, khỏi gọi tiếp cho các sách còn lại
                Err((message, true)) => {
                    if results.is_empty() {
                        return Err(message);
                    }
                    results.push(AiTagSuggestion::failed(book.path, book.file_name, message));
                    break;
                }
                Err((message, false)) => Err(message),
            },
            "chatgpt" => match crate::chatgpt_auth::access_token(&app_handle).await {
                Ok(token) => {
                    call_chatgpt(&token, &settings.chatgpt_model, &prompt, &images, pdf.as_ref()).await
                }
                // Chưa sign in / session hết hạn — lỗi chung cho cả batch
                Err(e) => return Err(e),
            },
            "ollama" => {
                call_ollama(
                    &settings.ollama_host,
                    &settings.ollama_model,
                    &prompt,
                    &images,
                    max_output_tokens,
                )
                .await
            }
            _ => Err(format!("Unknown provider: {}", settings.provider)),
        };

        match tag_result.and_then(|text| parse_ai_response(&text, want)) {
            Ok((tags, short_description, description)) => results.push(AiTagSuggestion {
                path: book.path,
                file_name: book.file_name,
                suggested_tags: limit_tags(tags, settings.max_tags),
                short_description,
                description,
                error: None,
            }),
            Err(e) => results.push(AiTagSuggestion::failed(book.path, book.file_name, e)),
        }
    }

    Ok(results)
}

// Kiểm tra Ollama có đang chạy không
pub async fn check_ollama(host: &str) -> bool {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tags", host.trim_end_matches('/'));
    client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false)
}
