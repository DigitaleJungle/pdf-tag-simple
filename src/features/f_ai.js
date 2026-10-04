import { api } from "./api.js";

// =============================================
// f_ai.js — AI Auto-Tag feature
//
// Export:
//   renderAiSettingsSection(container) — render các field AI settings vào container
//                                         (dùng trong panel "AI Settings" của Settings modal)
//   openAiAutoTag(books, selectedBooks, currentFilterPath, allFolders, onApplied)
//                                  — mở modal auto-tag với scope selection
// =============================================

// Cost estimate cho OpenAI gpt-4o-mini
// filename only: ~50 tokens/book
// thumbnail: ~500 tokens/book (image low detail ~85 tokens + text)
const TOKENS_PER_BOOK_TEXT = 50;
const TOKENS_PER_BOOK_IMAGE = 500;

// Input modes — dùng chung cho AI Settings (mặc định) và modal AI auto (từng lần chạy)
const INPUT_MODE_OPTIONS = [
    { value: "filename", label: "Filename only" },
    { value: "text", label: "Filename + PDF text" },
    { value: "thumbnail", label: "Filename + cover image" },
    { value: "pages", label: "Filename + all pages (images)" },
    { value: "pdf", label: "Filename + PDF file" },
];
const INPUT_MODE_HINTS = {
    text: "Text of every page (up to ~100,000 characters). Fast and cheap; can't read scanned PDFs.",
    pages: "Every page as a small image. Slow; cost grows with page count (max ~300 pages).",
    pdf: "The original PDF (max 30 MB). Also reads scanned PDFs. Not with Ollama.",
    filename: "Only the filename. Fastest and cheapest.",
    thumbnail: "The cover image. Needs a vision model.",
};

// Select input mode + dòng hint bên dưới, tự cập nhật khi đổi
function makeInputModePicker(selected) {
    const select = makeSelect(INPUT_MODE_OPTIONS, selected);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    function updateHint() {
        const text = INPUT_MODE_HINTS[select.value] || "";
        hint.innerText = text;
        hint.style.display = text ? "" : "none";
    }
    select.addEventListener("change", updateHint);
    updateHint();
    return { select, hint };
}
const COST_PER_1K_INPUT = 0.00015; // gpt-4o-mini input price

function estimateCost(bookCount, inputMode) {
    const tokensPerBook = inputMode === "thumbnail" ? TOKENS_PER_BOOK_IMAGE : TOKENS_PER_BOOK_TEXT;
    const totalTokens = bookCount * tokensPerBook;
    const cost = (totalTokens / 1000) * COST_PER_1K_INPUT;
    return { totalTokens, cost: cost.toFixed(4) };
}

