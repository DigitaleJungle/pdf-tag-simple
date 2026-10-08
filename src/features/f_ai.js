import { api } from "./api.js";
import { el, label, hint, input, textarea, select, button, checkbox, divider, openModal, setStatus, isInFolder } from "./ui.js";
import { createTagEditor } from "./ui_grid_menu.js";

// =============================================
// f_ai.js — AI Auto-Tag feature
//
// Export:
//   renderAiSettingsSection(container, ctx) — render các field AI settings vào container
//                                             (panel "AI Settings" của Settings modal)
//   openAiAutoTag(books, selectedBooks, currentFilterPath, onApplied)
//                                  — mở modal auto-tag với scope selection
// =============================================

// Cost estimate cho OpenAI gpt-4o-mini
// filename only: ~50 tokens/book
// thumbnail: ~500 tokens/book (image low detail ~85 tokens + text)
const TOKENS_PER_BOOK_TEXT = 50;
const TOKENS_PER_BOOK_IMAGE = 500;
const COST_PER_1K_INPUT = 0.00015; // gpt-4o-mini input price

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
const inputModeLabel = (value) => (INPUT_MODE_OPTIONS.find(o => o.value === value)?.label || value).replace(/ \(.*\)$/, "");

// Select input mode + dòng hint bên dưới, tự cập nhật khi đổi
function makeInputModePicker(selected) {
    const picker = select(INPUT_MODE_OPTIONS, selected);
    const pickerHint = hint("");
    function updateHint() {
        const text = INPUT_MODE_HINTS[picker.value] || "";
        pickerHint.innerText = text;
        pickerHint.hidden = !text;
    }
    picker.addEventListener("change", updateHint);
    updateHint();
    return { select: picker, hint: pickerHint };
}

function estimateCost(bookCount, inputMode) {
    const tokensPerBook = inputMode === "thumbnail" ? TOKENS_PER_BOOK_IMAGE : TOKENS_PER_BOOK_TEXT;
    const totalTokens = bookCount * tokensPerBook;
    return { totalTokens, cost: ((totalTokens / 1000) * COST_PER_1K_INPUT).toFixed(4) };
}

// Ô <select> nạp lại danh sách option (model list...)
function fillOptions(selectEl, options) {
    selectEl.innerHTML = "";
    options.forEach(({ value, label: text, selected }) => {
        const o = el("option", "", text);
        o.value = value;
        o.selected = !!selected;
        selectEl.appendChild(o);
    });
}

function section() {
    const node = el("div");
    node.style.cssText = "display:flex; flex-direction:column; gap:10px;";
    return node;
}

