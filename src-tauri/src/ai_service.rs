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
    pub error: Option<String>,  // Nếu có lỗi khi tag sách này
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

fn build_prompt(file_name: &str, vocabulary: &[String], tag_language: &str, max_tags: u32, image_note: &str) -> String {
    let count = if max_tags <= 1 {
        "exactly 1 tag".to_string()
    } else {
        format!("{}-{} tags", max_tags.min(2), max_tags)
    };
    let vocab_instruction = if vocabulary.is_empty() {
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
    };

    let language_instruction = match tag_language {
        "en" => "All tags must be in English.",
        "vi" => "All tags must be in Vietnamese.",
        "zh" => "All tags must be in Chinese (Simplified).",
        "ja" => "All tags must be in Japanese.",
        "ko" => "All tags must be in Korean.",
        "es" => "All tags must be in Spanish.",
        "fr" => "All tags must be in French.",
        "de" => "All tags must be in German.",
        "id" => "All tags must be in Indonesian.",
        _    => "Use the same language as the filename.",
    };

    format!(
        "You are a librarian tagging PDF books. \
        Given the filename: \"{}\"\n\
        {}\
        {}\n\
        Language rule: {}\n\
        Rules:\n\
        - Tags must be short (1-3 words max)\n\
        - No duplicates\n\
        - Series rule: if the filename clearly belongs to a named series followed by a number or volume \
        (e.g. \"My Pals Are Here 3\", \"DK Eyewitness Travel Paris\", \"Goosebumps 12\"), \
        add the series name as a tag WITHOUT the number (e.g. \"My Pals Are Here\", \"DK Eyewitness Travel\"). \
        Do NOT create series tags for standalone books (e.g. \"Nguyen Van 6\", \"Toan 7\") \
        where the number is just a grade level, not a volume in a named series.\n\
        - Respond with ONLY a JSON array of strings, nothing else.\n\
        Example response: [\"self-help\", \"productivity\", \"My Pals Are Here\"]",
        file_name, image_note, vocab_instruction, language_instruction
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
            "This PDF has too many pages to send at once ({} pages, ~{} MB). Use \"Filename + cover image\" for books this long.",
            images.len(),
            total / (1024 * 1024)
        ));
    }
    Ok(images)
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

// ===== OPENAI =====

async fn call_openai(
    api_key: &str,
    model: &str,
    prompt: &str,
    images: &[String],
) -> Result<Vec<String>, String> {
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
        "max_tokens": 100,
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

    Ok(parse_tags_from_response(text))
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
    free_tier: bool,
) -> Result<Vec<String>, (String, bool)> {
    let mut parts = vec![serde_json::json!({ "text": prompt })];
    for b64 in images {
        parts.push(serde_json::json!({ "inlineData": { "mimeType": "image/jpeg", "data": b64 } }));
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
        return Err((format!("Gemini returned no tags ({}).", reason), false));
    }

    Ok(parse_tags_from_response(&text))
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
) -> Result<Vec<String>, String> {
    let mut content: Vec<serde_json::Value> = images
        .iter()
        .map(|b64| serde_json::json!({
            "type": "input_image",
            "image_url": format!("data:image/jpeg;base64,{}", b64),
            "detail": "low"
        }))
        .collect();
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

    Ok(parse_tags_from_response(&output))
}

// ===== OLLAMA =====

async fn call_ollama(
    host: &str,
    model: &str,
    prompt: &str,
    images: &[String],
) -> Result<Vec<String>, String> {
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
            "num_predict": 100
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
    Ok(parse_tags_from_response(text))
}

// ===== MAIN ENTRY POINT =====
// Gọi từ main.rs → frontend

// Suggest tags cho 1 batch sách
// Trả về Vec<AiTagSuggestion> để frontend hiện preview
pub async fn suggest_tags_batch(
    app_handle: tauri::AppHandle,
    books: Vec<BookToTag>,
) -> Result<Vec<AiTagSuggestion>, String> {
    let settings = get_ai_settings(app_handle.clone())?;

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

    let mut results = Vec::new();

    for book in books {
        // Skip nếu đã có đủ tags
        if book.current_tags.len() >= settings.skip_if_tags_gte as usize {
            continue;
        }

        // Ảnh gửi kèm theo input_mode: không có / ảnh bìa / mọi trang
        let images: Vec<String> = match settings.input_mode.as_str() {
            "thumbnail" => thumbnail_to_base64(&book.thumbnail_path).into_iter().collect(),
            "pages" => match pages_to_base64(&app_handle, &book.path).await {
                Ok(pages) => pages,
                Err(e) => {
                    results.push(AiTagSuggestion {
                        path: book.path,
                        file_name: book.file_name,
                        suggested_tags: Vec::new(),
                        error: Some(e),
                    });
                    continue;
                }
            },
            _ => Vec::new(),
        };
        let image_note = match (settings.input_mode.as_str(), images.len()) {
            (_, 0) => String::new(),
            ("pages", n) => format!("The attached images are the pages of the PDF, in order ({} pages).\n", n),
            _ => "The attached image is the book's cover.\n".to_string(),
        };

        let prompt = build_prompt(
            &book.file_name,
            &settings.tag_vocabulary,
            &settings.tag_language,
            settings.max_tags,
            &image_note,
        );

        let tag_result = match settings.provider.as_str() {
            "openai" => {
                call_openai(
                    &settings.openai_api_key,
                    &settings.openai_model,
                    &prompt,
                    &images,
                )
                .await
            }
            "gemini" | "gemini_free" => match call_gemini(
                &settings.gemini_api_key,
                &settings.gemini_model,
                &prompt,
                &images,
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
                    results.push(AiTagSuggestion {
                        path: book.path,
                        file_name: book.file_name,
                        suggested_tags: Vec::new(),
                        error: Some(message),
                    });
                    break;
                }
                Err((message, false)) => Err(message),
            },
            "chatgpt" => match crate::chatgpt_auth::access_token(&app_handle).await {
                Ok(token) => {
                    call_chatgpt(&token, &settings.chatgpt_model, &prompt, &images).await
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
                )
                .await
            }
            _ => Err(format!("Unknown provider: {}", settings.provider)),
        };

        match tag_result {
            Ok(tags) => results.push(AiTagSuggestion {
                path: book.path,
                file_name: book.file_name,
                suggested_tags: limit_tags(tags, settings.max_tags),
                error: None,
            }),
            Err(e) => results.push(AiTagSuggestion {
                path: book.path,
                file_name: book.file_name,
                suggested_tags: Vec::new(),
                error: Some(e),
            }),
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
