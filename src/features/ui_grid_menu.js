import { api } from "./api.js";
import { openReader } from "./f_reader.js";
import { el, label, hint, input, textarea, button, openModal, showMenu } from "./ui.js";

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
//                   → đổi "Edit details" thành "Edit tags (X books)"
// =============================================
export function showCardContextMenu(x, y, book, onUpdateSuccess, viewMode, selectedBooks) {
  const actions = window.__APP_ACTIONS__;
  // Nếu đang chọn nhiều sách VÀ sách này nằm trong selection → bulk mode
  const isBulk = selectedBooks.size > 1 && selectedBooks.has(book.path);

  const items = [
    { label: "Read in app", action: () => openReader(book) },
    { label: "Open in default app", action: () => window.__TAURI__.opener.openPath(book.path) },
    { label: "Open Location", action: () => api.revealInExplorer(book.path) },
    viewMode === "trash"
      ? { label: "Restore", action: () => actions.restoreBook(book.path) }
      : { label: "Hide from library", action: () => actions.hideBook(book.path) },
    isBulk
      ? { label: `Edit tags (${selectedBooks.size} books)`, action: () => openBulkTagModal([...selectedBooks], onUpdateSuccess) }
      : { label: "Edit details", action: () => openEditModal(book, onUpdateSuccess) },
  ];

  // AI auto cho sách này (hoặc cả selection khi bulk) — chỉ khi AI được bật, không trong thùng rác
  if (viewMode !== "trash" && actions.isAiEnabled()) {
    items.push({
      label: isBulk ? `AI auto (${selectedBooks.size} books)` : "AI auto",
      action: () => actions.runAiOnBooks(isBulk ? [...selectedBooks] : [book.path])
    });
  }

  showMenu(items, { x, y });
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

const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

// =============================================
// BULK TAG MODAL — edit tags cho nhiều sách cùng lúc
//
// Logic add/remove:
//   - Tags nhập vào sẽ được ADD vào tất cả sách (không xóa tags cũ)
//   - Tags bấm Remove sẽ bị XÓA khỏi tất cả sách
//   - Cho phép thấy rõ đang add gì, remove gì trước khi apply
// =============================================
export async function openBulkTagModal(paths, onSave) {
    const allTagNames = await getAllTagNames();
    const tagsToAdd = [];
    const tagsToRemove = [];

    const body = el("div", "modal-body");
    const footer = el("div");
    const addEditor = createTagEditor(tagsToAdd, { allTagNames, onEnter: () => handleSave() });
    const removeEditor = createTagEditor(tagsToRemove, { allTagNames, onEnter: () => handleSave(), remove: true });
    const removeLabel = label("Remove tags from all");
    removeLabel.style.color = "var(--danger)";
    body.append(
        label("Add tags to all"), addEditor.wrap,
        hint("Tab to add. Enter to apply. These tags will be added to all selected books."),
        removeLabel, removeEditor.wrap,
        hint("Tab to add. Enter to apply. These tags will be removed from all selected books."),
    );

    const { close } = openModal({
        title: `Edit tags — ${paths.length} books`,
        subtitle: "Add tags: added to all books. Remove tags: removed from all books.",
        body,
        footer,
        onClose: () => { addEditor.destroy(); removeEditor.destroy(); },
    });
    const saveBtn = button(`Apply to ${paths.length} books`, "primary", () => handleSave());
    footer.append(button("Cancel", "", close), saveBtn);

    async function handleSave() {
        // Flush input chưa confirm
        addEditor.flush();
        removeEditor.flush();
        if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
            close();
            return;
        }
        saveBtn.disabled = true;
        saveBtn.innerText = "Applying...";

        const books = await api.getBooks();
        for (const path of paths) {
            const book = books.find(b => b.path === path);
            if (!book) continue;
            // Merge: giữ tags cũ + add mới + xóa remove
            const merged = [...book.tags];
            for (const t of tagsToAdd) {
                if (!merged.some(x => sameTag(x, t))) merged.push(t);
            }
            try {
                await api.updateBook(path, book.file_name, merged.filter(t => !tagsToRemove.some(r => sameTag(r, t))));
            } catch (err) {
                console.error("Bulk tag error:", path, err);
            }
        }
        close();
        onSave();
    }
}

