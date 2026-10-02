use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{futures::Notified, Mutex, Notify};

// =============================================
// CHATGPT AUTH — "Sign in with ChatGPT" (OpenAI token sharing, open-source flow)
//
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// Flow:
//   1. Lắng nghe callback trên http://127.0.0.1:<port>/auth/callback
//   2. Mở browser tới trang authorize của OpenAI (PKCE + nonce + state)
//      - Lần đầu: client_id=dynamic_agent_client → OpenAI đăng ký app
//        "PDF Tag Simple" trong account ChatGPT và trả về client_id riêng
//      - Lần sau: dùng lại client_id đã lưu
//   3. Đổi code lấy access/refresh/id token, verify id_token bằng JWKS
//   4. Lưu vào chatgpt_auth.json; access token (1h) tự refresh khi gần hết hạn
//
// Inference dùng access token với Responses API — xem ai_service::call_chatgpt.
// Usage tính vào plan ChatGPT của user, không cần API key.
// =============================================

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const REGISTRATION_CLIENT_ID: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "PDF Tag Simple";
const CALLBACK_PATH: &str = "/auth/callback";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
// Refresh access token sớm hơn hạn thật một chút
const EXPIRY_MARGIN_SECS: i64 = 60;

pub const NOT_SIGNED_IN: &str = "Not signed in to ChatGPT. Sign in under Settings > AI Settings.";
const SESSION_ENDED: &str = "Your ChatGPT session has ended. Sign in again under Settings > AI Settings.";

// Hủy lần sign-in đang chờ (user bấm Cancel hoặc bấm Sign in lần nữa)
static CANCEL_SIGN_IN: Notify = Notify::const_new();
// Chỉ 1 lần refresh tại 1 thời điểm — refresh token chỉ dùng được 1 lần
static TOKEN_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct ChatGptAuth {
    // ID cố định của máy này, tạo 1 lần. Hiện chưa gửi lên (SDK mẫu của OpenAI
    // mặc định tắt) — giữ lại để bật khi OpenAI yêu cầu.
    ext_agent_host_id: String,
    // client_id OpenAI cấp khi đăng ký (oaiapp_...) — rỗng nếu chưa đăng ký
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    id_token: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct ChatGptStatus {
    pub signed_in: bool,
    pub email: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ChatGptModel {
    pub slug: String,
    pub display_name: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
}

// ===== STORAGE =====

fn auth_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.join("chatgpt_auth.json"))
}

fn load(app_handle: &tauri::AppHandle) -> Result<ChatGptAuth, String> {
    let path = auth_path(app_handle)?;
    let mut auth: ChatGptAuth = if path.exists() {
        let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).unwrap_or_default()
    } else {
        ChatGptAuth::default()
    };
    if auth.ext_agent_host_id.is_empty() {
        auth.ext_agent_host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        save(app_handle, &auth)?;
    }
    Ok(auth)
}

// Ghi vào file tạm rồi rename — không bao giờ để lại file credentials ghi dở
fn save(app_handle: &tauri::AppHandle, auth: &ChatGptAuth) -> Result<(), String> {
    let path = auth_path(app_handle)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    URL_SAFE_NO_PAD.encode(buf)
}

fn is_signed_in(auth: &ChatGptAuth) -> bool {
    !auth.refresh_token.is_empty() || (!auth.access_token.is_empty() && auth.expires_at > now())
}

// ===== PUBLIC API =====

pub fn status(app_handle: &tauri::AppHandle) -> Result<ChatGptStatus, String> {
    let auth = load(app_handle)?;
    Ok(ChatGptStatus { signed_in: is_signed_in(&auth), email: auth.email })
}

// Quên hết account (giữ ext_agent_host_id). Lần sign-in sau sẽ đăng ký lại,
// nên có thể đổi sang account ChatGPT khác.
pub fn sign_out(app_handle: &tauri::AppHandle) -> Result<(), String> {
    CANCEL_SIGN_IN.notify_waiters();
    let auth = load(app_handle)?;
    save(app_handle, &ChatGptAuth { ext_agent_host_id: auth.ext_agent_host_id, ..Default::default() })
}

