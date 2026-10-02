import { api } from "./features/api.js";
import { renderSidebar } from "./features/f_sidebar.js";
import { renderAssetGrid, updateCardSelectionVisual, getShiftSelectRange, getBookIndex, setLastClickedIndex, getLastClickedIndex, getFilteredPaths } from "./features/f_grid.js";
import { renderTagsUI } from "./features/f_tags.js";
import { openEditModal } from "./features/ui_grid_menu.js";
import { pickLibraryFolder } from "./features/f_addfolder.js";
import { openAiAutoTag } from "./features/f_ai.js";
import { openDuplicates } from "./features/f_duplicates.js";
import { openSettings } from "./features/f_settings.js";
import { openAutoBackupPrompt } from "./features/f_backup_prompt.js";
import { openReader } from "./features/f_reader.js";
import { readList, toggleBookmark, writeCurrentFilters } from "./features/f_reading_history.js";

// ==========================================
// STATE
// ==========================================
let state = {
    books: [],               // Toàn bộ sách (cả hidden) — lấy từ backend
    tags: [],                // Tags để render sidebar (chỉ của sách không hidden)
    selectedTags: [],        // Tags đang filter
    untaggedOnly: false,     // Lọc riêng sách chưa có tag nào — loại trừ với selectedTags
    currentFilterPath: null, // Folder đang chọn trong sidebar
    currentSearch: "",       // Nội dung ô tìm kiếm
    currentSort: "name-asc", // Kiểu sắp xếp
    viewMode: "library",     // "library" | "trash"
    selectedBooks: new Set(), // Set<path> — sách đang được multi-select
    clickBehavior: localStorage.getItem("clickBehavior") || "select", // "select" | "open-default" | "open-reader"
    showShortDescription: localStorage.getItem("showShortDescription") === "true" // card ngang có short description
};
window.__DEBUG_STATE__ = state;
// ==========================================
// MAIN
// ==========================================
window.addEventListener("DOMContentLoaded", async () => {

    // --- DOM Elements ---
    const sidebarContainer    = document.querySelector("#sidebar-folders");
    const assetGridContainer  = document.querySelector("#asset-grid");
    const tagContainer        = document.querySelector("#tag-list-container");
    const tagSearchInput      = document.querySelector("#tag-search-input");
    const txtStatus           = document.querySelector("#txt-status");
    const searchInput         = document.querySelector("#search-input");
    const sortSelect          = document.querySelector("#sort-select");

    // Toolbar buttons
    const btnUpdateDB         = document.querySelector("#btn-update-db");
    const btnAiAutoTag        = document.querySelector("#btn-ai-autotag");
    const btnFindDuplicates   = document.querySelector("#btn-find-duplicates");
    const btnThemeToggle      = document.querySelector("#btn-theme-toggle");

    // Selection + trash buttons
    const btnTrashView        = document.querySelector("#btn-trash-view");
    const txtTrashCount       = document.querySelector("#txt-trash-count");
    const btnSettings         = document.querySelector("#btn-settings");
    const txtSelectionCount   = document.querySelector("#txt-selection-count");
    const btnBulkHide         = document.querySelector("#btn-bulk-hide");
    const btnBulkRestore      = document.querySelector("#btn-bulk-restore");
    const btnClearSelection   = document.querySelector("#btn-clear-selection");
    const btnSelectAll        = document.querySelector("#btn-select-all");
    const btnJumpLast         = document.querySelector("#btn-jump-last");
    const btnJumpLastArrow    = document.querySelector("#btn-jump-last-arrow");

    // Progress bar elements (trong #txt-status area)
    // Tạo sẵn 1 lần, ẩn đi, chỉ hiện khi đang scan
    const progressWrap = document.createElement("div");
    progressWrap.style.cssText = "margin-top:6px; display:none;";

    const progressBar = document.createElement("div");
    progressBar.style.cssText = `
        height: 6px;
        background: var(--border);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 4px;
    `;
    const progressFill = document.createElement("div");
    progressFill.style.cssText = `
        height: 100%;
        width: 0%;
        background: var(--primary);
        border-radius: 3px;
        transition: width 0.2s ease;
    `;

    progressBar.appendChild(progressFill);

    const progressText = document.createElement("div");
    progressText.style.cssText = "font-size:11px; color:var(--text-secondary);";

    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressText);

    // Gắn progress bar vào ngay sau txtStatus
    if (txtStatus && txtStatus.parentNode) {
        txtStatus.parentNode.insertBefore(progressWrap, txtStatus.nextSibling);
    }

    // ==========================================
    // PROGRESS BAR — lắng nghe event từ backend
    // Backend emit "scan_progress" sau mỗi thumbnail render
    // Payload: { current, total, file_name, done }
    // ==========================================
    const { listen } = window.__TAURI__.event;

    listen("scan_progress", (event) => {
        const { current, total, file_name, done } = event.payload;

        if (done || total === 0) {
            // Hoàn thành — ẩn progress bar
            progressFill.style.width = "100%";
            setTimeout(() => {
                progressWrap.style.display = "none";
                progressFill.style.width = "0%";
            }, 800);
            return;
        }

        // Hiện progress bar
        progressWrap.style.display = "";

        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        progressFill.style.width = pct + "%";
        progressText.innerText = `Rendering thumbnails: ${current}/${total} — ${file_name}`;
    });

    // ==========================================
    // APP ACTIONS — đăng ký để ui_grid_menu.js gọi
    // ==========================================
    window.__APP_ACTIONS__ = {
        hideBook: async (path) => {
            await api.hideBook(path);
            await refreshUi();
            setStatus("Book hidden.", "gray");
        },
        restoreBook: async (path) => {
            await api.restoreBook(path);
            await refreshUi();
            setStatus("Book restored.", "green");
        },
        // Gọi từ ui_grid_card.js sau khi toggle star
        // Chỉ re-sort grid, không reload toàn bộ (không gọi refreshUi)
        // book.starred đã được update local trong card trước khi gọi đây
        onStarToggled: (path, newState) => {
            // Chỉ update local state — không re-render grid
            // Starred books sẽ lên đầu lần sau vào folder hoặc refresh
            const book = state.books.find(b => b.path === path);
            if (book) book.starred = newState;
        },
        // Gọi từ f_reader.js — mở modal edit name & tags cho sách đang đọc.
        // onSaved (nếu có) nhận lại book đã update để reader tự cập nhật title.
        editBook: (book, onSaved) => {
            openEditModal(book, async () => {
                await refreshUi();
                if (typeof onSaved === "function") {
                    onSaved(state.books.find(b => b.path === book.path) || null);
                }
            });
        },
        // Gọi từ f_reader.js — lấy sách kế trước/sau (direction: -1 | 1) theo
        // đúng thứ tự đang hiện trong grid (đã filter/sort), dùng cho nút
        // chuyển trang trong reader.
        getAdjacentBook: (path, direction) => {
            const paths = getFilteredPaths();
            const idx = paths.indexOf(path);
            if (idx === -1) return null;
            const newIdx = idx + direction;
            if (newIdx < 0 || newIdx >= paths.length) return null;
            return state.books.find(b => b.path === paths[newIdx]) || null;
        },
        // Gọi từ f_reader.js — lấy sách đầu/cuối (edge: "first" | "last")
        // theo đúng thứ tự đang hiện trong grid, dùng cho nút "first/last" trong reader.
        getBoundaryBook: (edge) => {
            const paths = getFilteredPaths();
            if (paths.length === 0) return null;
            const targetPath = edge === "first" ? paths[0] : paths[paths.length - 1];
            return state.books.find(b => b.path === targetPath) || null;
        },
        // Gọi từ f_reader.js khi reader đóng — refresh label/visibility của nút
        // "Continue reading" (nó có thể đã lưu 1 vị trí mới trong lúc đọc).
        onReaderClosed: () => updateJumpLastButton(),
    };

    // ==========================================
    // MULTI-SELECT
    // ==========================================

    // Toggle select 1 sách
    // Nếu shiftKey = true → select range từ lastClickedIndex đến index hiện tại
    function toggleSelectBook(path, shiftKey = false) {
        const currentIndex = getBookIndex(path);

        if (shiftKey && getLastClickedIndex() >= 0) {
            // Shift+click → select tất cả cards trong range
            const rangePaths = getShiftSelectRange(getLastClickedIndex(), currentIndex);
            rangePaths.forEach(p => {
                state.selectedBooks.add(p);
                updateCardSelectionVisual(p, true);
            });
        } else {
            // Click thường → toggle 1 card
            if (state.selectedBooks.has(path)) {
                state.selectedBooks.delete(path);
                updateCardSelectionVisual(path, false);
            } else {
                state.selectedBooks.add(path);
                updateCardSelectionVisual(path, true);
            }
            setLastClickedIndex(currentIndex);
        }

        updateSelectionUI();
    }

    // Chọn tất cả sách đang hiện trong grid (respect filter/search/tag hiện tại)
    function selectAllVisible() {
        getFilteredPaths().forEach(p => state.selectedBooks.add(p));
        updateGrid();
        updateSelectionUI();
    }

    // Bỏ chọn tất cả
    function clearSelection() {
        state.selectedBooks.clear();
        updateGrid();
        updateSelectionUI();
    }

    // Cập nhật text count + ẩn/hiện nút bulk action
    function updateSelectionUI() {
        const count = state.selectedBooks.size;
        if (txtSelectionCount) txtSelectionCount.innerText = `${count} selected`;

        // Multi-select doesn't apply in a Read Mode (click opens the PDF instead
        // of selecting it), so hide the selection count and "Select all" there.
        const isReadMode = state.clickBehavior !== "select";
        if (txtSelectionCount) txtSelectionCount.style.display = isReadMode ? "none" : "";
        if (btnSelectAll)      btnSelectAll.style.display      = isReadMode ? "none" : "";

        const hasSelection = count > 0;
        if (btnBulkHide)       btnBulkHide.style.display       = (hasSelection && state.viewMode === "library") ? "" : "none";
        if (btnBulkRestore)    btnBulkRestore.style.display    = (hasSelection && state.viewMode === "trash")   ? "" : "none";
        if (btnClearSelection) btnClearSelection.style.display = hasSelection ? "" : "none";
    }

    if (btnBulkHide) {
        btnBulkHide.addEventListener("click", async () => {
            if (state.selectedBooks.size === 0) return;
            const paths = [...state.selectedBooks];
            for (const path of paths) await api.hideBook(path);
            state.selectedBooks.clear();
            await refreshUi();
            setStatus(`${paths.length} book(s) hidden.`, "gray");
        });
    }

    if (btnBulkRestore) {
        btnBulkRestore.addEventListener("click", async () => {
            if (state.selectedBooks.size === 0) return;
            const paths = [...state.selectedBooks];
            for (const path of paths) await api.restoreBook(path);
            state.selectedBooks.clear();
            await refreshUi();
            setStatus(`${paths.length} book(s) restored.`, "green");
        });
    }

    if (btnSelectAll)      btnSelectAll.addEventListener("click", selectAllVisible);
    if (btnClearSelection) btnClearSelection.addEventListener("click", clearSelection);

    // ==========================================
    // THÙNG RÁC
    // ==========================================
    function updateTrashButton() {
        const count = state.books.filter(b => b.hidden).length;
        if (txtTrashCount) txtTrashCount.innerText = count;

        if (btnTrashView) {
            if (count > 0) {
                btnTrashView.disabled = false;
                btnTrashView.style.cursor = "pointer";
                btnTrashView.style.color = "";
                btnTrashView.style.opacity = "1";
            } else {
                if (state.viewMode === "trash") switchToLibrary();
                btnTrashView.disabled = true;
                btnTrashView.style.cursor = "not-allowed";
                btnTrashView.style.color = "var(--text-secondary)";
                btnTrashView.style.opacity = "0.6";
            }
        }
    }

    function switchToTrash() {
        state.viewMode = "trash";
        state.currentFilterPath = null;
        state.selectedTags = [];
        state.selectedBooks.clear();
        if (btnTrashView) {
            btnTrashView.style.background = "var(--danger-soft)";
            btnTrashView.style.borderColor = "var(--danger)";
            btnTrashView.style.color = "var(--danger)";
        }
        updateSelectionUI();
        updateGrid();
    }

    function switchToLibrary() {
        state.viewMode = "library";
        state.selectedBooks.clear();
        if (btnTrashView) {
            btnTrashView.style.background = "";
            btnTrashView.style.borderColor = "";
            btnTrashView.style.color = "";
        }
        updateSelectionUI();
        updateGrid();
    }

    if (btnTrashView) {
        btnTrashView.addEventListener("click", () => {
            if (state.viewMode === "trash") switchToLibrary();
            else switchToTrash();
        });
    }

    if (btnSettings) {
        btnSettings.addEventListener("click", () => openSettings({
            clickBehavior: state.clickBehavior,
            onClickBehaviorChange: (value) => {
                state.clickBehavior = value;
                localStorage.setItem("clickBehavior", value);
                updateSelectionUI();
                updateGrid();
            },
            showShortDescription: state.showShortDescription,
            onShowShortDescriptionChange: (value) => {
                state.showShortDescription = value;
                localStorage.setItem("showShortDescription", String(value));
                updateGrid();
            },
            onAddPath: addPath,
            onRemovePath: removePath,
            getFolders: () => api.getFolders(),
            onExport: exportBackup,
            onImport: importBackup,
            onAiEnabledChange: applyAiEnabledVisibility,
            onUpdateDb: updateDatabase,
            onFindDuplicates: () => openDuplicates(() => refreshUi()),
            getPageCacheSettings: () => api.getPageCacheSettings(),
            onPageCacheSettingsChange: (settings) => api.savePageCacheSettings(settings),
            onPurgePageCache: () => api.clearPageCache(),
        }));
    }

    // ==========================================
    // SIDEBAR CALLBACKS
    // ==========================================
    const handleFolderSelection = (path) => {
        if (state.viewMode === "trash") switchToLibrary();
        state.currentFilterPath = path;
        state.selectedBooks.clear(); // Reset selection khi đổi folder
        updateSelectionUI();
        updateGrid();
    };

    const handleDeleteFolder = (folderPath) => removePath(folderPath);

    async function removePath(folderPath) {
        try {
            const result = await api.removeFolder(folderPath);
            await refreshUi();
            const removedBooks = result?.removed_books || 0;
            setStatus(
                removedBooks > 0
                    ? `Path removed — ${removedBooks} book(s) removed from the library.`
                    : "Path removed.",
                "green"
            );
        } catch (err) {
            setStatus("Error removing path: " + err, "red");
        }
    }

    // ==========================================
    // TOOLBAR BUTTONS
    // ==========================================
    async function addPath() {
        const folder = await pickLibraryFolder(txtStatus);
        if (folder) {
            try {
                await api.addFolder(folder);
                await refreshUi();
                setStatus(`Folder added: ${folder}`, "green");
            } catch (err) {
                setStatus("Error adding folder: " + err, "red");
            }
        }
    }

    async function updateDatabase() {
        setStatus("Updating database...", "orange");
        progressWrap.style.display = "";
        progressFill.style.width = "0%";
        progressText.innerText = "Scanning files...";
        if (btnUpdateDB) btnUpdateDB.disabled = true;
        try {
            const result = await api.updateDatabase();
            await refreshUi();
            setStatus(result, "green");
        } catch (err) {
            setStatus("Error: " + err, "red");
            progressWrap.style.display = "none";
        } finally {
            if (btnUpdateDB) btnUpdateDB.disabled = false;
        }
    }

    if (btnUpdateDB) {
        btnUpdateDB.addEventListener("click", () => updateDatabase());
    }

    async function exportBackup() {
        try {
            const savePath = await window.__TAURI__.dialog.save({
                title: "Export Database",
                defaultPath: "pdf_library_backup.json",
                filters: [{ name: "JSON Backup", extensions: ["json"] }]
            });
            if (savePath) {
                const result = await api.exportDB(savePath);
                setStatus(result, "green");
                return result;
            }
            return null;
        } catch (err) {
            setStatus("Export error: " + err, "red");
            throw err;
        }
    }

    async function importBackup() {
        try {
            const srcPath = await window.__TAURI__.dialog.open({
                title: "Import Database",
                multiple: false,
                filters: [{ name: "JSON Backup", extensions: ["json"] }]
            });
            if (srcPath) {
                const result = await api.importDB(srcPath);
                await refreshUi();
                setStatus(result, "green");
                return result;
            }
            return null;
        } catch (err) {
            setStatus("Import error: " + err, "red");
            throw err;
        }
    }

    // ==========================================
    // DARK MODE TOGGLE
    // Lưu preference vào localStorage
    // ==========================================
    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        if (btnThemeToggle) {
            btnThemeToggle.innerText = theme === "dark" ? "☀️" : "🌙";
            btnThemeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
        }
        localStorage.setItem("theme", theme);
    }

    // Load saved theme on startup
    const savedTheme = localStorage.getItem("theme") || "light";
    applyTheme(savedTheme);

    if (btnThemeToggle) {
        btnThemeToggle.addEventListener("click", () => {
            const current = document.documentElement.getAttribute("data-theme") || "light";
            applyTheme(current === "dark" ? "light" : "dark");
        });
    }

    if (btnFindDuplicates) {
        btnFindDuplicates.addEventListener("click", () => {
            openDuplicates(() => refreshUi());
        });
    }

    if (btnAiAutoTag) {
        btnAiAutoTag.addEventListener("click", () => {
            const visibleBooks = state.books.filter(b => !b.hidden);
            openAiAutoTag(
                visibleBooks,
                state.selectedBooks,
                state.currentFilterPath,
                () => refreshUi()
            );
        });
    }

    // Nút "AI Auto-Tag" chỉ hiện khi AI được bật (toggle "Activate AI" trong AI Settings).
    // Khi ẩn đi, "Find Duplicates" bỏ full-width để tự trôi lên chiếm chỗ của nó
    // trong lưới 2 cột — tránh để lại 1 ô trống nhìn lệch.
    function applyAiEnabledVisibility(enabled) {
        if (btnAiAutoTag) btnAiAutoTag.style.display = enabled ? "" : "none";
        if (btnFindDuplicates) btnFindDuplicates.classList.toggle("full-width", enabled);
    }
    api.getAiSettings()
        .then(s => applyAiEnabledVisibility(s.enabled !== false))
        .catch(() => {});

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            state.currentSearch = searchInput.value;
            updateGrid();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener("change", () => {
            state.currentSort = sortSelect.value;
            updateGrid();
        });
    }

    if (tagSearchInput) {
        tagSearchInput.addEventListener("input", () => {
            renderTagsUI(tagContainer, tagSearchInput, state.tags, state.selectedTags,
                handleTagSelectionChange, handleTagRenamed, handleTagDeleted,
                state.untaggedOnly, handleUntaggedToggle);
        });
    }

    // ==========================================
    // TAG MANAGEMENT CALLBACKS
    // ==========================================
    function handleTagSelectionChange(newTags) {
        state.selectedTags = newTags;
        updateGrid();
    }

    function handleUntaggedToggle(newUntagged) {
        state.untaggedOnly = newUntagged;
        updateGrid();
    }

    async function handleTagRenamed(oldName, newName) {
        try {
            await api.renameTag(oldName, newName);
            await refreshUi();
            setStatus(`Tag "${oldName}" renamed to "${newName}".`, "green");
        } catch (err) {
            setStatus("Error renaming tag: " + err, "red");
        }
    }

    async function handleTagDeleted(tagName) {
        try {
            await api.deleteTag(tagName);
            await refreshUi();
            setStatus(`Tag "${tagName}" deleted from all books.`, "gray");
        } catch (err) {
            setStatus("Error deleting tag: " + err, "red");
        }
    }

    // ==========================================
    // CORE FUNCTIONS
    // ==========================================
    async function refreshUi() {
        state.books = await api.getBooks();
        state.tags  = await api.getTags();
        const paths = await api.getFolders();

        renderSidebar(sidebarContainer, paths, handleFolderSelection, handleDeleteFolder, state.books);
        renderTagsUI(tagContainer, tagSearchInput, state.tags, state.selectedTags,
            handleTagSelectionChange, handleTagRenamed, handleTagDeleted,
            state.untaggedOnly, handleUntaggedToggle);

        updateTrashButton();
        updateSelectionUI();
        updateGrid();
    }

    function updateGrid() {
        const visibleBooks = state.viewMode === "trash"
            ? state.books.filter(b => b.hidden)
            : state.books.filter(b => !b.hidden);

        renderAssetGrid(
            assetGridContainer,
            visibleBooks,
            state.currentFilterPath,
            state.currentSearch,
            state.currentSort,
            state.selectedTags,
            () => refreshUi(),
            state.viewMode,
            state.selectedBooks,
            (path, shiftKey) => toggleSelectBook(path, shiftKey),
            state.clickBehavior,
            state.untaggedOnly,
            state.showShortDescription
        );

        persistLastFilters();
        updateJumpLastButton();
    }

    // Mirrors the live filter state to localStorage on every grid re-render so
    // f_reader.js can snapshot "what was I looking at" into its own saved
    // reading position without importing main.js — see f_reading_history.js.
    function persistLastFilters() {
        writeCurrentFilters({
            currentFilterPath: state.currentFilterPath,
            currentSearch: state.currentSearch,
            currentSort: state.currentSort,
            selectedTags: state.selectedTags,
            untaggedOnly: state.untaggedOnly,
        });
    }

    function findBookByPath(path) {
        return state.books.find(b => b.path === path && !b.hidden) || null;
    }

    // The saved entries whose book still exists and isn't hidden/trashed —
    // what's actually offered, in {entry, book} pairs, most-recent first.
    function validLastReadEntries() {
        return readList()
            .map(entry => ({ entry, book: findBookByPath(entry.path) }))
            .filter(x => x.book);
    }

    // Only offered in Read Mode "open-reader" (per the feature's own scope —
    // multi-select/Manage mode has no use for a reading-position shortcut).
    function updateJumpLastButton() {
        closeJumpLastDropdown(); // contents may be stale after this refresh
        if (!btnJumpLast) return;
        const entries = validLastReadEntries();
        const show = state.clickBehavior === "open-reader" && entries.length > 0;
        btnJumpLast.style.display = show ? "" : "none";
        if (btnJumpLastArrow) btnJumpLastArrow.style.display = show ? "" : "none";
        if (show) {
            const { entry, book } = entries[0];
            btnJumpLast.title = `Continue reading "${book.file_name}" — page ${entry.page}`;
        }
    }

    // Marks the matching sidebar folder item active without a full sidebar
    // re-render — mirrors the data-path convention set in f_sidebar.js.
    function highlightActiveFolder(path) {
        if (!sidebarContainer) return;
        const target = path === null ? "all" : path;
        sidebarContainer.querySelectorAll(".sidebar-item").forEach(item => {
            item.classList.toggle("active", item.dataset.path === target);
        });
    }

    // Restores a saved entry's filters and opens the reader at its page —
    // shared by the main button (most recent) and each dropdown row (any of
    // the last few).
    function jumpToEntry(entry, book) {
        if (state.viewMode === "trash") switchToLibrary();

        const f = entry.filters || {};
        state.currentFilterPath = f.currentFilterPath ?? null;
        state.currentSearch = f.currentSearch ?? "";
        state.currentSort = f.currentSort ?? "name-asc";
        state.selectedTags = Array.isArray(f.selectedTags) ? f.selectedTags : [];
        state.untaggedOnly = !!f.untaggedOnly;
        state.selectedBooks.clear();

        if (searchInput) searchInput.value = state.currentSearch;
        if (sortSelect) sortSelect.value = state.currentSort;
        highlightActiveFolder(state.currentFilterPath);
        renderTagsUI(tagContainer, tagSearchInput, state.tags, state.selectedTags,
            handleTagSelectionChange, handleTagRenamed, handleTagDeleted,
            state.untaggedOnly, handleUntaggedToggle);
        updateSelectionUI();
        updateGrid();

        openReader(book, entry.page);
    }

    if (btnJumpLast) {
        btnJumpLast.addEventListener("click", () => {
            closeJumpLastDropdown();
            const entries = validLastReadEntries();
            if (!entries.length) {
                updateJumpLastButton(); // saved book(s) gone — hide and bail
                return;
            }
            jumpToEntry(entries[0].entry, entries[0].book);
        });
    }

    // ==========================================
    // "Continue reading" dropdown — last up-to-3 distinct books, each
    // showing its page and (if any were active for that session) its tags.
    // ==========================================
    let jumpLastDropdownEl = null;

    function closeJumpLastDropdown() {
        if (!jumpLastDropdownEl) return;
        jumpLastDropdownEl.remove();
        jumpLastDropdownEl = null;
        document.removeEventListener("mousedown", onJumpLastDropdownOutsideClick, true);
        document.removeEventListener("keydown", onJumpLastDropdownEscape, true);
    }

    function onJumpLastDropdownOutsideClick(e) {
        if (jumpLastDropdownEl && !jumpLastDropdownEl.contains(e.target) && e.target !== btnJumpLastArrow) {
            closeJumpLastDropdown();
        }
    }

    function onJumpLastDropdownEscape(e) {
        if (e.key === "Escape") closeJumpLastDropdown();
    }

    function openJumpLastDropdown() {
        closeJumpLastDropdown();
        const entries = validLastReadEntries();
        if (!entries.length || !btnJumpLastArrow) return;

        const panel = document.createElement("div");
        panel.className = "context-menu"; // reuse the existing popover look
        const rect = btnJumpLastArrow.getBoundingClientRect();
        panel.style.cssText = `
            position: fixed;
            top: ${rect.bottom + 4}px;
            left: ${rect.left}px;
            min-width: 220px;
            max-width: 320px;
            z-index: 10000;
        `;

        entries.forEach(({ entry, book }) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:6px; cursor:pointer;";
            row.addEventListener("mouseenter", () => row.style.background = "var(--hover)");
            row.addEventListener("mouseleave", () => row.style.background = "transparent");

            const textCol = document.createElement("div");
            textCol.style.cssText = "flex:1; min-width:0;";

            const titleEl = document.createElement("div");
            titleEl.style.cssText = "font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
            titleEl.innerText = `${book.file_name} — p.${entry.page}`;
            textCol.appendChild(titleEl);

            const tags = entry.filters?.selectedTags;
            if (Array.isArray(tags) && tags.length > 0) {
                const tagsEl = document.createElement("div");
                tagsEl.style.cssText = "font-size:11px; color:var(--text-secondary); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
                tagsEl.innerText = tags.join(", ");
                textCol.appendChild(tagsEl);
            }

            row.appendChild(textCol);

            // Pins this session so it's kept regardless of the normal
            // "last 3" rotation — same action as the reader toolbar's own
            // bookmark button (both go through f_reading_history.js).
            const bookmarkBtn = document.createElement("span");
            bookmarkBtn.innerText = "🔖";
            bookmarkBtn.title = entry.bookmarked ? "Remove bookmark" : "Bookmark this session";
            bookmarkBtn.style.cssText = `flex-shrink:0; cursor:pointer; font-size:14px; line-height:1; opacity:${entry.bookmarked ? "1" : "0.3"};`;
            bookmarkBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // don't also trigger the row's own jump-to click below
                toggleBookmark(entry.path);
                // Rebuild in place — simplest way to keep every row's icon
                // state and the button's own visibility/title all consistent.
                updateJumpLastButton();
                if (validLastReadEntries().length > 0) openJumpLastDropdown();
            });
            row.appendChild(bookmarkBtn);

            row.addEventListener("click", () => {
                closeJumpLastDropdown();
                jumpToEntry(entry, book);
            });

            panel.appendChild(row);
        });

        document.body.appendChild(panel);
        jumpLastDropdownEl = panel;

        // Safe to attach immediately (no defer needed): mousedown always fires
        // before the click that opened this dropdown, so this can't catch that
        // same click. Deferring it was actually a latent listener leak — if
        // something else called closeJumpLastDropdown() in between a deferred
        // attach and its scheduled run, the attach would still fire afterward
        // with jumpLastDropdownEl already null, leaving these listeners with
        // nothing left to ever remove them.
        document.addEventListener("mousedown", onJumpLastDropdownOutsideClick, true);
        document.addEventListener("keydown", onJumpLastDropdownEscape, true);
    }

    if (btnJumpLastArrow) {
        btnJumpLastArrow.addEventListener("click", (e) => {
            e.stopPropagation();
            if (jumpLastDropdownEl) closeJumpLastDropdown();
            else openJumpLastDropdown();
        });
    }

    function setStatus(msg, color = "inherit") {
        if (txtStatus) {
            txtStatus.innerText = msg;
            txtStatus.style.color = color;
        }
    }

    // ==========================================
    // KEYBOARD SHORTCUTS
    // ==========================================
    document.addEventListener("keydown", (e) => {
        // Bỏ qua khi đang focus vào input/textarea
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        // Escape — bỏ chọn tất cả
        if (e.key === "Escape") {
            clearSelection();
        }

        // Ctrl/Cmd + A — chọn tất cả đang hiện
        if ((e.ctrlKey || e.metaKey) && e.key === "a") {
            e.preventDefault();
            selectAllVisible();
        }

        // Ctrl/Cmd + F — focus ô tìm kiếm
        if ((e.ctrlKey || e.metaKey) && e.key === "f") {
            e.preventDefault();
            searchInput?.focus();
            searchInput?.select();
        }
    });

    // ==========================================
    // KHOI CHAY
    // ==========================================
    await refreshUi();

    // Nếu còn sót file auto-backup từ lần "Update DB" trước (bị gián đoạn
    // giữa chừng) → hỏi user có muốn khôi phục không.
    try {
        const backupInfo = await api.checkAutoBackup();
        if (backupInfo) {
            openAutoBackupPrompt(backupInfo, {
                onRestore: async () => {
                    try {
                        const result = await api.restoreAutoBackup();
                        await refreshUi();
                        setStatus(result, "green");
                    } catch (err) {
                        setStatus("Error restoring backup: " + err, "red");
                    }
                },
                onDiscard: async () => {
                    try {
                        await api.discardAutoBackup();
                        setStatus("Backup discarded.", "gray");
                    } catch (err) {
                        setStatus("Error discarding backup: " + err, "red");
                    }
                },
            });
        }
    } catch (err) {
        console.error("Error checking auto backup:", err);
    }
});