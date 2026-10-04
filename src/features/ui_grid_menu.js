import { api } from "./api.js";
import { openReader } from "./f_reader.js";

// =============================================
// CONTEXT MENU — hiện khi right click 1 card
//
// Params:
//   x, y          — tọa độ mouse
//   book          — BookEntry đang right click
//   onUpdateSuccess — callback sau khi action xong
//   viewMode      — "library" | "trash"
//   selectedBooks — Set<path> từ main.js
//                   Nếu size > 1 và book.path trong set
//                   → đổi "Edit name & Tags" thành "Edit tags (X books)"
// =============================================
export function showCardContextMenu(x, y, book, onUpdateSuccess, viewMode = "library", selectedBooks = new Set()) {
  document.querySelectorAll(".context-menu").forEach(m => m.remove());

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.cssText = `
    position: fixed;
    top: ${y}px;
    left: ${x}px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-md);
    padding: 4px;
    z-index: 1000;
    min-width: 220px;
    font-size: 13px;
    color: var(--text);
  `;

  const folderPath = getFolderPath(book.path);

  // Nếu đang chọn nhiều sách VÀ sách này nằm trong selection → bulk mode
  const isBulk = selectedBooks.size > 1 && selectedBooks.has(book.path);

  const items = [
    {
      label: "Read in app",
      action: () => openReader(book)
    },
    {
      label: "Open in default app",
      action: async () => await window.__TAURI__.opener.openPath(book.path)
    },
    {
      label: "Open Location",
      action: async () => await api.revealInExplorer(book.path)
    },
    viewMode === "trash"
      ? {
          label: "Restore",
          action: async () => {
            if (window.__APP_ACTIONS__?.restoreBook) {
              await window.__APP_ACTIONS__.restoreBook(book.path);
            }
            if (typeof onUpdateSuccess === "function") await onUpdateSuccess();
          }
        }
      : {
          label: "Hide from library",
          action: async () => {
            if (window.__APP_ACTIONS__?.hideBook) {
              await window.__APP_ACTIONS__.hideBook(book.path);
            }
            if (typeof onUpdateSuccess === "function") await onUpdateSuccess();
          }
        },
    // Single → "Edit name & Tags" | Bulk → "Edit tags (X books)"
    isBulk
      ? {
          label: `Edit tags (${selectedBooks.size} books)`,
          action: () => openBulkTagModal([...selectedBooks], onUpdateSuccess)
        }
      : {
          label: "Edit details",
          action: () => openEditModal(book, onUpdateSuccess)
        }
  ];

  // AI auto cho sách này (hoặc cả selection khi bulk) — chỉ khi AI được bật, không trong thùng rác
  if (viewMode !== "trash" && window.__APP_ACTIONS__?.isAiEnabled?.() && window.__APP_ACTIONS__?.runAiOnBooks) {
    items.push({
      label: isBulk ? `AI auto (${selectedBooks.size} books)` : "AI auto",
      action: () => window.__APP_ACTIONS__.runAiOnBooks(isBulk ? [...selectedBooks] : [book.path])
    });
  }

  items.forEach(({ label, action }) => {
    const item = document.createElement("div");
    item.innerText = label;
    item.style.cssText = `
      padding: 9px 12px;
      cursor: pointer;
      border-radius: 6px;
      transition: background 0.15s;
    `;
    item.onmouseenter = () => item.style.background = "var(--hover)";
    item.onmouseleave = () => item.style.background = "transparent";
    item.onclick = async () => {
      menu.remove();
      await action();
    };
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  // Clamp vào viewport — tránh menu bị cắt ở mép phải / mép dưới
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (x - rect.width)  + "px";
  if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + "px";

  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 0);
}

// Lấy danh sách tên tag đã tồn tại, dùng cho dropdown gợi ý
async function getAllTagNames() {
    try {
        const tags = await api.getTags();
        return tags.map(t => t.name).sort((a, b) => a.localeCompare(b));
    } catch (err) {
        console.error("Failed to load tags for autocomplete:", err);
        return [];
    }
}

// Lấy đường dẫn folder chứa file
function getFolderPath(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return null;
  return filePath.slice(0, idx);
}

// =============================================
// BULK TAG MODAL — edit tags cho nhiều sách cùng lúc
//
// Logic add/remove:
//   - Tags nhập vào sẽ được ADD vào tất cả sách (không xóa tags cũ)
//   - Tags bấm Remove sẽ bị XÓA khỏi tất cả sách
//   - Cho phép thấy rõ đang add gì, remove gì trước khi apply
// =============================================
export async function openBulkTagModal(paths, onSave) {
    document.querySelectorAll(".edit-book-overlay").forEach(el => el.remove());
    document.querySelectorAll(".tag-suggest-dropdown").forEach(el => el.remove());

    const allTagNames = await getAllTagNames();

    let tagsToAdd = [];    // Tags sẽ được add vào tất cả sách
    let tagsToRemove = []; // Tags sẽ bị xóa khỏi tất cả sách

    const overlay = document.createElement("div");
    overlay.className = "edit-book-overlay";
    overlay.style.cssText = `
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.35);
        display: flex; align-items: center; justify-content: center;
        z-index: 8000; padding: 20px;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        width: min(640px, 100%);
        background: var(--panel);
        color: var(--text);
        border-radius: 14px;
        box-shadow: var(--shadow-md);
        overflow: hidden;
        font-family: inherit;
        border: 1px solid var(--border);
    `;

    // --- Header ---
    const header = document.createElement("div");
    header.style.cssText = `
        padding: 16px 18px 12px;
        border-bottom: 1px solid var(--border);
        display: flex; align-items: center;
        justify-content: space-between; gap: 12px;
    `;

    const titleWrap = document.createElement("div");
    titleWrap.innerHTML = `
        <div style="font-size:18px;font-weight:700;color:var(--text);">Edit tags — ${paths.length} books</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
          Add tags: added to all books. Remove tags: removed from all books.
        </div>
    `;

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "x";
    closeBtn.style.cssText = `
        border:none; background:var(--hover);
        color:var(--text);
        width:34px; height:34px; border-radius:999px;
        cursor:pointer; font-size:14px;
    `;

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    // --- Body ---
    const body = document.createElement("div");
    body.style.cssText = "padding:18px; display:flex; flex-direction:column; gap:16px;";

    // --- Add tags section ---
    const addBlock = document.createElement("div");
    addBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text);">Add tags to all</div>`;

    const addEditor = createTagEditor(tagsToAdd, "#eef4ff", "#1d4ed8", "#cfe0ff", allTagNames, () => handleSave());
    addBlock.appendChild(addEditor.wrap);
    addBlock.appendChild(addEditor.helper("Tab to add. Enter to apply. These tags will be added to all selected books."));

    // --- Remove tags section ---
    const removeBlock = document.createElement("div");
    removeBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#c00;">Remove tags from all</div>`;

    const removeEditor = createTagEditor(tagsToRemove, "#fff0f0", "#c00", "#ffd0d0", allTagNames, () => handleSave());
    removeBlock.appendChild(removeEditor.wrap);
    removeBlock.appendChild(removeEditor.helper("Tab to add. Enter to apply. These tags will be removed from all selected books."));

    body.appendChild(addBlock);
    body.appendChild(removeBlock);

    // --- Footer ---
    const footer = document.createElement("div");
    footer.style.cssText = `
        padding:14px 18px; border-top:1px solid var(--border);
        display:flex; justify-content:flex-end; gap:10px; background:var(--panel-soft);
    `;

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "Cancel";
    cancelBtn.style.cssText = "border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; padding:9px 14px; cursor:pointer;";

    const saveBtn = document.createElement("button");
    saveBtn.innerText = `Apply to ${paths.length} books`;
    saveBtn.style.cssText = "border:1px solid var(--primary); background:var(--primary); color:white; border-radius:8px; padding:9px 16px; cursor:pointer; font-weight:600;";

    function closeModal() {
        addEditor.destroy();
        removeEditor.destroy();
        overlay.remove();
    }

    // --- Save logic ---
    async function handleSave() {
        // Flush input chưa confirm
        addEditor.flush();
        removeEditor.flush();

        if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
            closeModal();
            return;
        }

        saveBtn.disabled = true;
        saveBtn.innerText = "Applying...";

        let successCount = 0;
        for (const path of paths) {
            try {
                // Lấy book hiện tại từ state để biết tags hiện có
                // Dùng __APP_ACTIONS__.getBook nếu có, không thì dùng api.getBooks
                // Cách đơn giản: gọi updateBook với tags đã merge
                const books = await api.getBooks();
                const book = books.find(b => b.path === path);
                if (!book) continue;

                // Merge: giữ tags cũ + add mới + xóa remove
                let merged = [...book.tags];
                for (const t of tagsToAdd) {
                    if (!merged.some(x => x.toLowerCase() === t.toLowerCase())) {
                        merged.push(t);
                    }
                }
                merged = merged.filter(t =>
                    !tagsToRemove.some(r => r.toLowerCase() === t.toLowerCase())
                );

                await api.updateBook(path, book.file_name, merged);
                successCount++;
            } catch (err) {
                console.error("Bulk tag error:", path, err);
            }
        }

        closeModal();
        if (typeof onSave === "function") onSave();
    }

    cancelBtn.onclick = () => closeModal();
    closeBtn.onclick  = () => closeModal();
    saveBtn.onclick   = handleSave;

    // Chỉ đóng khi cả mousedown lẫn click đều nhắm vào overlay — tránh trường
    // hợp bôi đen text trong modal rồi thả chuột ra ngoài (mouseup ngoài overlay
    // vẫn khiến "click" nổ ra trên overlay) làm modal đóng ngoài ý muốn.
    let mouseDownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => { mouseDownOnOverlay = (e.target === overlay); });
    overlay.addEventListener("click", (e) => {
        if (mouseDownOnOverlay && e.target === overlay) closeModal();
        mouseDownOnOverlay = false;
    });
    document.addEventListener("keydown", function escHandler(e) {
        if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", escHandler); }
    }, { once: true });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