pub fn cancel_sign_in() {
    CANCEL_SIGN_IN.notify_waiters();
}

pub async fn sign_in(app_handle: tauri::AppHandle) -> Result<ChatGptStatus, String> {
    // Hủy lần sign-in cũ còn đang chờ (nếu có)
    CANCEL_SIGN_IN.notify_waiters();
    let cancelled = CANCEL_SIGN_IN.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();

    let registering = load(&app_handle)?.client_id.is_empty();
    match authorize(&app_handle, cancelled.as_mut()).await {
        // Code có thể đã dùng/hết hạn ngay sau lần đăng ký đầu. Giống SDK mẫu của
        // OpenAI: thử lại 1 lần với client_id vừa được cấp — không đăng ký app mới.
        Err(SignInError { code: Some(code), .. })
            if code == "invalid_grant" && registering && !load(&app_handle)?.client_id.is_empty() =>
        {
            authorize(&app_handle, cancelled.as_mut()).await.map_err(sign_in_message)
        }
        result => result.map_err(sign_in_message),
    }
}

fn sign_in_message(e: SignInError) -> String {
    match e.code.as_deref() {
        Some("invalid_grant") => "ChatGPT did not accept this sign-in. Please try signing in again.".to_string(),
        _ => e.message,
    }
}

// Lỗi của 1 lượt sign-in — giữ mã lỗi OAuth để sign_in quyết định có thử lại không
struct SignInError {
    code: Option<String>,
    message: String,
}

impl From<String> for SignInError {
    fn from(message: String) -> Self {
        Self { code: None, message }
    }
}

impl From<&str> for SignInError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

// 1 lượt authorize trong browser + đổi code lấy token
async fn authorize(
    app_handle: &tauri::AppHandle,
    mut cancelled: Pin<&mut Notified<'_>>,
) -> Result<ChatGptStatus, SignInError> {
    let mut auth = load(app_handle)?;

    // Listener phải chạy trước khi mở browser
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start sign-in listener: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}{}", port, CALLBACK_PATH);

    let state = random_token();
    let nonce = random_token();
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let registering = auth.client_id.is_empty();
    let request_client_id = if registering { REGISTRATION_CLIENT_ID.to_string() } else { auth.client_id.clone() };

    // Giống SDK mẫu của OpenAI: không gửi ext_agent_host_id (mặc định tắt, chỉ
    // dành cho deployment tương thích) và không đưa token cũ vào URL browser.
    let mut url = url::Url::parse(AUTHORIZE_URL).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &request_client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &challenge);
        if registering {
            q.append_pair("agent_name_hint", AGENT_NAME);
        } else if !auth.email.is_empty() {
            q.append_pair("login_hint", &auth.email);
        }
    }

    app_handle
        .opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Could not open the browser: {}", e))?;

    let params = tokio::select! {
        result = wait_for_callback(&listener) => result?,
        _ = cancelled.as_mut() => return Err("Sign-in cancelled.".into()),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err("Sign-in timed out. Please try again.".into()),
    };
    drop(listener);

    if params.get("state").map(String::as_str) != Some(state.as_str()) {
        return Err("Sign-in failed: the response did not match this sign-in attempt.".into());
    }
    if let Some(error) = params.get("error") {
        return Err(if error == "access_denied" {
            "Sign-in was cancelled in the browser.".into()
        } else {
            format!("Sign-in failed: {}", params.get("error_description").unwrap_or(error)).into()
        });
    }
    let code = params.get("code").cloned().ok_or("Sign-in failed: no authorization code received.")?;

    // Lần đầu: callback trả client_id mới cấp — lưu ngay trước khi đổi code
    let client_id = match params.get("client_id") {
        Some(id) if !id.is_empty() && id != REGISTRATION_CLIENT_ID => id.clone(),
        _ if !registering => request_client_id,
        _ => return Err("Sign-in failed: OpenAI did not return a client ID.".into()),
    };
    if auth.client_id != client_id {
        auth.client_id = client_id.clone();
        save(app_handle, &auth)?;
    }

    let tokens = token_request(&[
        ("grant_type", "authorization_code"),
        ("client_id", &client_id),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect_uri),
        ("resource", RESOURCE),
    ])
    .await
    .map_err(|(code, message)| SignInError { code, message })?;

    let granted: Vec<&str> = tokens.scope.as_deref().unwrap_or("").split_whitespace().collect();
    if !granted.contains(&PLAN_SCOPE) {
        return Err("This ChatGPT account did not allow plan usage for PDF Tag Simple, so it can't be used for tagging.".into());
    }

    let id_token = tokens.id_token.clone().ok_or("Sign-in failed: no ID token received.")?;
    let claims = verify_id_token(&id_token, &client_id, Some(&nonce)).await?;
    if !auth.subject.is_empty() && auth.subject != claims.sub {
        return Err("You signed in with a different ChatGPT account than before. Sign out first to switch accounts.".into());
    }

    auth.subject = claims.sub;
    auth.email = claims.email;
    auth.id_token = id_token;
    apply_tokens(&mut auth, tokens);
    save(app_handle, &auth)?;

    Ok(ChatGptStatus { signed_in: true, email: auth.email })
}