// =============================================
// AI SETTINGS SECTION (rendered inside the Settings modal)
// =============================================
export async function renderAiSettingsSection(container, ctx = {}) {
    const loading = document.createElement("div");
    loading.style.cssText = "color:var(--text-secondary); font-size:13px;";
    loading.innerText = "Loading...";
    container.appendChild(loading);

    let settings = await api.getAiSettings().catch(() => ({
        enabled: true,
        provider: "openai",
        openai_api_key: "",
        openai_model: "gpt-4o-mini",
        gemini_api_key: "",
        gemini_model: "",
        chatgpt_model: "",
        ollama_host: "http://localhost:11434",
        ollama_model: "llama3.2",
        input_mode: "filename",
        tag_vocabulary: [],
        skip_if_tags_gte: 5,
        max_tags: 5,
        tag_language: "auto",
        saved_prompts: [],
    }));

    loading.remove();

    // --- Activate AI ---
    const enabledRow = document.createElement("div");
    enabledRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px;";
    enabledRow.appendChild(makeLabel("Activate AI"));

    const switchLabel = document.createElement("label");
    switchLabel.style.cssText = "position:relative; display:inline-block; width:40px; height:22px; flex-shrink:0; cursor:pointer;";
    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = settings.enabled !== false;
    enabledCheckbox.style.cssText = "opacity:0; width:0; height:0; position:absolute;";
    const track = document.createElement("span");
    const thumb = document.createElement("span");
    thumb.style.cssText = "position:absolute; top:2px; width:18px; height:18px; border-radius:50%; background:white; transition:left .15s; box-shadow:0 1px 2px rgba(0,0,0,0.3); pointer-events:none;";
    track.appendChild(thumb);

    function updateSwitchVisual() {
        track.style.cssText = `position:absolute; inset:0; border-radius:999px; transition:background .15s; background:${enabledCheckbox.checked ? "var(--primary)" : "var(--border-strong)"}; pointer-events:none;`;
        thumb.style.left = enabledCheckbox.checked ? "20px" : "2px";
    }
    updateSwitchVisual();
    switchLabel.appendChild(enabledCheckbox);
    switchLabel.appendChild(track);
    enabledRow.appendChild(switchLabel);
    container.appendChild(enabledRow);

    // Body — tất cả các field còn lại, ẩn hết khi AI bị tắt
    const body = document.createElement("div");
    body.style.cssText = `display:${enabledCheckbox.checked ? "flex" : "none"}; flex-direction:column; gap:14px;`;
    container.appendChild(body);

    enabledCheckbox.addEventListener("change", async () => {
        updateSwitchVisual();
        body.style.display = enabledCheckbox.checked ? "flex" : "none";
        if (typeof ctx.onAiEnabledChange === "function") ctx.onAiEnabledChange(enabledCheckbox.checked);
        try {
            await api.saveAiSettings(gatherSettings());
        } catch (err) {
            console.error("Error saving AI enabled state:", err);
        }
    });

    // Provider
    body.appendChild(makeLabel("Provider"));
    const providerSelect = makeSelect([
        { value: "openai", label: "OpenAI (API key)" },
        { value: "gemini", label: "Gemini (API key)" },
        { value: "gemini_free", label: "Gemini (free tier)" },
        { value: "chatgpt", label: "ChatGPT (sign in with your plan) (beta)" },
        { value: "ollama", label: "Ollama (local)" },
    ], settings.provider);
    body.appendChild(providerSelect);

    // OpenAI section
    const openaiSection = document.createElement("div");
    openaiSection.style.cssText = "display:flex; flex-direction:column; gap:10px;";
    openaiSection.appendChild(makeLabel("OpenAI API Key"));
    const apiKeyInput = makeInput("password", settings.openai_api_key, "sk-...");
    openaiSection.appendChild(apiKeyInput);
    openaiSection.appendChild(makeLabel("OpenAI Model"));
    const openaiModelSelect = makeSelect([
        { value: "gpt-4o-mini", label: "gpt-4o-mini (fast, cheap)" },
        { value: "gpt-4o", label: "gpt-4o (more accurate)" },
    ], settings.openai_model);
    openaiSection.appendChild(openaiModelSelect);

    // Gemini section — dùng chung cho "gemini" và "gemini_free"
    const geminiSection = document.createElement("div");
    geminiSection.style.cssText = "display:flex; flex-direction:column; gap:10px;";
    geminiSection.appendChild(makeLabel("Gemini API Key"));
    const geminiKeyInput = makeInput("password", settings.gemini_api_key || "", "AIza...");
    geminiSection.appendChild(geminiKeyInput);

    geminiSection.appendChild(makeLabel("Gemini Model"));
    const geminiModelRow = document.createElement("div");
    geminiModelRow.style.cssText = "display:flex; gap:8px; align-items:center;";
    const geminiModelSelect = makeSelect([], "");
    geminiModelSelect.style.flex = "1";
    const geminiLoadBtn = document.createElement("button");
    geminiLoadBtn.innerText = "Load models";
    geminiLoadBtn.style.cssText = "flex-shrink:0; padding:8px 12px; border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:12px; background:var(--panel); color:var(--text);";
    geminiModelRow.appendChild(geminiModelSelect);
    geminiModelRow.appendChild(geminiLoadBtn);
    geminiSection.appendChild(geminiModelRow);

    const geminiStatus = document.createElement("div");
    geminiStatus.style.cssText = "font-size:12px; color:var(--text-secondary);";
    geminiSection.appendChild(geminiStatus);

    const geminiHint = document.createElement("div");
    geminiHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    geminiHint.innerText = "Get a key at aistudio.google.com. Free or paid depends on billing for the key's Google Cloud project.";
    geminiSection.appendChild(geminiHint);

    const geminiFreeNote = document.createElement("div");
    geminiFreeNote.style.cssText = "font-size:11px; line-height:1.45; color:var(--text-secondary); background:var(--panel-soft); border:1px solid var(--border); border-radius:8px; padding:8px 10px;";
    geminiFreeNote.innerHTML = `
        <div><b>Rate limit:</b> ~10 requests/minute and ~1,000/day. The app waits ~6 s between books (100 books ≈ 10 min). No Pro models.</div>
        <div style="margin-top:6px;"><b>Privacy:</b> Google may use what you send (filenames, images, text) to improve its products, and people may review it. Avoid sensitive files.</div>`;
    geminiSection.appendChild(geminiFreeNote);

    let geminiModels = null; // null = not loaded yet

    function renderGeminiModels() {
        const isFree = providerSelect.value === "gemini_free";
        const saved = geminiModelSelect.value || settings.gemini_model || "";
        geminiModelSelect.innerHTML = "";
        // Pro models aren't available on the free tier
        const list = (geminiModels || []).filter(m => !isFree || !m.id.includes("-pro"));
        if (saved && !list.some(m => m.id === saved)) {
            if (geminiModels === null) list.unshift({ id: saved, display_name: saved });
        }
        if (list.length === 0) {
            const o = document.createElement("option");
            o.value = "";
            o.innerText = geminiModels === null ? "Click \"Load models\"" : "No models available for this key";
            geminiModelSelect.appendChild(o);
            return;
        }
        // Default: a Flash model that answered normally, when nothing is chosen yet
        const fallback = list.find(m => m.id.includes("flash") && !m.note) || list.find(m => !m.note) || list[0];
        const selected = list.some(m => m.id === saved) ? saved : fallback.id;
        list.forEach(m => {
            const o = document.createElement("option");
            o.value = m.id;
            const label = m.display_name && m.display_name !== m.id ? `${m.display_name} (${m.id})` : m.id;
            o.innerText = m.note ? `${label} — ${m.note}` : label;
            if (m.id === selected) o.selected = true;
            geminiModelSelect.appendChild(o);
        });
    }

    async function loadGeminiModels() {
        geminiStatus.style.color = "var(--text-secondary)";
        geminiStatus.innerText = "Checking which models work with this key...";
        geminiLoadBtn.disabled = true;
        try {
            geminiModels = await api.geminiModels(geminiKeyInput.value.trim());
            geminiStatus.innerText = "";
        } catch (err) {
            geminiStatus.innerText = String(err);
            geminiStatus.style.color = "var(--danger)";
        } finally {
            geminiLoadBtn.disabled = false;
            renderGeminiModels();
        }
    }

    geminiLoadBtn.onclick = loadGeminiModels;
    geminiKeyInput.addEventListener("change", () => { if (geminiKeyInput.value.trim()) loadGeminiModels(); });
    renderGeminiModels();

    // ChatGPT (sign in) section
    const chatgptSection = document.createElement("div");
    chatgptSection.style.cssText = "display:flex; flex-direction:column; gap:10px;";
    chatgptSection.appendChild(makeLabel("ChatGPT Account"));

    const chatgptStatusRow = document.createElement("div");
    chatgptStatusRow.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";
    const chatgptStatus = document.createElement("span");
    chatgptStatus.style.cssText = "font-size:12px; color:var(--text-secondary); flex:1; min-width:150px;";
    const chatgptSignInBtn = document.createElement("button");
    chatgptSignInBtn.style.cssText = "padding:6px 12px; border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:12px; background:var(--panel); color:var(--text);";
    chatgptStatusRow.appendChild(chatgptStatus);
    chatgptStatusRow.appendChild(chatgptSignInBtn);
    chatgptSection.appendChild(chatgptStatusRow);

    const chatgptModelLabel = makeLabel("ChatGPT Model");
    chatgptSection.appendChild(chatgptModelLabel);
    const chatgptModelSelect = makeSelect([], "");
    chatgptSection.appendChild(chatgptModelSelect);

    const chatgptHint = document.createElement("div");
    chatgptHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    chatgptHint.innerText = "Signs in via your browser and uses your ChatGPT plan's limits. No API key needed.";
    chatgptSection.appendChild(chatgptHint);

    let chatgptState = "signed-out"; // "signed-out" | "waiting" | "signed-in"

    function renderChatgptState(email = "") {
        const signedIn = chatgptState === "signed-in";
        chatgptStatus.style.color = signedIn ? "#2e7d32" : "var(--text-secondary)";
        chatgptStatus.innerText = signedIn
            ? `Signed in${email ? " as " + email : ""}`
            : chatgptState === "waiting" ? "Waiting for sign-in in your browser..." : "Not signed in";
        chatgptSignInBtn.innerText = signedIn ? "Sign out" : chatgptState === "waiting" ? "Cancel" : "Sign in with ChatGPT";
        chatgptModelLabel.style.display = signedIn ? "" : "none";
        chatgptModelSelect.style.display = signedIn ? "" : "none";
    }

    async function loadChatgptModels() {
        chatgptModelSelect.innerHTML = "";
        const loadingOpt = document.createElement("option");
        loadingOpt.innerText = "Loading models...";
        chatgptModelSelect.appendChild(loadingOpt);
        try {
            const models = await api.chatgptModels();
            chatgptModelSelect.innerHTML = "";
            const saved = settings.chatgpt_model;
            if (saved && !models.some(m => m.slug === saved)) models.unshift({ slug: saved, display_name: saved });
            models.forEach(m => {
                const o = document.createElement("option");
                o.value = m.slug;
                o.innerText = m.display_name || m.slug;
                if (m.slug === saved) o.selected = true;
                chatgptModelSelect.appendChild(o);
            });
            if (models.length === 0) {
                const none = document.createElement("option");
                none.value = ""; none.innerText = "No models available for this account";
                chatgptModelSelect.appendChild(none);
            }
        } catch (err) {
            chatgptModelSelect.innerHTML = "";
            const errOpt = document.createElement("option");
            errOpt.value = settings.chatgpt_model || "";
            errOpt.innerText = settings.chatgpt_model || "Could not load models";
            chatgptModelSelect.appendChild(errOpt);
            chatgptStatus.innerText = String(err);
            chatgptStatus.style.color = "var(--danger)";
        }
    }

    chatgptSignInBtn.onclick = async () => {
        if (chatgptState === "waiting") {
            await api.chatgptCancelSignIn().catch(() => {});
            return;
        }
        if (chatgptState === "signed-in") {
            await api.chatgptSignOut().catch(err => console.error("ChatGPT sign out failed:", err));
            chatgptState = "signed-out";
            renderChatgptState();
            return;
        }
        chatgptState = "waiting";
        renderChatgptState();
        try {
            const status = await api.chatgptSignIn();
            chatgptState = "signed-in";
            renderChatgptState(status.email);
            await loadChatgptModels();
        } catch (err) {
            chatgptState = "signed-out";
            renderChatgptState();
            chatgptStatus.innerText = String(err);
            chatgptStatus.style.color = "var(--danger)";
        }
    };

    try {
        const status = await api.chatgptStatus();
        chatgptState = status.signed_in ? "signed-in" : "signed-out";
        renderChatgptState(status.email);
        if (status.signed_in) loadChatgptModels();
    } catch (err) {
        renderChatgptState();
    }

    // Ollama section
    const ollamaSection = document.createElement("div");
    ollamaSection.style.cssText = "display:flex; flex-direction:column; gap:10px;";
    ollamaSection.appendChild(makeLabel("Ollama Host"));
    const ollamaHostInput = makeInput("text", settings.ollama_host, "http://localhost:11434");
    ollamaSection.appendChild(ollamaHostInput);

    const ollamaStatusRow = document.createElement("div");
    ollamaStatusRow.style.cssText = "display:flex; gap:8px; align-items:center;";
    const ollamaStatus = document.createElement("span");
    ollamaStatus.style.cssText = "font-size:12px; color:var(--text-secondary);";
    ollamaStatus.innerText = "Not checked";
    const checkBtn = document.createElement("button");
    checkBtn.innerText = "Check connection";
    checkBtn.style.cssText = "padding:6px 12px; border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:12px; background:var(--panel); color:var(--text);";
    checkBtn.onclick = async () => {
        ollamaStatus.innerText = "Checking...";
        const ok = await api.checkOllama(ollamaHostInput.value);
        ollamaStatus.innerText = ok ? "Connected" : "Not reachable";
        ollamaStatus.style.color = ok ? "#2e7d32" : "#c00";
    };
    ollamaStatusRow.appendChild(checkBtn);
    ollamaStatusRow.appendChild(ollamaStatus);
    ollamaSection.appendChild(ollamaStatusRow);
    ollamaSection.appendChild(makeLabel("Ollama Model"));
    const ollamaModelInput = makeInput("text", settings.ollama_model, "llama3.2");
    ollamaSection.appendChild(ollamaModelInput);
    const ollamaHint = document.createElement("div");
    ollamaHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    ollamaHint.innerText = "For image methods, use a vision model (llava, llama3.2-vision).";
    ollamaSection.appendChild(ollamaHint);

    body.appendChild(openaiSection);
    body.appendChild(geminiSection);
    body.appendChild(chatgptSection);
    body.appendChild(ollamaSection);

    function updateProviderSections() {
        openaiSection.style.display = providerSelect.value === "openai" ? "flex" : "none";
        const isGemini = providerSelect.value === "gemini" || providerSelect.value === "gemini_free";
        geminiSection.style.display = isGemini ? "flex" : "none";
        geminiFreeNote.style.display = providerSelect.value === "gemini_free" ? "" : "none";
        if (isGemini) {
            if (geminiModels === null && geminiKeyInput.value.trim()) loadGeminiModels();
            else renderGeminiModels();
        }
        chatgptSection.style.display = providerSelect.value === "chatgpt" ? "flex" : "none";
        ollamaSection.style.display = providerSelect.value === "ollama" ? "flex" : "none";
    }
    providerSelect.addEventListener("change", updateProviderSections);
    updateProviderSections();

    // Input mode
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("AI Method (default)"));
    const { select: inputModeSelect, hint: inputModeHint } = makeInputModePicker(settings.input_mode);
    body.appendChild(inputModeSelect);
    body.appendChild(inputModeHint);

    // Tag language
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("Tag Language"));
    const langSelect = makeSelect([
        { value: "auto", label: "Auto (follow filename language)" },
        { value: "en",   label: "English" },
        { value: "vi",   label: "Vietnamese (Tiếng Việt)" },
        { value: "zh",   label: "Chinese (中文)" },
        { value: "ja",   label: "Japanese (日本語)" },
        { value: "ko",   label: "Korean (한국어)" },
        { value: "es",   label: "Spanish (Español)" },
        { value: "fr",   label: "French (Français)" },
        { value: "de",   label: "German (Deutsch)" },
        { value: "id",   label: "Indonesian (Bahasa)" },
    ], settings.tag_language || "auto");
    body.appendChild(langSelect);

    // Skip threshold
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("Skip books with tags ≥"));
    const skipInput = makeInput("number", String(settings.skip_if_tags_gte), "5");
    skipInput.style.width = "80px";
    body.appendChild(skipInput);
    const skipHint = document.createElement("div");
    skipHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    skipHint.innerText = "Books with this many tags are skipped for tagging.";
    body.appendChild(skipHint);

    // Max tags per book
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("Max tags per book"));
    const maxTagsInput = makeInput("number", String(settings.max_tags ?? 5), "5");
    maxTagsInput.min = "1";
    maxTagsInput.max = "20";
    maxTagsInput.style.width = "80px";
    body.appendChild(maxTagsInput);
    const maxTagsHint = document.createElement("div");
    maxTagsHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    maxTagsHint.innerText = "Maximum tags the AI suggests per book.";
    body.appendChild(maxTagsHint);

    // Tag vocabulary
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("Tag Vocabulary (optional)"));
    const vocabHint = document.createElement("div");
    vocabHint.style.cssText = "font-size:11px; color:var(--text-secondary); margin-bottom:6px;";
    vocabHint.innerText = "Preferred tags the AI uses when they fit. Leave empty for free tagging.";
    body.appendChild(vocabHint);

    let vocabTags = [...(settings.tag_vocabulary || [])];
    const vocabEditor = document.createElement("div");
    vocabEditor.style.cssText = "border:1px solid var(--border); border-radius:10px; padding:8px; min-height:52px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; background:var(--panel);";
    const vocabInput = makeInput("text", "", "Add tag and press Enter...");
    vocabInput.style.cssText = "border:none; outline:none; flex:1; min-width:150px; font-size:13px; padding:4px 2px; background:transparent;";

    function renderVocabChips() {
        vocabEditor.innerHTML = "";
        vocabTags.forEach((tag, i) => {
            const chip = document.createElement("span");
            chip.style.cssText = "display:inline-flex; align-items:center; gap:4px; background:var(--primary-soft); border:1px solid var(--primary); color:var(--primary); border-radius:999px; padding:4px 8px; font-size:12px;";
            const t = document.createElement("span"); t.innerText = tag;
            const x = document.createElement("button");
            x.innerText = "x"; x.style.cssText = "border:none; background:transparent; color:var(--primary); cursor:pointer; font-size:12px; padding:0;";
            x.onclick = () => { vocabTags.splice(i, 1); renderVocabChips(); };
            chip.appendChild(t); chip.appendChild(x);
            vocabEditor.appendChild(chip);
        });
        vocabEditor.appendChild(vocabInput);
    }
    vocabInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const tag = vocabInput.value.trim();
            if (tag && !vocabTags.includes(tag)) { vocabTags.push(tag); vocabInput.value = ""; renderVocabChips(); }
            else vocabInput.value = "";
        }
    });
    renderVocabChips();
    body.appendChild(vocabEditor);

    // Saved prompts — chọn được trong cửa sổ AI auto làm "Extra instructions"
    body.appendChild(makeDivider());
    body.appendChild(makeLabel("Saved prompts (optional)"));
    const promptsHint = document.createElement("div");
    promptsHint.style.cssText = "font-size:11px; color:var(--text-secondary); margin-bottom:6px;";
    promptsHint.innerText = "Instructions you can pick in the AI auto window. Click Save Settings to keep changes.";
    body.appendChild(promptsHint);

    let savedPrompts = (settings.saved_prompts || []).map(p => ({ name: p.name, text: p.text }));
    let editingIndex = -1; // -1 = đang thêm prompt mới

    const promptList = document.createElement("div");
    promptList.style.cssText = "display:flex; flex-direction:column; gap:6px;";
    body.appendChild(promptList);

    const promptForm = document.createElement("div");
    promptForm.style.cssText = "display:flex; flex-direction:column; gap:6px; border:1px solid var(--border); border-radius:10px; padding:10px; background:var(--panel);";
    const promptNameInput = makeInput("text", "", "Prompt name");
    const promptTextInput = document.createElement("textarea");
    promptTextInput.rows = 3;
    promptTextInput.placeholder = "Instructions for the AI...";
    promptTextInput.style.cssText = "width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; outline:none; box-sizing:border-box; background:var(--panel); color:var(--text); font-family:inherit; resize:vertical;";
    [promptNameInput, promptTextInput].forEach(el => el.addEventListener("keydown", (e) => {
        // Ctrl+A chọn text trong ô thay vì "select all books"
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") e.stopPropagation();
    }));
    const promptFormButtons = document.createElement("div");
    promptFormButtons.style.cssText = "display:flex; gap:8px; align-items:center;";
    const promptSaveBtn = makeBtn("Add prompt", false, null);
    const promptCancelBtn = makeBtn("Cancel", false, null);
    const promptFormStatus = document.createElement("span");
    promptFormStatus.style.cssText = "font-size:12px; color:var(--danger);";
    promptFormButtons.appendChild(promptSaveBtn);
    promptFormButtons.appendChild(promptCancelBtn);
    promptFormButtons.appendChild(promptFormStatus);
    promptForm.appendChild(promptNameInput);
    promptForm.appendChild(promptTextInput);
    promptForm.appendChild(promptFormButtons);
    body.appendChild(promptForm);

    function resetPromptForm() {
        editingIndex = -1;
        promptNameInput.value = "";
        promptTextInput.value = "";
        promptSaveBtn.innerText = "Add prompt";
        promptCancelBtn.style.display = "none";
        promptFormStatus.innerText = "";
    }

    function renderPromptList() {
        promptList.innerHTML = "";
        savedPrompts.forEach((p, i) => {
            const item = document.createElement("div");
            item.style.cssText = "display:flex; align-items:flex-start; gap:8px; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--panel-soft);";
            const textWrap = document.createElement("div");
            textWrap.style.cssText = "flex:1; min-width:0;";
            const name = document.createElement("div");
            name.style.cssText = "font-size:13px; font-weight:600; color:var(--text);";
            name.innerText = p.name;
            const preview = document.createElement("div");
            preview.style.cssText = "font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
            preview.innerText = p.text;
            preview.title = p.text;
            textWrap.appendChild(name);
            textWrap.appendChild(preview);
            const editBtn = makeBtn("Edit", false, () => {
                editingIndex = i;
                promptNameInput.value = p.name;
                promptTextInput.value = p.text;
                promptSaveBtn.innerText = "Update prompt";
                promptCancelBtn.style.display = "";
                promptFormStatus.innerText = "";
                promptNameInput.focus();
            });
            const deleteBtn = makeBtn("Delete", false, () => {
                savedPrompts.splice(i, 1);
                if (editingIndex === i) resetPromptForm();
                else if (editingIndex > i) editingIndex--;
                renderPromptList();
            });
            [editBtn, deleteBtn].forEach(b => { b.style.padding = "5px 10px"; b.style.fontSize = "12px"; });
            item.appendChild(textWrap);
            item.appendChild(editBtn);
            item.appendChild(deleteBtn);
            promptList.appendChild(item);
        });
    }

    promptSaveBtn.onclick = () => {
        const name = promptNameInput.value.trim();
        const text = promptTextInput.value.trim();
        if (!name || !text) {
            promptFormStatus.innerText = "Enter a name and the prompt text.";
            return;
        }
        const duplicate = savedPrompts.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (duplicate !== -1 && duplicate !== editingIndex) {
            promptFormStatus.innerText = "A prompt with this name already exists.";
            return;
        }
        if (editingIndex >= 0) savedPrompts[editingIndex] = { name, text };
        else savedPrompts.push({ name, text });
        resetPromptForm();
        renderPromptList();
    };
    promptCancelBtn.onclick = resetPromptForm;
    resetPromptForm();
    renderPromptList();

    function gatherSettings() {
        const v = vocabInput.value.trim();
        if (v && !vocabTags.includes(v)) vocabTags.push(v);
        return {
            enabled: enabledCheckbox.checked,
            provider: providerSelect.value,
            openai_api_key: apiKeyInput.value.trim(),
            openai_model: openaiModelSelect.value,
            gemini_api_key: geminiKeyInput.value.trim(),
            // Giữ model cũ nếu danh sách chưa load được
            gemini_model: geminiModelSelect.value || settings.gemini_model || "",
            // Giữ model cũ nếu catalog chưa load được
            chatgpt_model: chatgptModelSelect.value || settings.chatgpt_model || "",
            ollama_host: ollamaHostInput.value.trim(),
            ollama_model: ollamaModelInput.value.trim(),
            input_mode: inputModeSelect.value,
            tag_language: langSelect.value,
            tag_vocabulary: vocabTags,
            skip_if_tags_gte: parseInt(skipInput.value) || 5,
            max_tags: Math.min(20, Math.max(1, parseInt(maxTagsInput.value) || 5)),
            saved_prompts: savedPrompts,
        };
    }

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:4px;";
    const saveStatus = document.createElement("span");
    saveStatus.style.cssText = "font-size:12px; color:var(--text-secondary);";
    const saveBtn = makeBtn("Save Settings", true, async () => {
        try {
            await api.saveAiSettings(gatherSettings());
            saveStatus.innerText = "Saved.";
            saveStatus.style.color = "#2e7d32";
        } catch (err) {
            saveStatus.innerText = "Error saving settings: " + err;
            saveStatus.style.color = "var(--danger)";
        }
    });
    footer.appendChild(saveBtn);
    footer.appendChild(saveStatus);
    body.appendChild(footer);
}