// =============================================
// TAG EDITOR — chips + ô nhập + dropdown gợi ý từ allTagNames (tags có sẵn trong thư viện)
// tagList được sửa trực tiếp (push/splice)
// =============================================
export function createTagEditor(tagList, { allTagNames = [], onEnter = null, onChange = null, remove = false, placeholder = "Type a tag and press Enter..." } = {}) {
    const wrap = el("div", remove ? "chip-editor remove" : "chip-editor");
    const tagInput = el("input");
    tagInput.type = "text";
    tagInput.placeholder = placeholder;

    // Dropdown là popover (top layer) — hiện được trên <dialog> và không bị
    // overflow của modal cắt; vị trí lấy từ bounding rect của wrap.
    // Chỉ gắn vào <body> lần đầu cần hiện.
    const dropdown = el("div", "tag-suggest-dropdown");
    dropdown.popover = "manual";

    let matches = [];
    let highlighted = -1;

    function closeDropdown() {
        if (dropdown.matches(":popover-open")) dropdown.hidePopover();
        dropdown.innerHTML = "";
        matches = [];
        highlighted = -1;
    }

    function setHighlight(i) {
        dropdown.children[highlighted]?.classList.remove("highlighted");
        highlighted = i;
        dropdown.children[i]?.classList.add("highlighted");
        dropdown.children[i]?.scrollIntoView({ block: "nearest" });
    }

    function updateSuggestions() {
        if (!allTagNames.length) return;
        const query = tagInput.value.trim().toLowerCase();
        const pool = allTagNames.filter(name => !tagList.some(t => sameTag(t, name)));
        matches = (query ? pool.filter(name => name.toLowerCase().includes(query)) : pool).slice(0, 50);

        dropdown.innerHTML = "";
        highlighted = -1;
        if (matches.length === 0) { closeDropdown(); return; }

        matches.forEach((name, i) => {
            const item = el("div", "", name);
            item.onmouseenter = () => setHighlight(i);
            // preventDefault để input không mất focus trước khi click được xử lý
            item.onmousedown = (e) => { e.preventDefault(); addTag(name); };
            dropdown.appendChild(item);
        });
        const rect = wrap.getBoundingClientRect();
        dropdown.style.left = rect.left + "px";
        dropdown.style.width = rect.width + "px";
        dropdown.style.top = (rect.bottom + 4) + "px";
        if (!dropdown.isConnected) document.body.appendChild(dropdown);
        if (!dropdown.matches(":popover-open")) dropdown.showPopover();
    }

    function renderChips(focusInput = true) {
        wrap.innerHTML = "";
        tagList.forEach((tag, index) => {
            const chip = el("span", "chip");
            const removeBtn = el("button", "", "x");
            removeBtn.type = "button";
            removeBtn.onclick = () => { tagList.splice(index, 1); renderChips(); };
            chip.append(el("span", "", tag), removeBtn);
            wrap.appendChild(chip);
        });
        wrap.appendChild(tagInput);
        if (focusInput) tagInput.focus();
        onChange?.();
    }

    function addTag(raw) {
        const tag = raw.trim().replace(/\s+/g, " ");
        closeDropdown();
        tagInput.value = "";
        if (!tag || tagList.some(t => sameTag(t, tag))) return;
        tagList.push(tag);
        renderChips();
    }

    const pick = () => highlighted >= 0 && matches[highlighted] ? matches[highlighted] : null;

    tagInput.addEventListener("input", updateSuggestions);
    tagInput.addEventListener("focus", updateSuggestions);
    tagInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
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
                addTag(pick() ?? matches[0]);
            }
        } else if (e.key === ",") {
            e.preventDefault();
            addTag(pick() ?? tagInput.value);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (onEnter) {
                // Enter submits the modal (like clicking Save) — Tab or "," adds a tag
                closeDropdown();
                onEnter();
            } else {
                addTag(pick() ?? tagInput.value);
            }
        } else if (e.key === "Escape" && dropdown.matches(":popover-open")) {
            e.preventDefault(); // chỉ đóng dropdown, không đóng modal
            closeDropdown();
        } else if (e.key === "Backspace" && !tagInput.value.trim() && tagList.length > 0) {
            tagList.pop();
            renderChips();
        }
    });
    tagInput.addEventListener("blur", () => {
        if (tagInput.value.trim()) addTag(tagInput.value);
        closeDropdown();
    });

    renderChips(false);

    return {
        wrap,
        flush: () => { if (tagInput.value.trim()) addTag(tagInput.value); },
        // Vẽ lại sau khi tagList bị thay từ bên ngoài
        render: () => renderChips(false),
        // Dropdown sống ở <body>, không phải con của wrap — phải gỡ khi modal đóng
        tags: tagList,
        destroy: () => dropdown.remove(),
    };
}

// =============================================
// SINGLE EDIT MODAL — sửa tên + tags + description 1 sách
// =============================================
export async function openEditModal(book, onSave) {
    const allTagNames = await getAllTagNames();
    const currentTags = [...(book.tags || [])];

    const body = el("div", "modal-body");
    const footer = el("div");

    const nameInput = input("text", book.file_name || "");
    const tagEditor = createTagEditor(currentTags, { allTagNames, onEnter: () => handleSave() });
    const shortDescInput = input("text", book.short_description || "", "One-line summary...");
    const descInput = textarea(book.description || "", "Notes about this book...", 4);
    descInput.style.minHeight = "80px";

    // Enter lưu ngay (Ctrl+Enter trong ô description — Enter thường xuống dòng)
    const saveOnEnter = (needsCtrl) => (e) => {
        if (e.key === "Enter" && (!needsCtrl || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSave();
        }
    };
    nameInput.addEventListener("keydown", saveOnEnter(false));
    shortDescInput.addEventListener("keydown", saveOnEnter(false));
    descInput.addEventListener("keydown", saveOnEnter(true));

    body.append(
        label("File name"), nameInput,
        label("Tags"), tagEditor.wrap,
        hint("Tab to add a tag. Enter to save. Backspace on empty input to remove last tag."),
        label("Short description"), shortDescInput,
        label("Description"), descInput, hint("Ctrl+Enter to save."),
    );

    const { close } = openModal({
        title: "Edit details",
        subtitle: "Click x on a chip to remove a tag.",
        body,
        footer,
        onClose: () => tagEditor.destroy(),
    });
    const saveBtn = button("Save", "primary", () => handleSave());
    footer.append(button("Cancel", "", close), saveBtn);

    async function handleSave() {
        try {
            tagEditor.flush();
            const cleanTags = currentTags.filter((tag, i, arr) => arr.findIndex(t => sameTag(t, tag)) === i);
            saveBtn.disabled = true;
            saveBtn.innerText = "Saving...";
            await api.updateBook(
                book.path,
                nameInput.value.trim() || book.file_name,
                cleanTags,
                descInput.value.trim(),
                shortDescInput.value.trim(),
            );
            close();
            onSave();
        } catch (err) {
            alert("Error updating book: " + err);
            saveBtn.disabled = false;
            saveBtn.innerText = "Save";
        }
    }

    nameInput.focus();
    nameInput.select();
}