// Trả về access token còn hạn, tự refresh nếu cần
pub async fn access_token(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let _guard = TOKEN_LOCK.lock().await;
    let mut auth = load(app_handle)?;

    if !auth.access_token.is_empty() && auth.expires_at - EXPIRY_MARGIN_SECS > now() {
        return Ok(auth.access_token);
    }
    if auth.refresh_token.is_empty() {
        return Err(NOT_SIGNED_IN.to_string());
    }

    let refresh_token = auth.refresh_token.clone();
    let client_id = auth.client_id.clone();
    match token_request(&[
        ("grant_type", "refresh_token"),
        ("client_id", &client_id),
        ("refresh_token", &refresh_token),
        ("resource", RESOURCE),
    ])
    .await
    {
        Ok(tokens) => {
            if let Some(id_token) = tokens.id_token.clone() {
                let claims = verify_id_token(&id_token, &client_id, None).await?;
                if claims.sub != auth.subject {
                    return Err("Refreshed session belongs to a different ChatGPT account.".to_string());
                }
                auth.id_token = id_token;
            }
            apply_tokens(&mut auth, tokens);
            save(app_handle, &auth)?;
            Ok(auth.access_token)
        }
        Err((Some(code), _)) if is_terminal_refresh_error(&code) => {
            // Session hết hiệu lực — xóa token, giữ client_id/id_token để sign-in lại
            auth.access_token.clear();
            auth.refresh_token.clear();
            auth.expires_at = 0;
            save(app_handle, &auth)?;
            Err(SESSION_ENDED.to_string())
        }
        Err((_, msg)) => Err(msg),
    }
}

pub async fn list_models(app_handle: &tauri::AppHandle) -> Result<Vec<ChatGptModel>, String> {
    let token = access_token(app_handle).await?;
    let response = reqwest::Client::new()
        .get(format!("{}/models", RESOURCE))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Could not load ChatGPT models: {}", e))?;
    let status = response.status();
    let data: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Could not load ChatGPT models ({}): {}", status, error_text(&data)));
    }

    let list = data["models"].as_array().or_else(|| data["data"].as_array()).cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter(|m| m["visibility"].as_str().map_or(true, |v| v == "list"))
        .filter_map(|m| {
            let slug = m["slug"].as_str().or_else(|| m["id"].as_str())?.to_string();
            let display_name = m["display_name"].as_str().unwrap_or(&slug).to_string();
            Some(ChatGptModel { slug, display_name })
        })
        .collect())
}

// ===== HELPERS =====

fn apply_tokens(auth: &mut ChatGptAuth, tokens: TokenResponse) {
    auth.access_token = tokens.access_token;
    if let Some(refresh) = tokens.refresh_token {
        auth.refresh_token = refresh;
    }
    auth.expires_at = now() + tokens.expires_in.unwrap_or(3600);
}