// Helper tạo tag editor tái sử dụng được cho cả Add và Remove section
// allTagNames: danh sách tag đã tồn tại (toàn bộ thư viện) dùng để hiện dropdown gợi ý
function createTagEditor(tagList, bgColor, textColor, borderColor, allTagNames = [], onEnterSubmit = null) {
    const wrap = document.createElement("div");
    wrap.style.cssText = `
        border:1px solid var(--border); border-radius:10px; padding:8px;
        min-height:52px; display:flex; flex-wrap:wrap;
        align-items:center; gap:8px; background:var(--panel);
    `;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type a tag and press Enter...";
    input.style.cssText = `
        border:none; outline:none; flex:1; min-width:180px;
        font-size:14px; padding:6px 2px; background:transparent;
        color:var(--text);
    `;

    // --- Suggestions dropdown ---
    // Appended to <body> (not wrap) and positioned with `fixed` coords from
    // wrap's bounding rect — the modal has `overflow:hidden` and no scroll
    // region of its own, so a dropdown nested inside it would just stretch
    // the modal taller instead of scrolling within its own 180px box.
    const dropdown = document.createElement("div");
    dropdown.className = "tag-suggest-dropdown";
    dropdown.style.cssText = `
        position:fixed;
        background:var(--panel); border:1px solid var(--border);
        border-radius:8px; box-shadow:var(--shadow-md);
        max-height:180px; overflow-y:auto; z-index:8500; display:none;
    `;
    document.body.appendChild(dropdown);

    function positionDropdown() {
        const rect = wrap.getBoundingClientRect();
        dropdown.style.left = rect.left + "px";
        dropdown.style.width = rect.width + "px";
        dropdown.style.top = (rect.bottom + 4) + "px";
    }

    let matches = [];
    let highlighted = -1;

    function closeDropdown() {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
        matches = [];
        highlighted = -1;
    }

    function setHighlight(i) {
        const children = dropdown.children;
        if (highlighted >= 0 && children[highlighted]) children[highlighted].style.background = "transparent";
        highlighted = i;
        if (children[i]) {
            children[i].style.background = "var(--hover)";
            children[i].scrollIntoView({ block: "nearest" });
        }
    }

    function updateSuggestions() {
        const query = input.value.trim().toLowerCase();
        const existing = new Set(tagList.map(t => t.toLowerCase()));
        const pool = allTagNames.filter(name => !existing.has(name.toLowerCase()));
        matches = (query ? pool.filter(name => name.toLowerCase().includes(query)) : pool).slice(0, 50);

        dropdown.innerHTML = "";
        highlighted = -1;
        if (matches.length === 0) { dropdown.style.display = "none"; return; }

        matches.forEach((name, i) => {
            const item = document.createElement("div");
            item.innerText = name;
            item.style.cssText = "padding:7px 10px; cursor:pointer; font-size:13px; color:var(--text); border-radius:6px;";
            item.onmouseenter = () => setHighlight(i);
            // preventDefault để input không mất focus trước khi click được xử lý
            item.onmousedown = (e) => { e.preventDefault(); addTag(name); };
            dropdown.appendChild(item);
        });
        positionDropdown();
        dropdown.style.display = "block";
    }

    function normalize(tag) { return tag.trim().replace(/\s+/g, " "); }

    function renderChips(focusInput = true) {
        wrap.innerHTML = "";
        tagList.forEach((tag, index) => {
            const chip = document.createElement("span");
            chip.style.cssText = `
                display:inline-flex; align-items:center; gap:6px;
                background:${bgColor}; border:1px solid ${borderColor};
                color:${textColor}; border-radius:999px;
                padding:6px 10px; font-size:12px; line-height:1;
            `;
            const text = document.createElement("span");
            text.innerText = tag;
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.innerText = "x";
            removeBtn.style.cssText = `border:none; background:transparent; color:${textColor}; font-size:14px; font-weight:bold; cursor:pointer; padding:0; line-height:1;`;
            removeBtn.onclick = () => { tagList.splice(index, 1); renderChips(); };
            chip.appendChild(text);
            chip.appendChild(removeBtn);
            wrap.appendChild(chip);
        });
        wrap.appendChild(input);
        if (focusInput) input.focus();
    }

    function addTag(raw) {
        const tag = normalize(raw);
        closeDropdown();
        if (!tag) return;
        if (tagList.some(t => t.toLowerCase() === tag.toLowerCase())) { input.value = ""; return; }
        tagList.push(tag);
        input.value = "";
        renderChips();
    }

    input.addEventListener("input", updateSuggestions);
    input.addEventListener("focus", updateSuggestions);

    input.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            // Let the browser's native select-all run in this field instead
            // of the app-wide "select all books" shortcut in main.js.
            e.stopPropagation();
        } else if (e.key === "ArrowDown") {
            if (matches.length) { e.preventDefault(); setHighlight((highlighted + 1) % matches.length); }
        } else if (e.key === "ArrowUp") {
            if (matches.length) { e.preventDefault(); setHighlight((highlighted - 1 + matches.length) % matches.length); }
        } else if (e.key === "Tab") {
            // Tab picks the (highlighted or first) suggestion and keeps focus
            // in the field so more tags can be typed. With no suggestions,
            // Tab falls through to normal focus change — the blur handler
            // below still commits any typed text as a new tag.
            if (matches.length) {
                e.preventDefault();
                addTag(highlighted >= 0 && matches[highlighted] ? matches[highlighted] : matches[0]);
            }
        } else if (e.key === ",") {
            e.preventDefault();
            addTag(highlighted >= 0 && matches[highlighted] ? matches[highlighted] : input.value);
        } else if (e.key === "Enter") {
            // Enter submits the modal (like clicking Save) rather than
            // committing a tag — use Tab or "," to add a tag instead.
            e.preventDefault();
            closeDropdown();
            if (typeof onEnterSubmit === "function") onEnterSubmit();
        } else if (e.key === "Escape") {
            closeDropdown();
        } else if (e.key === "Backspace" && !input.value.trim() && tagList.length > 0) {
            tagList.pop(); renderChips();
        }
    });
    input.addEventListener("blur", () => {
        if (input.value.trim()) addTag(input.value);
        closeDropdown();
    });

    renderChips(false);

    return {
        wrap,
        helper: (text) => {
            const el = document.createElement("div");
            el.style.cssText = "font-size:12px; color:var(--text-secondary); margin-top:6px;";
            el.innerText = text;
            return el;
        },
        flush: () => { if (input.value.trim()) addTag(input.value); },
        // Dropdown sống ở <body>, không phải con của wrap — phải dọn dẹp
        // thủ công khi modal đóng, nếu không sẽ để lại node ẩn mồ côi.
        destroy: () => { dropdown.remove(); }
    };
}