// =============================================
// AI AUTO-TAG MODAL
//
// Params:
//   allBooks          — state.books filter !hidden
//   selectedBooks     — Set<path> từ main.js
//   currentFilterPath — folder đang chọn
//   onApplied         — callback sau khi apply xong
// =============================================
export async function openAiAutoTag(allBooks, selectedBooks, currentFilterPath, onApplied) {
    document.querySelectorAll(".ai-autotag-overlay").forEach(el => el.remove());

    const settings = await api.getAiSettings().catch(() => null);
    if (!settings) { alert("Could not load AI settings."); return; }
    if (settings.provider === "openai" && !settings.openai_api_key) {
        alert("OpenAI API key is not set. Please configure in AI Settings.");
        return;
    }
    if (settings.provider === "gemini" || settings.provider === "gemini_free") {
        if (!settings.gemini_api_key) {
            alert("Gemini API key is not set. Please configure in AI Settings.");
            return;
        }
        if (!settings.gemini_model) {
            alert("No Gemini model selected. Please choose one in AI Settings and save.");
            return;
        }
    }
    if (settings.provider === "chatgpt") {
        const status = await api.chatgptStatus().catch(() => ({ signed_in: false }));
        if (!status.signed_in) {
            alert("Not signed in to ChatGPT. Please sign in under Settings > AI Settings.");
            return;
        }
        if (!settings.chatgpt_model) {
            alert("No ChatGPT model selected. Please choose one in AI Settings and save.");
            return;
        }
    }

    // Số sách xử lý song song. Gemini free tier phải tuần tự (backend giãn request ~6.5s),
    // Ollama chạy trên máy user nên song song chỉ tranh nhau tài nguyên.
    const CONCURRENCY = (settings.provider === "gemini_free" || settings.provider === "ollama") ? 1 : 4;

    // Scope options
    const selectedArr = selectedBooks ? [...selectedBooks] : [];
    const folderBooks = currentFilterPath && currentFilterPath !== "All Documents"
        ? allBooks.filter(b => b.path.replace(/\\/g, "/").startsWith(currentFilterPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/"))
        : [];

    const overlay = document.createElement("div");
    overlay.className = "ai-autotag-overlay";
    // Trên reader (z-index 6000), vì AI auto cũng mở được từ summary panel trong reader
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:6500; padding:20px;";

    const modal = document.createElement("div");
    modal.style.cssText = "width:min(700px,100%); background:var(--panel); color:var(--text); border-radius:14px; box-shadow:var(--shadow-md); overflow:hidden; font-family:inherit; max-height:90vh; display:flex; flex-direction:column; border:1px solid var(--border);";

    // Header
    const header = document.createElement("div");
    header.style.cssText = "padding:16px 18px 12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-shrink:0;";
    header.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text);">AI Auto-Tag</div>`;
    // Handler thật được gán sau (closeModal) — cần refresh grid nếu đã lưu kết quả
    const headerCloseBtn = makeCloseBtn(() => overlay.remove());
    header.appendChild(headerCloseBtn);

    // Body
    const body = document.createElement("div");
    body.style.cssText = "padding:18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; flex:1;";

    // --- Scope selection ---
    // Tất cả lựa chọn nằm trong optionsWrap — thu gọn thành 1 dòng tóm tắt khi bấm Start
    const optionsWrap = document.createElement("div");
    optionsWrap.style.cssText = "display:flex; flex-direction:column; gap:12px;";
    body.appendChild(optionsWrap);
    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex; flex-direction:column; gap:12px;";
    optionsWrap.appendChild(topRow);

    // "Advanced": các lựa chọn ít dùng + giải thích, đóng mặc định (nhớ trạng thái)
    const moreDetails = document.createElement("details");
    moreDetails.style.cssText = "border:1px solid var(--border); border-radius:8px; padding:8px 12px; background:var(--panel-soft);";
    try { moreDetails.open = localStorage.getItem("aiMoreOptionsOpen") === "true"; } catch { /* ignore */ }
    moreDetails.addEventListener("toggle", () => {
        try { localStorage.setItem("aiMoreOptionsOpen", String(moreDetails.open)); } catch { /* ignore */ }
    });
    const moreSummary = document.createElement("summary");
    moreSummary.style.cssText = "cursor:pointer; font-size:13px; font-weight:600; color:var(--text); user-select:none;";
    moreSummary.innerText = "Advanced";
    moreDetails.appendChild(moreSummary);
    const moreBody = document.createElement("div");
    moreBody.style.cssText = "display:flex; flex-direction:column; gap:10px; margin-top:10px;";
    moreDetails.appendChild(moreBody);

    const scopeBlock = document.createElement("div");
    scopeBlock.style.cssText = "display:flex; flex-direction:column; gap:6px; min-width:0;";
    scopeBlock.appendChild(makeLabel("Books"));

    const scopeOptions = [
        { value: "all", label: `All books (${allBooks.length})` },
    ];
    if (folderBooks.length > 0) {
        scopeOptions.push({ value: "folder", label: `Current folder (${folderBooks.length})` });
    }
    if (selectedArr.length > 0) {
        scopeOptions.push({ value: "selected", label: `Selected books (${selectedArr.length})` });
    }

    const scopeSelect = makeSelect(scopeOptions, selectedArr.length > 0 ? "selected" : "all");
    scopeBlock.appendChild(scopeSelect);
    topRow.appendChild(scopeBlock);

    // --- What to fill in ---
    // Lựa chọn được nhớ lại giữa các lần mở (chỉ là tiện ích, lỗi storage thì dùng mặc định)
    let fillOptions = { tags: true, short_description: false, description: false };
    try {
        const saved = JSON.parse(localStorage.getItem("aiFillOptions") || "null");
        if (saved && typeof saved === "object") fillOptions = { ...fillOptions, ...saved };
    } catch { /* ignore */ }

    const fillBlock = document.createElement("div");
    fillBlock.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px;";
    fillBlock.appendChild(makeLabel("Fill in"));
    const fillRow = document.createElement("div");
    fillRow.style.cssText = "display:flex; flex-wrap:wrap; gap:16px;";
    const fillCheckboxes = {};
    [
        { key: "tags", label: "Tags" },
        { key: "short_description", label: "Short description" },
        { key: "description", label: "Long description" },
    ].forEach(({ key, label }) => {
        const wrap = document.createElement("label");
        wrap.style.cssText = "display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text); cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!fillOptions[key];
        cb.addEventListener("change", () => {
            fillOptions[key] = cb.checked;
            try { localStorage.setItem("aiFillOptions", JSON.stringify(fillOptions)); } catch { /* ignore */ }
            updateCostEstimate();
        });
        fillCheckboxes[key] = cb;
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(label));
        fillRow.appendChild(wrap);
    });
    fillBlock.appendChild(fillRow);
    const fillHint = document.createElement("div");
    fillHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    fillHint.innerText = "Descriptions replace the current ones (editable before applying). Best with PDF text, pages or PDF file.";

    // Lưu ngay từng kết quả khi về, không cần review/Apply all (nhớ lại giữa các lần mở)
    let applyImmediately = false;
    try { applyImmediately = localStorage.getItem("aiApplyImmediately") === "true"; } catch { /* ignore */ }
    const immediateLabel = document.createElement("label");
    immediateLabel.style.cssText = "display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text); cursor:pointer; margin-top:2px;";
    const immediateCheckbox = document.createElement("input");
    immediateCheckbox.type = "checkbox";
    immediateCheckbox.checked = applyImmediately;
    immediateCheckbox.addEventListener("change", () => {
        applyImmediately = immediateCheckbox.checked;
        try { localStorage.setItem("aiApplyImmediately", String(applyImmediately)); } catch { /* ignore */ }
    });
    immediateLabel.appendChild(immediateCheckbox);
    immediateLabel.appendChild(document.createTextNode("Apply results immediately"));
    optionsWrap.appendChild(fillBlock);
    optionsWrap.appendChild(immediateLabel);
    optionsWrap.appendChild(moreDetails);

    // --- Input cho lần chạy này --- (mặc định theo AI Settings, không lưu lại)
    const inputBlock = document.createElement("div");
    inputBlock.style.cssText = "display:flex; flex-direction:column; gap:6px; min-width:0;";
    inputBlock.appendChild(makeLabel("AI Method"));
    const { select: runInputSelect, hint: runInputHint } = makeInputModePicker(settings.input_mode || "filename");
    // Giải thích dạng tooltip trên select; cũng hiện ở cuối "Advanced"
    const updateInputTooltip = () => { runInputSelect.title = INPUT_MODE_HINTS[runInputSelect.value] || ""; };
    runInputSelect.addEventListener("change", () => { updateInputTooltip(); updateCostEstimate(); updateMoreSummary(); });
    updateInputTooltip();
    inputBlock.appendChild(runInputSelect);
    moreBody.appendChild(inputBlock);

    // --- Extra instructions ---
    // Chọn prompt soạn sẵn rồi sửa cho lần chạy này (không lưu lại), tự gõ, hoặc để trống
    const promptBlock = document.createElement("div");
    promptBlock.style.cssText = "display:flex; flex-direction:column; gap:6px;";
    promptBlock.appendChild(makeLabel("Extra instructions (optional)"));
    const savedPrompts = settings.saved_prompts || [];
    const promptSelect = makeSelect([
        { value: "", label: savedPrompts.length > 0 ? "- select -" : "- no saved prompts yet -" },
        ...savedPrompts.map((p, i) => ({ value: String(i), label: p.name })),
    ], "");
    const promptText = document.createElement("textarea");
    promptText.rows = 3;
    promptText.placeholder = "Leave empty to send no extra instructions.";
    promptText.style.cssText = "width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; outline:none; box-sizing:border-box; background:var(--panel); color:var(--text); font-family:inherit; resize:vertical;";
    promptText.addEventListener("keydown", (e) => {
        // Ctrl+A chọn text trong ô thay vì "select all books"
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") e.stopPropagation();
    });
    promptSelect.addEventListener("change", () => {
        const picked = savedPrompts[parseInt(promptSelect.value)];
        promptText.value = picked ? picked.text : "";
        updateMoreSummary();
    });
    promptText.addEventListener("input", () => updateMoreSummary());

    // Nhớ prompt dùng lần trước (lưu khi bấm Start). Lưu theo tên prompt, không theo index,
    // vì danh sách saved prompts có thể đã đổi. Lỗi storage → bắt đầu trống như bình thường.
    try {
        const last = JSON.parse(localStorage.getItem("aiLastPrompt") || "null");
        if (last && typeof last.text === "string") {
            const index = savedPrompts.findIndex(p => p.name === last.name);
            if (index !== -1) promptSelect.value = String(index);
            promptText.value = last.text;
        }
    } catch { /* ignore */ }
    function rememberPrompt() {
        const picked = savedPrompts[parseInt(promptSelect.value)];
        try {
            localStorage.setItem("aiLastPrompt", JSON.stringify({ name: picked ? picked.name : "", text: promptText.value }));
        } catch { /* ignore */ }
    }

    const promptHint = document.createElement("div");
    promptHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    promptHint.innerText = "Only for this run; your last instructions are remembered. Manage saved prompts in AI Settings.";
    promptBlock.appendChild(promptSelect);
    promptBlock.appendChild(promptText);
    promptBlock.appendChild(promptHint);
    moreBody.appendChild(promptBlock);

    // Giải thích, gom ở cuối "Advanced"
    const helpBlock = document.createElement("div");
    helpBlock.style.cssText = "display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:8px;";
    helpBlock.appendChild(fillHint);
    helpBlock.appendChild(runInputHint);
    moreBody.appendChild(helpBlock);

    // Tiêu đề "Advanced" cho biết đang chọn gì, để không có gì bị ẩn mà không biết
    function updateMoreSummary() {
        // Input luôn được nhắc, vì nó nằm trong panel đang đóng
        const active = [`method: ${(INPUT_MODE_OPTIONS.find(o => o.value === runInputSelect.value)?.label || runInputSelect.value).replace(/ \(.*\)$/, "")}`];
        const instructions = promptText.value.trim();
        if (instructions) {
            const picked = savedPrompts[parseInt(promptSelect.value)];
            active.push(`instructions: ${picked && picked.text.trim() === instructions ? picked.name : "custom"}`);
        }
        moreSummary.innerText = active.length ? `Advanced · ${active.join(" · ")}` : "Advanced";
    }
    updateMoreSummary();

    // Tóm tắt 1 dòng thay cho optionsWrap khi đang chạy / review
    const runSummary = document.createElement("div");
    runSummary.style.cssText = "display:none; font-size:12px; color:var(--text-secondary); background:var(--panel-soft); border:1px solid var(--border); border-radius:8px; padding:8px 12px;";
    body.appendChild(runSummary);

    // Sách cần xử lý: thiếu tags (khi chọn Tags) hoặc có chọn description
    function needsWork(b) {
        return (fillOptions.tags && (b.tags?.length || 0) < settings.skip_if_tags_gte)
            || fillOptions.short_description || fillOptions.description;
    }

    // --- Cost estimate ---
    // Ẩn hoàn toàn khi provider = ollama (local = free, không cần estimate)
    const costBox = document.createElement("div");
    costBox.style.cssText = "font-size:12px; color:var(--text-secondary);";

    function updateCostEstimate() {
        // Ẩn cost box khi dùng Ollama (free), ChatGPT (tính vào plan) hoặc Gemini trả phí (giá tùy model)
        if (settings.provider === "ollama" || settings.provider === "chatgpt" || settings.provider === "gemini") {
            costBox.style.display = "none";
            return;
        }
        costBox.style.display = "";

        const scope = scopeSelect.value;
        let books;
        if (scope === "selected") books = allBooks.filter(b => selectedArr.includes(b.path));
        else if (scope === "folder") books = folderBooks;
        else books = allBooks;

        const eligible = books.filter(needsWork);

        // Gemini free tier: no cost, but time (~6.5 s per book) and a daily limit
        if (settings.provider === "gemini_free") {
            const minutes = Math.ceil((eligible.length * 6.5) / 60);
            costBox.innerHTML = `<b>Gemini free tier:</b> ~${eligible.length} books · about ${minutes} min (~6 s per book${runInputSelect.value === "pages" ? ", plus page rendering" : ""})` +
                (eligible.length > 1000 ? "<br>⚠️ Over the ~1,000 requests/day free limit — the run stops when it's reached." : "");
            return;
        }
        const { totalTokens, cost } = estimateCost(eligible.length, runInputSelect.value);

        let costText = `~${eligible.length} books · ~${totalTokens.toLocaleString()} tokens · Est. cost: $${cost}`;
        if (fillOptions.short_description || fillOptions.description) {
            costText += " + descriptions";
        }
        if (runInputSelect.value === "thumbnail") {
            costText += " ⚠️ Thumbnail mode costs more";
        } else if (runInputSelect.value === "pages" || runInputSelect.value === "pdf") {
            // Số trang chưa biết trước — mỗi trang tốn gần bằng 1 ảnh bìa
            costText = `~${eligible.length} books · cost depends on page count`;
        } else if (runInputSelect.value === "text") {
            // Độ dài text chưa biết trước — tối đa ~25k tokens mỗi sách
            costText = `~${eligible.length} books · cost depends on text length (max ~25k tokens/book)`;
        }

        costBox.innerHTML = `<b>Estimate:</b> ${costText}`;
        costBox.title = `Provider: ${settings.provider} · Input: ${runInputSelect.value} · Language: ${settings.tag_language || "auto"} · Skip ≥${settings.skip_if_tags_gte} tags`;
    }

    scopeSelect.addEventListener("change", updateCostEstimate);
    updateCostEstimate();
    body.appendChild(costBox);

    // --- Progress + results ---
    const statusText = document.createElement("div");
    statusText.style.cssText = "font-size:13px; color:var(--text-secondary);";
    statusText.innerText = "Click Start to begin.";

    const progressWrap = document.createElement("div");
    progressWrap.style.cssText = "background:var(--border); border-radius:3px; height:6px; overflow:hidden; display:none;";
    const progressFill = document.createElement("div");
    progressFill.style.cssText = "height:100%; width:0%; background:var(--primary); transition:width 0.3s;";
    progressWrap.appendChild(progressFill);

    const resultsWrap = document.createElement("div");
    resultsWrap.style.cssText = "display:flex; flex-direction:column; gap:8px;";

    body.appendChild(statusText);
    body.appendChild(progressWrap);
    body.appendChild(resultsWrap);

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "padding:14px 18px; border-top:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:10px; background:var(--panel-soft); flex-shrink:0;";
    const footerLeft = document.createElement("div");
    footerLeft.style.cssText = "font-size:12px; color:var(--text-secondary);";
    const footerRight = document.createElement("div");
    footerRight.style.cssText = "display:flex; gap:8px;";

    const cancelBtn = makeBtn("Cancel", false, () => overlay.remove());
    const startBtn = makeBtn("Start", true, null);
    const applyBtn = makeBtn("Apply all", true, null);
    applyBtn.style.display = "none";
    applyBtn.style.background = "var(--success)";
    applyBtn.style.borderColor = "var(--success)";

    footerRight.appendChild(cancelBtn);
    footerRight.appendChild(startBtn);
    footerRight.appendChild(applyBtn);
    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let allSuggestions = [];
    let appliedCount = 0;

    // Start
    startBtn.onclick = async () => {
        const scope = scopeSelect.value;
        let booksToProcess;
        if (scope === "selected") booksToProcess = allBooks.filter(b => selectedArr.includes(b.path));
        else if (scope === "folder") booksToProcess = folderBooks;
        else booksToProcess = allBooks;

        if (!fillOptions.tags && !fillOptions.short_description && !fillOptions.description) {
            statusText.innerText = "Choose at least one thing for the AI to fill in.";
            return;
        }
        if (settings.provider === "ollama" && runInputSelect.value === "pdf") {
            statusText.innerText = "Ollama can't read PDF files. Choose \"Filename + PDF text\" instead.";
            return;
        }
        const eligible = booksToProcess.filter(needsWork);

        if (eligible.length === 0) {
            statusText.innerText = "No books to process (all have enough tags already).";
            return;
        }

        startBtn.disabled = true;
        scopeSelect.disabled = true;
        Object.values(fillCheckboxes).forEach(cb => { cb.disabled = true; });
        immediateCheckbox.disabled = true;
        const saveAsTheyArrive = applyImmediately;
        promptSelect.disabled = true;
        promptText.disabled = true;
        runInputSelect.disabled = true;
        const runOptions = { ...fillOptions, extra_prompt: promptText.value.trim(), input_mode: runInputSelect.value };

        // Thu gọn lựa chọn thành 1 dòng để kết quả có chỗ
        const filled = [["tags", "Tags"], ["short_description", "Short description"], ["description", "Long description"]]
            .filter(([key]) => runOptions[key]).map(([, label]) => label).join(", ");
        const inputLabel = (INPUT_MODE_OPTIONS.find(o => o.value === runOptions.input_mode)?.label || runOptions.input_mode).replace(/ \(.*\)$/, "");
        const summaryParts = [`${eligible.length} book${eligible.length === 1 ? "" : "s"}`, filled, inputLabel];
        if (runOptions.extra_prompt) summaryParts.push("with extra instructions");
        if (saveAsTheyArrive) summaryParts.push("saving immediately");
        runSummary.innerText = summaryParts.join(" · ");
        runSummary.title = runOptions.extra_prompt ? `Extra instructions: ${runOptions.extra_prompt}` : "";
        optionsWrap.style.display = "none";
        runSummary.style.display = "";
        rememberPrompt();
        progressWrap.style.display = "";
        resultsWrap.innerHTML = "";
        allSuggestions = [];

        const total = eligible.length;
        let processed = 0;
        let runError = null;

        // Gửi từng sách một (để progress bar cập nhật sau mỗi sách), CONCURRENCY sách cùng lúc.
        // Lỗi dừng cả lượt chạy (key sai, hết quota ngày, chưa sign in...) → các worker dừng nhận sách mới.
        let nextIndex = 0;
        const showProgress = () => {
            statusText.innerText = `Processing... ${processed}/${total} books`;
            progressFill.style.width = `${Math.round((processed / total) * 100)}%`;
        };
        showProgress();

        async function worker() {
            while (!runError && nextIndex < eligible.length) {
                const b = eligible[nextIndex++];
                try {
                    const suggestions = await api.suggestTagsBatch([{
                        path: b.path,
                        file_name: b.file_name,
                        thumbnail_path: b.thumbnail_path || "",
                        current_tags: b.tags || [],
                    }], runOptions);

                    allSuggestions.push(...suggestions);
                    for (const s of suggestions) {
                        resultsWrap.appendChild(renderSuggestionRow(s, allBooks.find(x => x.path === s.path)));
                    }
                    if (saveAsTheyArrive && suggestions.some(s => !s.error)) {
                        // Lấy danh sách mới nhất để merge với tags hiện có
                        const books = await api.getBooks();
                        for (const s of suggestions) await applySuggestion(s, books);
                    }
                } catch (err) {
                    runError = runError || err;
                }
                processed++;
                showProgress();
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, worker));

        const doneCount = allSuggestions.filter(s => !s.error).length;
        if (runError) {
            // Show the error (it used to be overwritten right away by "Done!")
            statusText.innerText = `Stopped: ${runError} (${doneCount}/${total} books done)`;
            statusText.style.color = "var(--danger)";
        } else {
            statusText.innerText = `Done! ${doneCount}/${total} books processed.`;
        }
        progressFill.style.width = "100%";
        startBtn.style.display = "none";
        if (saveAsTheyArrive) {
            // Đã lưu từng sách khi kết quả về — không cần Apply all
            cancelBtn.innerText = "Close";
            footerLeft.innerText = `${appliedCount} book${appliedCount === 1 ? "" : "s"} saved as results arrived.`;
        } else {
            applyBtn.style.display = "";
            footerLeft.innerText = "Review the results above, then click Apply.";
        }
    };

    // Lưu kết quả của 1 sách (dùng cho "Apply all" và cho "Apply immediately").
    // books = danh sách mới nhất từ backend, để merge với tags hiện có.
    async function applySuggestion(s, books) {
        if (s.error || s.applied) return false;

        // Đọc giá trị (có thể đã sửa) từ preview row
        const row = resultsWrap.querySelector(`[data-path="${CSS.escape(s.path)}"]`);
        let finalTags = s.suggested_tags;
        let shortText = s.short_description || "";
        let longText = s.description || "";
        if (row) {
            finalTags = [...row.querySelectorAll(".tag-chip-text")].map(el => el.innerText).filter(Boolean);
            const shortEl = row.querySelector(".ai-short-description");
            const longEl = row.querySelector(".ai-description");
            if (shortEl) shortText = shortEl.value;
            if (longEl) longText = longEl.value;
        }
        shortText = shortText.trim();
        longText = longText.trim();
        // Chỉ lưu description khi được tạo ở lần chạy này và không bị xóa trống
        const newShort = s.short_description != null && shortText ? shortText : undefined;
        const newLong = s.description != null && longText ? longText : undefined;
        if (finalTags.length === 0 && newShort === undefined && newLong === undefined) return false;

        try {
            const book = books.find(b => b.path === s.path);
            const existing = book?.tags || [];
            const merged = [...existing];
            for (const t of finalTags) {
                if (!merged.some(x => x.toLowerCase() === t.toLowerCase())) merged.push(t);
            }
            await api.updateBook(s.path, book?.file_name || s.file_name, merged, newLong, newShort);
            s.applied = true;
            appliedCount++;
            if (row) markRowSaved(row);
            return true;
        } catch (err) {
            console.error("Apply error:", s.path, err);
            return false;
        }
    }

    // Đóng modal; nếu đã lưu gì thì refresh grid để thấy tags/description mới
    function closeModal() {
        overlay.remove();
        if (appliedCount > 0 && typeof onApplied === "function") onApplied();
    }

    // Apply
    applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        applyBtn.innerText = "Applying...";

        const books = await api.getBooks();
        for (const s of allSuggestions) {
            await applySuggestion(s, books);
        }
        closeModal();
    };

    cancelBtn.onclick = closeModal;
    headerCloseBtn.onclick = closeModal;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
}