// =============================================
// AI SETTINGS SECTION (rendered inside the Settings modal)
// =============================================
export async function renderAiSettingsSection(container, ctx) {
    const loading = el("div", "status", "Loading...");
    container.appendChild(loading);
    let settings;
    try {
        settings = await api.getAiSettings();
    } catch (err) {
        loading.innerText = "Could not load AI settings: " + err;
        return;
    }
    loading.remove();

    // --- Activate AI ---
    const enabledRow = el("label");
    enabledRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; cursor:pointer;";
    const enabledCheckbox = el("input", "switch");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = settings.enabled !== false;
    enabledRow.append(label("Activate AI"), enabledCheckbox);
    container.appendChild(enabledRow);

    // Body — tất cả các field còn lại, ẩn hết khi AI bị tắt
    const body = el("div");
    body.style.cssText = "display:flex; flex-direction:column; gap:14px;";
    body.hidden = !enabledCheckbox.checked;
    container.appendChild(body);

    enabledCheckbox.addEventListener("change", async () => {
        body.hidden = !enabledCheckbox.checked;
        ctx.onAiEnabledChange(enabledCheckbox.checked);
        try {
            await api.saveAiSettings(gatherSettings());
        } catch (err) {
            console.error("Error saving AI enabled state:", err);
        }
    });

    // Provider
    const providerSelect = select([
        { value: "openai", label: "OpenAI (API key)" },
        { value: "gemini", label: "Gemini (API key)" },
        { value: "gemini_free", label: "Gemini (free tier)" },
        { value: "chatgpt", label: "ChatGPT (sign in with your plan) (beta)" },
        { value: "ollama", label: "Ollama (local)" },
    ], settings.provider);
    body.append(label("Provider"), providerSelect);

    // OpenAI section
    const openaiSection = section();
    const apiKeyInput = input("password", settings.openai_api_key, "sk-...");
    const openaiModelSelect = select([
        { value: "gpt-4o-mini", label: "gpt-4o-mini (fast, cheap)" },
        { value: "gpt-4o", label: "gpt-4o (more accurate)" },
    ], settings.openai_model);
    openaiSection.append(label("OpenAI API Key"), apiKeyInput, label("OpenAI Model"), openaiModelSelect);

    // Gemini section — dùng chung cho "gemini" và "gemini_free"
    const geminiSection = section();
    const geminiKeyInput = input("password", settings.gemini_api_key, "AIza...");
    const geminiModelRow = el("div");
    geminiModelRow.style.cssText = "display:flex; gap:8px; align-items:center;";
    const geminiModelSelect = select([], "");
    geminiModelSelect.style.flex = "1";
    const geminiLoadBtn = button("Load models", "small");
    geminiModelRow.append(geminiModelSelect, geminiLoadBtn);
    const geminiStatus = el("div", "status");
    const geminiFreeNote = el("div", "hint");
    geminiFreeNote.style.cssText = "line-height:1.45; background:var(--panel-soft); border:1px solid var(--border); border-radius:8px; padding:8px 10px;";
    geminiFreeNote.innerHTML = `
        <div><b>Rate limit:</b> ~10 requests/minute and ~1,000/day. The app waits ~6 s between books (100 books ≈ 10 min). No Pro models.</div>
        <div style="margin-top:6px;"><b>Privacy:</b> Google may use what you send (filenames, images, text) to improve its products, and people may review it. Avoid sensitive files.</div>`;
    geminiSection.append(
        label("Gemini API Key"), geminiKeyInput,
        label("Gemini Model"), geminiModelRow, geminiStatus,
        hint("Get a key at aistudio.google.com. Free or paid depends on billing for the key's Google Cloud project."),
        geminiFreeNote,
    );

    let geminiModels = null; // null = not loaded yet

    function renderGeminiModels() {
        const isFree = providerSelect.value === "gemini_free";
        const saved = geminiModelSelect.value || settings.gemini_model || "";
        // Pro models aren't available on the free tier
        const list = (geminiModels || []).filter(m => !isFree || !m.id.includes("-pro"));
        if (saved && geminiModels === null && !list.some(m => m.id === saved)) {
            list.unshift({ id: saved, display_name: saved });
        }
        if (list.length === 0) {
            fillOptions(geminiModelSelect, [{ value: "", label: geminiModels === null ? "Click \"Load models\"" : "No models available for this key" }]);
            return;
        }
        // Default: a Flash model that answered normally, when nothing is chosen yet
        const fallback = list.find(m => m.id.includes("flash") && !m.note) || list.find(m => !m.note) || list[0];
        const selected = list.some(m => m.id === saved) ? saved : fallback.id;
        fillOptions(geminiModelSelect, list.map(m => {
            const text = m.display_name && m.display_name !== m.id ? `${m.display_name} (${m.id})` : m.id;
            return { value: m.id, label: m.note ? `${text} — ${m.note}` : text, selected: m.id === selected };
        }));
    }

    async function loadGeminiModels() {
        setStatus(geminiStatus, "Checking which models work with this key...");
        geminiLoadBtn.disabled = true;
        try {
            geminiModels = await api.geminiModels(geminiKeyInput.value.trim());
            setStatus(geminiStatus, "");
        } catch (err) {
            setStatus(geminiStatus, String(err), "error");
        } finally {
            geminiLoadBtn.disabled = false;
            renderGeminiModels();
        }
    }

    geminiLoadBtn.onclick = loadGeminiModels;
    geminiKeyInput.addEventListener("change", () => { if (geminiKeyInput.value.trim()) loadGeminiModels(); });
    renderGeminiModels();

    // ChatGPT (sign in) section
    const chatgptSection = section();
    const chatgptStatusRow = el("div");
    chatgptStatusRow.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";
    const chatgptStatus = el("span", "status");
    chatgptStatus.style.cssText = "flex:1; min-width:150px;";
    const chatgptSignInBtn = button("", "small");
    chatgptStatusRow.append(chatgptStatus, chatgptSignInBtn);
    const chatgptModelLabel = label("ChatGPT Model");
    const chatgptModelSelect = select([], "");
    chatgptSection.append(
        label("ChatGPT Account"), chatgptStatusRow, chatgptModelLabel, chatgptModelSelect,
        hint("Signs in via your browser and uses your ChatGPT plan's limits. No API key needed."),
    );

    let chatgptState = "signed-out"; // "signed-out" | "waiting" | "signed-in"

    function renderChatgptState(email = "") {
        const signedIn = chatgptState === "signed-in";
        setStatus(chatgptStatus, signedIn
            ? `Signed in${email ? " as " + email : ""}`
            : chatgptState === "waiting" ? "Waiting for sign-in in your browser..." : "Not signed in",
            signedIn ? "ok" : "");
        chatgptSignInBtn.innerText = signedIn ? "Sign out" : chatgptState === "waiting" ? "Cancel" : "Sign in with ChatGPT";
        chatgptModelLabel.hidden = !signedIn;
        chatgptModelSelect.hidden = !signedIn;
    }

    async function loadChatgptModels() {
        fillOptions(chatgptModelSelect, [{ value: "", label: "Loading models..." }]);
        const saved = settings.chatgpt_model;
        try {
            const models = await api.chatgptModels();
            if (saved && !models.some(m => m.slug === saved)) models.unshift({ slug: saved, display_name: saved });
            fillOptions(chatgptModelSelect, models.length
                ? models.map(m => ({ value: m.slug, label: m.display_name || m.slug, selected: m.slug === saved }))
                : [{ value: "", label: "No models available for this account" }]);
        } catch (err) {
            fillOptions(chatgptModelSelect, [{ value: saved || "", label: saved || "Could not load models" }]);
            setStatus(chatgptStatus, String(err), "error");
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
            setStatus(chatgptStatus, String(err), "error");
        }
    };

    try {
        const status = await api.chatgptStatus();
        chatgptState = status.signed_in ? "signed-in" : "signed-out";
        renderChatgptState(status.email);
        if (status.signed_in) loadChatgptModels();
    } catch {
        renderChatgptState();
    }

    // Ollama section
    const ollamaSection = section();
    const ollamaHostInput = input("text", settings.ollama_host, "http://localhost:11434");
    const ollamaStatusRow = el("div");
    ollamaStatusRow.style.cssText = "display:flex; gap:8px; align-items:center;";
    const ollamaStatus = el("span", "status", "Not checked");
    const checkBtn = button("Check connection", "small", async () => {
        setStatus(ollamaStatus, "Checking...");
        const ok = await api.checkOllama(ollamaHostInput.value);
        setStatus(ollamaStatus, ok ? "Connected" : "Not reachable", ok ? "ok" : "error");
    });
    ollamaStatusRow.append(checkBtn, ollamaStatus);
    const ollamaModelInput = input("text", settings.ollama_model, "llama3.2");
    ollamaSection.append(
        label("Ollama Host"), ollamaHostInput, ollamaStatusRow,
        label("Ollama Model"), ollamaModelInput,
        hint("For image methods, use a vision model (llava, llama3.2-vision)."),
    );

    body.append(openaiSection, geminiSection, chatgptSection, ollamaSection);

    function updateProviderSections() {
        const provider = providerSelect.value;
        const isGemini = provider === "gemini" || provider === "gemini_free";
        openaiSection.hidden = provider !== "openai";
        geminiSection.hidden = !isGemini;
        geminiFreeNote.hidden = provider !== "gemini_free";
        chatgptSection.hidden = provider !== "chatgpt";
        ollamaSection.hidden = provider !== "ollama";
        if (isGemini) {
            if (geminiModels === null && geminiKeyInput.value.trim()) loadGeminiModels();
            else renderGeminiModels();
        }
    }
    providerSelect.addEventListener("change", updateProviderSections);
    updateProviderSections();

    // Input mode
    const { select: inputModeSelect, hint: inputModeHint } = makeInputModePicker(settings.input_mode);
    body.append(divider(), label("AI Method (default)"), inputModeSelect, inputModeHint);

    // Tag language
    const langSelect = select([
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
    body.append(divider(), label("Tag Language"), langSelect);

    // Skip threshold
    const skipInput = input("number", String(settings.skip_if_tags_gte), "5");
    skipInput.style.width = "80px";
    body.append(divider(), label("Skip books with tags ≥"), skipInput, hint("Books with this many tags are skipped for tagging."));

    // Max tags per book
    const maxTagsInput = input("number", String(settings.max_tags ?? 5), "5");
    maxTagsInput.min = "1";
    maxTagsInput.max = "20";
    maxTagsInput.style.width = "80px";
    body.append(divider(), label("Max tags per book"), maxTagsInput, hint("Maximum tags the AI suggests per book."));

    // Tag vocabulary
    const vocabTags = [...(settings.tag_vocabulary || [])];
    const vocabEditor = createTagEditor(vocabTags, { placeholder: "Add tag and press Enter..." });
    body.append(
        divider(), label("Tag Vocabulary (optional)"),
        hint("Preferred tags the AI uses when they fit. Leave empty for free tagging."),
        vocabEditor.wrap,
    );

    // Saved prompts — chọn được trong cửa sổ AI auto làm "Extra instructions"
    body.append(
        divider(), label("Saved prompts (optional)"),
        hint("Instructions you can pick in the AI auto window. Click Save Settings to keep changes."),
    );

    const savedPrompts = (settings.saved_prompts || []).map(p => ({ name: p.name, text: p.text }));
    let editingIndex = -1; // -1 = đang thêm prompt mới

    const promptList = el("div");
    promptList.style.cssText = "display:flex; flex-direction:column; gap:6px;";

    const promptForm = el("div");
    promptForm.style.cssText = "display:flex; flex-direction:column; gap:6px; border:1px solid var(--border); border-radius:10px; padding:10px; background:var(--panel);";
    const promptNameInput = input("text", "", "Prompt name");
    const promptTextInput = textarea("", "Instructions for the AI...", 3);
    const promptFormButtons = el("div");
    promptFormButtons.style.cssText = "display:flex; gap:8px; align-items:center;";
    const promptSaveBtn = button("Add prompt");
    const promptCancelBtn = button("Cancel");
    const promptFormStatus = el("span", "status error");
    promptFormButtons.append(promptSaveBtn, promptCancelBtn, promptFormStatus);
    promptForm.append(promptNameInput, promptTextInput, promptFormButtons);
    body.append(promptList, promptForm);

    function resetPromptForm() {
        editingIndex = -1;
        promptNameInput.value = "";
        promptTextInput.value = "";
        promptSaveBtn.innerText = "Add prompt";
        promptCancelBtn.hidden = true;
        promptFormStatus.innerText = "";
    }

    function renderPromptList() {
        promptList.innerHTML = "";
        savedPrompts.forEach((p, i) => {
            const item = el("div");
            item.style.cssText = "display:flex; align-items:flex-start; gap:8px; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--panel-soft);";
            const textWrap = el("div");
            textWrap.style.cssText = "flex:1; min-width:0;";
            const name = label(p.name);
            const preview = el("div", "hint", p.text);
            preview.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
            preview.title = p.text;
            textWrap.append(name, preview);
            const editBtn = button("Edit", "small", () => {
                editingIndex = i;
                promptNameInput.value = p.name;
                promptTextInput.value = p.text;
                promptSaveBtn.innerText = "Update prompt";
                promptCancelBtn.hidden = false;
                promptFormStatus.innerText = "";
                promptNameInput.focus();
            });
            const deleteBtn = button("Delete", "small", () => {
                savedPrompts.splice(i, 1);
                if (editingIndex === i) resetPromptForm();
                else if (editingIndex > i) editingIndex--;
                renderPromptList();
            });
            item.append(textWrap, editBtn, deleteBtn);
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
        vocabEditor.flush();
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
    const footer = el("div");
    footer.style.cssText = "display:flex; align-items:center; gap:10px; margin-top:4px;";
    const saveStatus = el("span", "status");
    const saveBtn = button("Save Settings", "primary", async () => {
        try {
            await api.saveAiSettings(gatherSettings());
            setStatus(saveStatus, "Saved.", "ok");
        } catch (err) {
            setStatus(saveStatus, "Error saving settings: " + err, "error");
        }
    });
    footer.append(saveBtn, saveStatus);
    body.appendChild(footer);
}

// localStorage chỉ là tiện ích — lỗi storage thì dùng mặc định
function loadPref(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        return value ?? fallback;
    } catch {
        return fallback;
    }
}
function savePref(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// =============================================
// AI AUTO-TAG MODAL
//
// Params:
//   allBooks          — state.books filter !hidden
//   selectedBooks     — Set<path> từ main.js
//   currentFilterPath — folder đang chọn (null = All Documents)
//   onApplied         — callback sau khi apply xong
//   onRetry           — callback(paths) để chạy lại AI cho các sách bị lỗi
// =============================================
export async function openAiAutoTag(allBooks, selectedBooks, currentFilterPath, onApplied, onRetry) {
    const settings = await api.getAiSettings().catch(() => null);
    if (!settings) { alert("Could not load AI settings."); return; }
    // Thiếu key / model được backend báo khi bấm Start; chỉ ChatGPT cần kiểm tra trước
    // vì phải sign in trong Settings.
    if (settings.provider === "chatgpt") {
        const status = await api.chatgptStatus().catch(() => ({ signed_in: false }));
        if (!status.signed_in) {
            alert("Not signed in to ChatGPT. Please sign in under Settings > AI Settings.");
            return;
        }
    }

    // Số sách xử lý song song. Gemini free tier phải tuần tự (backend giãn request ~6.5s),
    // Ollama chạy trên máy user nên song song chỉ tranh nhau tài nguyên.
    const CONCURRENCY = (settings.provider === "gemini_free" || settings.provider === "ollama") ? 1 : 4;

    // Scope options
    const selectedArr = [...selectedBooks];
    const folderBooks = currentFilterPath ? allBooks.filter(b => isInFolder(b.path, currentFilterPath)) : [];
    const scopeBooks = () => {
        if (scopeSelect.value === "selected") return allBooks.filter(b => selectedArr.includes(b.path));
        if (scopeSelect.value === "folder") return folderBooks;
        return allBooks;
    };

    const body = el("div", "modal-body");

    // --- Options --- (thu gọn thành 1 dòng tóm tắt khi bấm Start)
    const optionsWrap = el("div");
    optionsWrap.style.cssText = "display:flex; flex-direction:column; gap:12px;";
    body.appendChild(optionsWrap);

    const scopeOptions = [{ value: "all", label: `All books (${allBooks.length})` }];
    if (folderBooks.length > 0) scopeOptions.push({ value: "folder", label: `Current folder (${folderBooks.length})` });
    if (selectedArr.length > 0) scopeOptions.push({ value: "selected", label: `Selected books (${selectedArr.length})` });
    const scopeSelect = select(scopeOptions, selectedArr.length > 0 ? "selected" : "all");
    optionsWrap.append(label("Books"), scopeSelect);

    // --- What to fill in --- (nhớ lại giữa các lần mở)
    const fill = { tags: true, name: false, short_description: false, description: false, ...loadPref("aiFillOptions", {}) };
    const fillBlock = el("div");
    fillBlock.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px;";
    fillBlock.appendChild(label("Fill in"));
    const fillCheckboxes = [
        ["tags", "Tags"],
        ["name", "Name"],
        ["short_description", "Short description"],
        ["description", "Long description"],
    ].map(([key, text]) => {
        const { row, box } = checkbox(text, fill[key]);
        box.addEventListener("change", () => {
            fill[key] = box.checked;
            savePref("aiFillOptions", fill);
            updateCostEstimate();
            if (key === "tags") { updateVocabEnabled(); updateMoreSummary(); }
        });
        fillBlock.appendChild(row);
        return box;
    });

    // Lưu ngay từng kết quả khi về, không cần review/Apply all (nhớ lại giữa các lần mở)
    const immediate = checkbox("Apply results immediately", loadPref("aiApplyImmediately", false) === true);
    immediate.box.addEventListener("change", () => savePref("aiApplyImmediately", immediate.box.checked));

    // "Advanced": các lựa chọn ít dùng + giải thích, đóng mặc định (nhớ trạng thái)
    const moreDetails = el("details");
    moreDetails.style.cssText = "border:1px solid var(--border); border-radius:8px; padding:8px 12px; background:var(--panel-soft);";
    moreDetails.open = loadPref("aiMoreOptionsOpen", false) === true;
    moreDetails.addEventListener("toggle", () => savePref("aiMoreOptionsOpen", moreDetails.open));
    const moreSummary = el("summary", "label", "Advanced");
    moreSummary.style.cssText = "cursor:pointer; user-select:none;";
    const moreBody = el("div");
    moreBody.style.cssText = "display:flex; flex-direction:column; gap:10px; margin-top:10px;";
    moreDetails.append(moreSummary, moreBody);
    optionsWrap.append(fillBlock, immediate.row, moreDetails);

    // --- Input cho lần chạy này --- (mặc định theo AI Settings, không lưu lại)
    const { select: runInputSelect, hint: runInputHint } = makeInputModePicker(settings.input_mode || "filename");
    // Giải thích dạng tooltip trên select; cũng hiện ở cuối "Advanced"
    const updateInputTooltip = () => { runInputSelect.title = INPUT_MODE_HINTS[runInputSelect.value] || ""; };
    runInputSelect.addEventListener("change", () => { updateInputTooltip(); updateCostEstimate(); updateMoreSummary(); });
    updateInputTooltip();

    // --- Extra instructions ---
    // Chọn prompt soạn sẵn rồi sửa cho lần chạy này, tự gõ, hoặc để trống.
    // "Save prompt" lưu lại vào AI Settings: tên trùng prompt có sẵn → cập nhật, tên mới → thêm mới.
    const savedPrompts = settings.saved_prompts || [];
    const promptSelect = select([], "");
    function renderPromptOptions(selectedIndex = -1) {
        fillOptions(promptSelect, [
            { value: "", label: savedPrompts.length > 0 ? "- select -" : "- no saved prompts yet -" },
            ...savedPrompts.map((p, i) => ({ value: String(i), label: p.name, selected: i === selectedIndex })),
        ]);
    }
    renderPromptOptions();
    const promptText = textarea("", "Leave empty to send no extra instructions.", 3);
    const pickedPrompt = () => savedPrompts[parseInt(promptSelect.value)];

    const promptSaveRow = el("div");
    promptSaveRow.style.cssText = "display:flex; gap:8px; align-items:center;";
    const promptNameInput = input("text", "", "Prompt name");
    promptNameInput.style.flex = "1";
    const promptSaveBtn = button("Save prompt", "small");
    const promptSaveStatus = el("span", "status");
    promptSaveRow.append(promptNameInput, promptSaveBtn, promptSaveStatus);

    const findPrompt = (name) => savedPrompts.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    function updatePromptSaveBtn() {
        const name = promptNameInput.value.trim();
        const text = promptText.value.trim();
        const existing = savedPrompts[findPrompt(name)];
        promptSaveBtn.innerText = existing ? "Update prompt" : "Save as new prompt";
        promptSaveBtn.disabled = !name || !text || (existing && existing.text.trim() === text);
    }

    promptSaveBtn.onclick = async () => {
        const name = promptNameInput.value.trim();
        const text = promptText.value.trim();
        promptSaveBtn.disabled = true;
        try {
            // Đọc lại settings mới nhất để không ghi đè thay đổi từ cửa sổ Settings
            const fresh = await api.getAiSettings();
            const prompts = fresh.saved_prompts || [];
            const index = prompts.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
            if (index >= 0) prompts[index] = { name: prompts[index].name, text };
            else prompts.push({ name, text });
            await api.saveAiSettings({ ...fresh, saved_prompts: prompts });
            savedPrompts.splice(0, savedPrompts.length, ...prompts);
            renderPromptOptions(findPrompt(name));
            promptNameInput.value = pickedPrompt()?.name || name;
            setStatus(promptSaveStatus, index >= 0 ? "Updated." : "Saved.", "ok");
        } catch (err) {
            setStatus(promptSaveStatus, "Error: " + err, "error");
        }
        updatePromptSaveBtn();
        updateMoreSummary();
    };

    promptSelect.addEventListener("change", () => {
        promptText.value = pickedPrompt()?.text || "";
        promptNameInput.value = pickedPrompt()?.name || "";
        updatePromptSaveBtn();
        updateMoreSummary();
    });
    promptText.addEventListener("input", () => { updatePromptSaveBtn(); updateMoreSummary(); });
    promptNameInput.addEventListener("input", () => { promptSaveStatus.innerText = ""; updatePromptSaveBtn(); });

    // Nhớ prompt dùng lần trước (lưu khi bấm Start). Lưu theo tên prompt, không theo index,
    // vì danh sách saved prompts có thể đã đổi.
    const last = loadPref("aiLastPrompt", null);
    if (last && typeof last.text === "string") {
        const index = savedPrompts.findIndex(p => p.name === last.name);
        if (index !== -1) promptSelect.value = String(index);
        promptText.value = last.text;
    }
    promptNameInput.value = pickedPrompt()?.name || "";
    updatePromptSaveBtn();

    // --- Tag vocabulary cho lần chạy này --- (mặc định theo AI Settings, không lưu lại)
    // <fieldset disabled> làm mờ + khóa cả ô nhập lẫn nút x khi không chọn "Tags"
    const settingsVocab = settings.tag_vocabulary || [];
    const runVocab = [...settingsVocab];
    const vocabChanged = () => runVocab.length !== settingsVocab.length || runVocab.some((t, i) => t !== settingsVocab[i]);
    const vocabEditor = createTagEditor(runVocab, { placeholder: "Add tag and press Enter...", onChange: () => updateMoreSummary() });
    const vocabResetBtn = button("Reset to AI Settings", "small", () => {
        runVocab.splice(0, runVocab.length, ...settingsVocab);
        vocabEditor.render();
    });
    const vocabBlock = el("fieldset", "plain-fieldset");
    vocabBlock.append(
        label("Tag vocabulary (optional)"), vocabEditor.wrap,
        hint("Preferred tags for this run, from AI Settings. Changes here aren't saved. Leave empty for free tagging."),
        vocabResetBtn,
    );
    vocabResetBtn.style.alignSelf = "flex-start";
    const updateVocabEnabled = () => { vocabBlock.disabled = !fill.tags; };
    updateVocabEnabled();

    // Giải thích, gom ở cuối "Advanced"
    const helpBlock = el("div");
    helpBlock.style.cssText = "display:flex; flex-direction:column; gap:4px; border-top:1px solid var(--border); padding-top:8px;";
    helpBlock.append(
        hint("Names and descriptions replace the current ones (editable before applying). Best with PDF text, pages or PDF file."),
        runInputHint,
    );
    moreBody.append(
        label("AI Method"), runInputSelect,
        label("Extra instructions (optional)"), promptSelect, promptText, promptSaveRow,
        hint("Your last instructions are remembered. Save them under a prompt name to reuse them; same name = update. Delete prompts in AI Settings."),
        vocabBlock,
        helpBlock,
    );

    // Tiêu đề "Advanced" cho biết đang chọn gì, để không có gì bị ẩn mà không biết
    function updateMoreSummary() {
        const active = [`method: ${inputModeLabel(runInputSelect.value)}`];
        const instructions = promptText.value.trim();
        if (instructions) {
            const picked = pickedPrompt();
            active.push(`instructions: ${picked && picked.text.trim() === instructions ? picked.name : "custom"}`);
        }
        if (fill.tags && vocabChanged()) active.push("vocabulary: custom");
        moreSummary.innerText = `Advanced · ${active.join(" · ")}`;
    }
    updateMoreSummary();

    // Tóm tắt 1 dòng thay cho optionsWrap khi đang chạy / review
    const runSummary = el("div", "status");
    runSummary.style.cssText = "background:var(--panel-soft); border:1px solid var(--border); border-radius:8px; padding:8px 12px;";
    runSummary.hidden = true;
    body.appendChild(runSummary);

    // Sách cần xử lý: thiếu tags (khi chọn Tags) hoặc có chọn description
    const needsWork = (b) => (fill.tags && (b.tags?.length || 0) < settings.skip_if_tags_gte)
        || fill.name || fill.short_description || fill.description;

    // --- Cost estimate ---
    // Ẩn khi dùng Ollama (free), ChatGPT (tính vào plan) hoặc Gemini trả phí (giá tùy model)
    const costBox = el("div", "status");
    costBox.hidden = ["ollama", "chatgpt", "gemini"].includes(settings.provider);

    function updateCostEstimate() {
        if (costBox.hidden) return;
        const eligible = scopeBooks().filter(needsWork).length;
        const mode = runInputSelect.value;

        // Gemini free tier: no cost, but time (~6.5 s per book) and a daily limit
        if (settings.provider === "gemini_free") {
            const minutes = Math.ceil((eligible * 6.5) / 60);
            costBox.innerHTML = `<b>Gemini free tier:</b> ~${eligible} books · about ${minutes} min (~6 s per book${mode === "pages" ? ", plus page rendering" : ""})` +
                (eligible > 1000 ? "<br>⚠️ Over the ~1,000 requests/day free limit — the run stops when it's reached." : "");
            return;
        }
        const { totalTokens, cost } = estimateCost(eligible, mode);
        let costText = `~${eligible} books · ~${totalTokens.toLocaleString()} tokens · Est. cost: $${cost}`;
        if (fill.name || fill.short_description || fill.description) costText += " + names/descriptions";
        if (mode === "thumbnail") {
            costText += " ⚠️ Thumbnail mode costs more";
        } else if (mode === "pages" || mode === "pdf") {
            // Số trang chưa biết trước — mỗi trang tốn gần bằng 1 ảnh bìa
            costText = `~${eligible} books · cost depends on page count`;
        } else if (mode === "text") {
            // Độ dài text chưa biết trước — tối đa ~25k tokens mỗi sách
            costText = `~${eligible} books · cost depends on text length (max ~25k tokens/book)`;
        }
        costBox.innerHTML = `<b>Estimate:</b> ${costText}`;
        costBox.title = `Provider: ${settings.provider} · Input: ${mode} · Language: ${settings.tag_language || "auto"} · Skip ≥${settings.skip_if_tags_gte} tags`;
    }
    scopeSelect.addEventListener("change", updateCostEstimate);
    updateCostEstimate();

    // --- Progress + results ---
    const statusText = el("div", "status", "Click Start to begin.");
    statusText.style.fontSize = "13px";
    const progress = el("progress");
    progress.hidden = true;
    const resultsWrap = el("div");
    resultsWrap.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    // Sách bị lỗi: chạy lại, hoặc gắn tag để tìm lại sau — hiện khi lượt chạy xong
    const failedBox = el("div");
    failedBox.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; align-items:center;";
    failedBox.hidden = true;
    body.append(costBox, statusText, progress, failedBox, resultsWrap);

    // Footer
    const footer = el("div");
    const footerLeft = el("div", "spacer");
    const startBtn = button("Start", "primary");
    const applyBtn = button("Apply all", "success");
    applyBtn.hidden = true;

    let appliedCount = 0;
    const results = []; // { suggestion, values() } — theo thứ tự kết quả về

    const { close } = openModal({
        title: "AI Auto-Tag",
        width: 700,
        body,
        footer,
        // Nếu đã lưu gì thì refresh grid để thấy tags/description mới
        onClose: () => {
            vocabEditor.destroy();
            if (appliedCount > 0) onApplied();
        },
    });
    const cancelBtn = button("Cancel", "", close);
    footer.append(footerLeft, cancelBtn, startBtn, applyBtn);

    // Start
    startBtn.onclick = async () => {
        if (!fill.tags && !fill.name && !fill.short_description && !fill.description) {
            statusText.innerText = "Choose at least one thing for the AI to fill in.";
            return;
        }
        if (settings.provider === "ollama" && runInputSelect.value === "pdf") {
            statusText.innerText = "Ollama can't read PDF files. Choose \"Filename + PDF text\" instead.";
            return;
        }
        const eligible = scopeBooks().filter(needsWork);
        if (eligible.length === 0) {
            statusText.innerText = "No books to process (all have enough tags already).";
            return;
        }

        vocabEditor.flush();
        [startBtn, scopeSelect, ...fillCheckboxes, immediate.box, promptSelect, promptText, promptNameInput, promptSaveBtn, runInputSelect, vocabBlock]
            .forEach(c => { c.disabled = true; });
        const saveAsTheyArrive = immediate.box.checked;
        const runOptions = {
            ...fill, extra_prompt: promptText.value.trim(), input_mode: runInputSelect.value,
            tag_vocabulary: [...runVocab],
        };

        // Thu gọn lựa chọn thành 1 dòng để kết quả có chỗ
        const filled = [["tags", "Tags"], ["name", "Name"], ["short_description", "Short description"], ["description", "Long description"]]
            .filter(([key]) => runOptions[key]).map(([, text]) => text).join(", ");
        const summaryParts = [`${eligible.length} book${eligible.length === 1 ? "" : "s"}`, filled, inputModeLabel(runOptions.input_mode)];
        if (runOptions.extra_prompt) summaryParts.push("with extra instructions");
        if (fill.tags && vocabChanged()) summaryParts.push("custom vocabulary");
        if (saveAsTheyArrive) summaryParts.push("saving immediately");
        runSummary.innerText = summaryParts.join(" · ");
        runSummary.title = runOptions.extra_prompt ? `Extra instructions: ${runOptions.extra_prompt}` : "";
        optionsWrap.hidden = true;
        runSummary.hidden = false;
        const picked = pickedPrompt();
        savePref("aiLastPrompt", { name: picked ? picked.name : "", text: promptText.value });
        progress.hidden = false;

        const total = eligible.length;
        let processed = 0;
        let runError = null;
        const showProgress = () => {
            statusText.innerText = `Processing... ${processed}/${total} books`;
            progress.value = processed / total;
        };
        showProgress();

        // Gửi từng sách một (để progress bar cập nhật sau mỗi sách), CONCURRENCY sách cùng lúc.
        // Lỗi dừng cả lượt chạy (key sai, hết quota ngày, chưa sign in...) → các worker dừng nhận sách mới.
        let nextIndex = 0;
        async function worker() {
            while (!runError && nextIndex < eligible.length) {
                const b = eligible[nextIndex++];
                try {
                    const suggestion = await api.suggestTags({
                        path: b.path,
                        file_name: b.file_name,
                        thumbnail_path: b.thumbnail_path || "",
                        current_tags: b.tags || [],
                    }, runOptions);
                    const result = renderSuggestionRow(suggestion, b);
                    results.push(result);
                    resultsWrap.appendChild(result.row);
                    // Lấy danh sách mới nhất để merge với tags hiện có
                    if (saveAsTheyArrive && !suggestion.error) await applyResult(result, await api.getBooks());
                } catch (err) {
                    runError = runError || err;
                }
                processed++;
                showProgress();
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, worker));

        const doneCount = results.filter(r => !r.suggestion.error).length;
        // Lỗi riêng từng sách + sách chưa tới lượt khi lượt chạy bị dừng
        const returned = new Set(results.map(r => r.suggestion.path));
        const failedPaths = [
            ...results.filter(r => r.suggestion.error).map(r => r.suggestion.path),
            ...eligible.filter(b => !returned.has(b.path)).map(b => b.path),
        ];
        if (failedPaths.length > 0) showFailedActions(failedPaths, saveAsTheyArrive);
        if (runError) {
            setStatus(statusText, `Stopped: ${runError} (${doneCount}/${total} books done)`, "error");
        } else {
            statusText.innerText = `Done! ${doneCount}/${total} books processed.`;
        }
        progress.value = 1;
        startBtn.hidden = true;
        if (saveAsTheyArrive) {
            // Đã lưu từng sách khi kết quả về — không cần Apply all
            cancelBtn.innerText = "Close";
            footerLeft.innerText = `${appliedCount} book${appliedCount === 1 ? "" : "s"} saved as results arrived.`;
        } else {
            applyBtn.hidden = false;
            footerLeft.innerText = "Review the results above, then click Apply.";
        }
    };

    // Lưu kết quả của 1 sách (dùng cho "Apply all" và cho "Apply immediately").
    // books = danh sách mới nhất từ backend, để merge với tags hiện có.
    async function applyResult(result, books) {
        const { suggestion: s } = result;
        if (s.error || result.applied) return;
        const { tags, name, short, long } = result.values();
        // Chỉ lưu description khi được tạo ở lần chạy này và không bị xóa trống
        const newShort = s.short_description != null && short ? short : undefined;
        const newLong = s.description != null && long ? long : undefined;
        if (tags.length === 0 && !name && newShort === undefined && newLong === undefined) return;

        try {
            const book = books.find(b => b.path === s.path);
            const merged = [...(book?.tags || [])];
            for (const t of tags) {
                if (!merged.some(x => x.toLowerCase() === t.toLowerCase())) merged.push(t);
            }
            await api.updateBook(s.path, name || book?.file_name || s.file_name, merged, newLong, newShort);
            result.applied = true;
            appliedCount++;
            markRowSaved(result.row);
        } catch (err) {
            console.error("Apply error:", s.path, err);
        }
    }

    // Lưu mọi kết quả chưa lưu (bỏ qua sách lỗi / đã lưu)
    async function applyPending() {
        footer.querySelectorAll("button").forEach(b => { b.disabled = true; });
        failedBox.querySelectorAll("button, input").forEach(b => { b.disabled = true; });
        applyBtn.innerText = "Applying...";
        const books = await api.getBooks();
        for (const result of results) await applyResult(result, books);
    }

    // Apply
    applyBtn.onclick = async () => {
        await applyPending();
        close();
    };

    function showFailedActions(failedPaths, alreadySaved) {
        const n = failedPaths.length;
        const retryBtn = button(`Retry failed (${n})`, "", async () => {
            await applyPending();
            close();
            onRetry?.(failedPaths);
        });
        const tagInput = input("text", loadPref("aiFailedTag", "AI failed"));
        tagInput.style.cssText = "width:130px; padding:4px 8px; font-size:12px;";
        tagInput.title = "Tag to add to the failed books";
        const tagBtn = button("Tag failed & close", "", async () => {
            const tag = tagInput.value.trim();
            if (!tag) return;
            savePref("aiFailedTag", tag);
            await applyPending();
            const books = await api.getBooks();
            for (const path of failedPaths) {
                const book = books.find(b => b.path === path);
                if (!book || book.tags.some(t => t.toLowerCase() === tag.toLowerCase())) continue;
                try {
                    await api.updateBook(path, book.file_name, [...book.tags, tag]);
                    appliedCount++;
                } catch (err) {
                    console.error("Tag failed book error:", path, err);
                }
            }
            close();
        });
        failedBox.append(el("span", "status error", `${n} book${n === 1 ? "" : "s"} failed.`), retryBtn, tagBtn, tagInput);
        if (!alreadySaved) {
            const note = hint("Both also apply the successful results.");
            note.style.width = "100%";
            failedBox.append(note);
        }
        failedBox.hidden = false;
    }
}

// Đánh dấu row đã lưu: badge "Saved" + khóa các ô sửa
function markRowSaved(row) {
    const badge = el("div", "status ok", "✓ Saved");
    badge.style.cssText = "font-size:11px; font-weight:600;";
    row.insertBefore(badge, row.children[1] || null);
    row.querySelectorAll("input, textarea, button").forEach(node => { node.disabled = true; });
}

// =============================================
// SUGGESTION ROW — preview 1 kết quả; tags / descriptions sửa được trước khi Apply
// Trả về { row, suggestion, values() } — values() đọc giá trị (đã sửa) hiện tại
// =============================================
function renderSuggestionRow(suggestion, book) {
    const row = el("div");
    row.style.cssText = "border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:var(--panel-soft); display:flex; flex-direction:column; gap:6px;";

    const nameEl = el("div", "status", suggestion.file_name);
    nameEl.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    nameEl.title = suggestion.file_name;
    row.appendChild(nameEl);

    if (suggestion.error) {
        const errEl = el("div", "status error", "Error: " + suggestion.error);
        errEl.style.fontSize = "11px";
        row.appendChild(errEl);
        return { row, suggestion, values: () => ({ tags: [], name: "", short: "", long: "" }) };
    }

    const tags = [...suggestion.suggested_tags];
    if (tags.length > 0) row.appendChild(createTagEditor(tags, { placeholder: "Add tag..." }).wrap);

    // Descriptions: editable trước khi Apply
    function addTextField(labelText, value, current, multiline) {
        const fieldLabel = el("div", "hint", current ? `${labelText} (replaces the current one)` : labelText);
        fieldLabel.style.cssText = "font-weight:600; margin-top:2px;";
        const field = multiline ? textarea(value, "", 4) : input("text", value);
        field.style.cssText = "padding:6px 8px; font-size:12px;";
        field.title = current ? `Current: ${current}` : "";
        row.append(fieldLabel, field);
        return field;
    }
    const nameField = suggestion.name != null
        ? addTextField("Name", suggestion.name, book.file_name, false) : null;
    const shortField = suggestion.short_description != null
        ? addTextField("Short description", suggestion.short_description, book.short_description, false) : null;
    const longField = suggestion.description != null
        ? addTextField("Long description", suggestion.description, book.description, true) : null;

    return {
        row,
        suggestion,
        values: () => ({
            tags,
            name: (nameField?.value || "").trim(),
            short: (shortField?.value || "").trim(),
            long: (longField?.value || "").trim(),
        }),
    };
}