// =============================================
// SINGLE EDIT MODAL — sửa tên + tags + description 1 sách
// =============================================
export async function openEditModal(book, onSave) {
    document.querySelectorAll(".edit-book-overlay").forEach(el => el.remove());
    document.querySelectorAll(".tag-suggest-dropdown").forEach(el => el.remove());

    const allTagNames = await getAllTagNames();

    let currentName = book.file_name || "";
    let currentTags = Array.isArray(book.tags) ? [...book.tags] : [];
    let currentDescription = book.description || "";
    let currentShortDescription = book.short_description || "";

    const overlay = document.createElement("div");
    overlay.className = "edit-book-overlay";
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.35);
        display:flex; align-items:center; justify-content:center;
        z-index:8000; padding:20px;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        width:min(640px,100%); background:var(--panel); color:var(--text); border-radius:14px;
        box-shadow:var(--shadow-md); overflow:hidden; font-family:inherit;
        border:1px solid var(--border);
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        padding:16px 18px 12px; border-bottom:1px solid var(--border);
        display:flex; align-items:center; justify-content:space-between; gap:12px;
    `;

    const titleWrap = document.createElement("div");
    titleWrap.innerHTML = `
        <div style="font-size:18px;font-weight:700;color:var(--text);">Edit details</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">Click x on a chip to remove a tag.</div>
    `;

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "x";
    closeBtn.style.cssText = "border:none; background:var(--hover); color:var(--text); width:34px; height:34px; border-radius:999px; cursor:pointer; font-size:14px;";

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.style.cssText = "padding:18px; display:flex; flex-direction:column; gap:16px;";

    const nameBlock = document.createElement("div");
    nameBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text);">File name</div>`;

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = currentName;
    nameInput.style.cssText = "width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font-size:14px; outline:none; box-sizing:border-box; background:var(--panel); color:var(--text);";
    nameInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            // Let the browser's native select-all run in this field instead
            // of the app-wide "select all books" shortcut in main.js.
            e.stopPropagation();
        } else if (e.key === "Enter") {
            e.preventDefault();
            handleSave();
        }
    });
    nameBlock.appendChild(nameInput);

    const tagBlock = document.createElement("div");
    tagBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text);">Tags</div>`;

    const tagEditor = createTagEditor(currentTags, "var(--primary-soft)", "var(--primary)", "var(--primary)", allTagNames, () => handleSave());
    tagBlock.appendChild(tagEditor.wrap);
    tagBlock.appendChild(tagEditor.helper("Tab to add a tag. Enter to save. Backspace on empty input to remove last tag."));

    const shortDescBlock = document.createElement("div");
    shortDescBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text);">Short description</div>`;

    const shortDescInput = document.createElement("input");
    shortDescInput.type = "text";
    shortDescInput.value = currentShortDescription;
    shortDescInput.placeholder = "One-line summary...";
    shortDescInput.style.cssText = nameInput.style.cssText;
    shortDescInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.stopPropagation();
        } else if (e.key === "Enter") {
            e.preventDefault();
            handleSave();
        }
    });
    shortDescBlock.appendChild(shortDescInput);

    const descBlock = document.createElement("div");
    descBlock.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text);">Description</div>`;

    const descInput = document.createElement("textarea");
    descInput.value = currentDescription;
    descInput.rows = 4;
    descInput.placeholder = "Notes about this book...";
    descInput.style.cssText = "width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font-size:14px; outline:none; box-sizing:border-box; background:var(--panel); color:var(--text); font-family:inherit; resize:vertical; min-height:80px;";
    descInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.stopPropagation();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            // Plain Enter inserts a newline here; Ctrl+Enter saves.
            e.preventDefault();
            handleSave();
        }
    });
    descBlock.appendChild(descInput);
    const descHelper = document.createElement("div");
    descHelper.style.cssText = "font-size:12px;color:var(--text-secondary);margin-top:6px;";
    descHelper.innerText = "Ctrl+Enter to save.";
    descBlock.appendChild(descHelper);

    const footer = document.createElement("div");
    footer.style.cssText = "padding:14px 18px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; gap:10px; background:var(--panel-soft);";

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "Cancel";
    cancelBtn.style.cssText = "border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; padding:9px 14px; cursor:pointer;";

    const saveBtn = document.createElement("button");
    saveBtn.innerText = "Save";
    saveBtn.style.cssText = "border:1px solid var(--primary); background:var(--primary); color:white; border-radius:8px; padding:9px 16px; cursor:pointer; font-weight:600;";

    function normalizeTag(tag) { return tag.trim().replace(/\s+/g, " "); }

    function closeModal() {
        tagEditor.destroy();
        overlay.remove();
    }

    async function handleSave() {
        try {
            tagEditor.flush();
            const newName = nameInput.value.trim() || book.file_name;
            const cleanTags = currentTags.map(normalizeTag).filter(Boolean)
                .filter((tag, index, arr) => arr.findIndex(t => t.toLowerCase() === tag.toLowerCase()) === index);
            saveBtn.disabled = true;
            saveBtn.innerText = "Saving...";
            const newDescription = descInput.value.trim();
            const newShortDescription = shortDescInput.value.trim();
            await api.updateBook(book.path, newName, cleanTags, newDescription, newShortDescription);
            closeModal();
            if (typeof onSave === "function") onSave();
        } catch (err) {
            alert("Error updating book: " + err);
            saveBtn.disabled = false;
            saveBtn.innerText = "Save";
        }
    }

    cancelBtn.onclick = () => closeModal();
    closeBtn.onclick  = () => closeModal();
    saveBtn.onclick   = handleSave;

    // Chỉ đóng khi cả mousedown lẫn click đều nhắm vào overlay — tránh trường
    // hợp bôi đen text trong modal rồi thả chuột ra ngoài làm modal đóng ngoài ý muốn.
    let mouseDownOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => { mouseDownOnOverlay = (e.target === overlay); });
    overlay.addEventListener("click", (e) => {
        if (mouseDownOnOverlay && e.target === overlay) closeModal();
        mouseDownOnOverlay = false;
    });
    document.addEventListener("keydown", function escHandler(e) {
        if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", escHandler); }
    }, { once: true });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    body.appendChild(nameBlock);
    body.appendChild(tagBlock);
    body.appendChild(shortDescBlock);
    body.appendChild(descBlock);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    nameInput.focus();
    nameInput.select();
}