// Đánh dấu row đã lưu: badge "Saved" + khóa các ô sửa
function markRowSaved(row) {
    if (row.querySelector(".ai-saved-badge")) return;
    const badge = document.createElement("div");
    badge.className = "ai-saved-badge";
    badge.style.cssText = "font-size:11px; font-weight:600; color:var(--success);";
    badge.innerText = "✓ Saved";
    row.insertBefore(badge, row.children[1] || null);
    row.querySelectorAll("input, textarea, button").forEach(el => { el.disabled = true; });
}

// =============================================
// SUGGESTION ROW
// =============================================
function renderSuggestionRow(suggestion, book) {
    const row = document.createElement("div");
    row.dataset.path = suggestion.path;
    row.style.cssText = "border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:var(--panel-soft); display:flex; flex-direction:column; gap:6px;";

    const nameEl = document.createElement("div");
    nameEl.style.cssText = "font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    nameEl.innerText = suggestion.file_name;
    nameEl.title = suggestion.file_name;

    if (suggestion.error) {
        const errEl = document.createElement("div");
        errEl.style.cssText = "font-size:11px; color:var(--danger);";
        errEl.innerText = "Error: " + suggestion.error;
        row.appendChild(nameEl);
        row.appendChild(errEl);
        return row;
    }

    const tagsWrap = document.createElement("div");
    tagsWrap.style.cssText = "display:flex; flex-wrap:wrap; gap:6px; align-items:center;";
    let currentTags = [...suggestion.suggested_tags];

    function renderChips() {
        tagsWrap.innerHTML = "";
        currentTags.forEach((tag, i) => {
            const chip = document.createElement("span");
            chip.style.cssText = "display:inline-flex; align-items:center; gap:4px; background:var(--primary-soft); border:1px solid var(--primary); color:var(--primary); border-radius:999px; padding:3px 8px; font-size:11px;";
            const t = document.createElement("span"); t.className = "tag-chip-text"; t.innerText = tag;
            const x = document.createElement("button");
            x.innerText = "x"; x.style.cssText = "border:none; background:transparent; color:var(--primary); cursor:pointer; font-size:11px; padding:0;";
            x.onclick = () => { currentTags.splice(i, 1); renderChips(); };
            chip.appendChild(t); chip.appendChild(x);
            tagsWrap.appendChild(chip);
        });
    }
    renderChips();
    row.appendChild(nameEl);
    if (currentTags.length > 0) row.appendChild(tagsWrap);

    // Descriptions: editable trước khi Apply
    function addTextField(labelText, value, current, className, multiline) {
        const label = document.createElement("div");
        label.style.cssText = "font-size:11px; font-weight:600; color:var(--text-secondary); margin-top:2px;";
        label.innerText = current ? `${labelText} (replaces the current one)` : labelText;
        const field = document.createElement(multiline ? "textarea" : "input");
        field.className = className;
        field.value = value;
        if (multiline) field.rows = 4;
        field.style.cssText = "width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border); border-radius:6px; font-size:12px; font-family:inherit; background:var(--panel); color:var(--text); resize:vertical;";
        field.title = current ? `Current: ${current}` : "";
        // Ctrl+A chọn text trong ô thay vì "select all books"
        field.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") e.stopPropagation();
        });
        row.appendChild(label);
        row.appendChild(field);
    }
    if (suggestion.short_description != null) {
        addTextField("Short description", suggestion.short_description, book?.short_description, "ai-short-description", false);
    }
    if (suggestion.description != null) {
        addTextField("Long description", suggestion.description, book?.description, "ai-description", true);
    }
    return row;
}