fn is_terminal_refresh_error(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
    )
}

// Lấy mã lỗi từ body JSON — "error" có thể là string hoặc object {code, message}
pub fn error_code(data: &serde_json::Value) -> Option<String> {
    data["error"]["code"]
        .as_str()
        .or_else(|| data["error"].as_str())
        .or_else(|| data["code"].as_str())
        .map(str::to_string)
}

fn error_text(data: &serde_json::Value) -> String {
    data["error"]["message"]
        .as_str()
        .or_else(|| data["error_description"].as_str())
        .map(str::to_string)
        .or_else(|| error_code(data))
        .unwrap_or_else(|| data.to_string())
}

// Err = (mã lỗi nếu có, thông báo cho user)
async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, (Option<String>, String)> {
    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| (None, format!("Could not reach OpenAI sign-in: {}", e)))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let data: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        return Err((error_code(&data), format!("ChatGPT sign-in error ({}): {}", status, error_text(&data))));
    }
    serde_json::from_str(&text).map_err(|e| (None, format!("Unexpected sign-in response: {}", e)))
}

async fn verify_id_token(id_token: &str, client_id: &str, nonce: Option<&str>) -> Result<IdClaims, String> {
    let client = reqwest::Client::new();
    let discovery: serde_json::Value = client
        .get(format!("{}/.well-known/openid-configuration", ISSUER))
        .send()
        .await
        .map_err(|e| format!("Could not verify sign-in: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Could not verify sign-in: {}", e))?;
    let issuer = discovery["issuer"].as_str().unwrap_or(ISSUER).to_string();
    let jwks_uri = discovery["jwks_uri"].as_str().ok_or("Could not verify sign-in: no JWKS URL.")?;
    let jwks: JwkSet = client
        .get(jwks_uri)
        .send()
        .await
        .map_err(|e| format!("Could not verify sign-in: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Could not verify sign-in: {}", e))?;

    let header = jsonwebtoken::decode_header(id_token).map_err(|e| format!("Invalid ID token: {}", e))?;
    let jwk = match header.kid.as_deref() {
        Some(kid) => jwks.find(kid),
        None => jwks.keys.first(),
    }
    .ok_or("Invalid ID token: signing key not found.")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|e| format!("Invalid ID token key: {}", e))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[client_id]);
    let claims = jsonwebtoken::decode::<IdClaims>(id_token, &key, &validation)
        .map_err(|e| format!("Invalid ID token: {}", e))?
        .claims;

    if let Some(expected) = nonce {
        if claims.nonce.as_deref() != Some(expected) {
            return Err("Invalid ID token: nonce mismatch.".to_string());
        }
    }
    if claims.azp.as_deref().is_some_and(|azp| azp != client_id) {
        return Err("Invalid ID token: issued to a different app.".to_string());
    }
    Ok(claims)
}

// Chờ browser redirect về /auth/callback, trả về query params
async fn wait_for_callback(listener: &TcpListener) -> Result<HashMap<String, String>, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 64 * 1024 {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let request = String::from_utf8_lossy(&buf);
        let target = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
        let parsed = url::Url::parse(&format!("http://127.0.0.1{}", target)).ok();

        match parsed {
            Some(u) if u.path() == CALLBACK_PATH => {
                let params: HashMap<String, String> = u.query_pairs().into_owned().collect();
                let ok = params.contains_key("code");
                let message = if ok {
                    "You're signed in to PDF Tag Simple. You can close this tab and return to the app."
                } else {
                    "Sign-in did not complete. You can close this tab and return to the app."
                };
                let body = format!(
                    "<!doctype html><html><head><meta charset=\"utf-8\"><title>PDF Tag Simple</title></head>\
                     <body style=\"font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
                     <p style=\"font-size:16px\">{}</p></body></html>",
                    message
                );
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await;
                let _ = stream.shutdown().await;
                return Ok(params);
            }
            _ => {
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        }
    }
}