// =============================================
// UI HELPERS
// =============================================
function makeLabel(text) {
    const el = document.createElement("div");
    el.style.cssText = "font-size:13px; font-weight:600; color:var(--text);";
    el.innerText = text;
    return el;
}

function makeInput(type, value, placeholder) {
    const el = document.createElement("input");
    el.type = type; el.value = value; el.placeholder = placeholder;
    el.style.cssText = "width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; outline:none; box-sizing:border-box; background:var(--panel); color:var(--text);";
    return el;
}

function makeSelect(options, selected) {
    const el = document.createElement("select");
    el.style.cssText = "width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; outline:none; background:var(--panel); color:var(--text);";
    options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value; o.innerText = opt.label;
        if (opt.value === selected) o.selected = true;
        el.appendChild(o);
    });
    return el;
}

function makeBtn(label, primary, onclick) {
    const el = document.createElement("button");
    el.innerText = label;
    el.style.cssText = primary
        ? "border:1px solid var(--primary); background:var(--primary); color:white; border-radius:8px; padding:9px 16px; cursor:pointer; font-weight:600;"
        : "border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; padding:9px 14px; cursor:pointer;";
    if (onclick) el.onclick = onclick;
    return el;
}

function makeCloseBtn(onclick) {
    const el = document.createElement("button");
    el.innerText = "x";
    el.style.cssText = "border:none; background:var(--hover); color:var(--text); width:34px; height:34px; border-radius:999px; cursor:pointer; font-size:14px;";
    el.onclick = onclick;
    return el;
}

function makeDivider() {
    const el = document.createElement("hr");
    el.style.cssText = "border:none; border-top:1px solid var(--border); margin:4px 0;";
    return el;
}