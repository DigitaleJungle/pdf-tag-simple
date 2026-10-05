import { api } from "./features/api.js";
import { renderSidebar } from "./features/f_sidebar.js";
import { renderAssetGrid, updateCardSelectionVisual, getShiftSelectRange, getBookIndex, setLastClickedIndex, getLastClickedIndex, getFilteredPaths } from "./features/f_grid.js";
import { renderTagsUI } from "./features/f_tags.js";
import { openEditModal } from "./features/ui_grid_menu.js";
import { pickLibraryFolder } from "./features/f_addfolder.js";
import { openAiAutoTag } from "./features/f_ai.js";
import { openDuplicates } from "./features/f_duplicates.js";
import { openSettings, BEHAVIOURS } from "./features/f_settings.js";
import { openAutoBackupPrompt } from "./features/f_backup_prompt.js";
import { openReader } from "./features/f_reader.js";
import { openSummaryPanel, refreshSummaryPanel, closeSummaryPanel } from "./features/f_summary.js";
import { readList, toggleBookmark, writeCurrentFilters } from "./features/f_reading_history.js";
import { el, showMenu, bindMenuButton, overlayOpen } from "./features/ui.js";

// ==========================================
// STATE
// ==========================================
let state = {
    books: [],               // Toàn bộ sách (cả hidden) — lấy từ backend
    tags: [],                // Tags để render sidebar (chỉ của sách không hidden)
    selectedTags: [],        // Tags đang filter
    untaggedOnly: false,     // Lọc riêng sách chưa có tag nào — loại trừ với selectedTags
    currentFilterPath: null, // Folder đang chọn trong sidebar (null = All Documents)
    currentSearch: "",       // Nội dung ô tìm kiếm
    currentSort: "name-asc", // Kiểu sắp xếp
    viewMode: "library",     // "library" | "trash"
    selectedBooks: new Set(), // Set<path> — sách đang được multi-select
    clickBehavior: localStorage.getItem("clickBehavior") || "select", // xem BEHAVIOURS (f_settings.js)
    showShortDescription: localStorage.getItem("showShortDescription") === "true" // card ngang có short description
};

// ==========================================
// MAIN
// ==========================================
window.addEventListener("DOMContentLoaded", async () => {

    // --- DOM Elements (tất cả có sẵn trong index.html) ---
    const $ = (selector) => document.querySelector(selector);
    const sidebarContainer    = $("#sidebar-folders");
    const assetGridContainer  = $("#asset-grid");
    const tagContainer        = $("#tag-list-container");
    const tagSearchInput      = $("#tag-search-input");
    const txtStatus           = $("#txt-status");
    const searchInput         = $("#search-input");
    const sortSelect          = $("#sort-select");

    // Toolbar buttons
    const btnUpdateDB         = $("#btn-update-db");
    const btnAiAutoTag        = $("#btn-ai-autotag");
    const btnFindDuplicates   = $("#btn-find-duplicates");
    const btnThemeToggle      = $("#btn-theme-toggle");
    const btnToggleSidebar    = $("#btn-toggle-sidebar");
    const btnCardSizeToggle   = $("#btn-card-size-toggle");
    const btnBehaviour        = $("#btn-behaviour");

    // Selection + trash buttons
    const btnTrashView        = $("#btn-trash-view");
    const txtTrashCount       = $("#txt-trash-count");
    const btnSettings         = $("#btn-settings");
    const txtSelectionCount   = $("#txt-selection-count");
    const btnBulkHide         = $("#btn-bulk-hide");
    const btnBulkRestore      = $("#btn-bulk-restore");
    const btnClearSelection   = $("#btn-clear-selection");
    const btnSelectAll        = $("#btn-select-all");
    const btnJumpLast         = $("#btn-jump-last");
    const btnJumpLastArrow    = $("#btn-jump-last-arrow");

    // ==========================================
    // PROGRESS BAR — lắng nghe event từ backend
    // Backend emit "scan_progress" sau mỗi thumbnail render
    // Payload: { current, total, file_name, done }
    // ==========================================
    const scanProgress = $("#scan-progress");
    const progressBar = scanProgress.querySelector("progress");
    const progressText = scanProgress.querySelector(".hint");

    window.__TAURI__.event.listen("scan_progress", (event) => {
        const { current, total, file_name, done } = event.payload;
        if (done || total === 0) {
            // Hoàn thành — ẩn progress bar
            progressBar.value = 1;
            setTimeout(() => {
                scanProgress.hidden = true;
                progressBar.value = 0;
            }, 800);
            return;
        }
        scanProgress.hidden = false;
        progressBar.value = current / total;
        progressText.innerText = `Rendering thumbnails: ${current}/${total} — ${file_name}`;
    });

    // ==========================================
    // APP ACTIONS — đăng ký để ui_grid_menu.js / f_reader.js / f_summary.js gọi
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
            return state.books.find(b => b.path === paths[idx + direction]) || null;
        },
        // Gọi từ f_reader.js — lấy sách đầu/cuối (edge: "first" | "last")
        // theo đúng thứ tự đang hiện trong grid, dùng cho nút "first/last" trong reader.
        getBoundaryBook: (edge) => {
            const paths = getFilteredPaths();
            const targetPath = edge === "first" ? paths[0] : paths[paths.length - 1];
            return state.books.find(b => b.path === targetPath) || null;
        },
        // Gọi từ f_reader.js khi reader đóng — refresh label/visibility của nút
        // "Continue reading" (nó có thể đã lưu 1 vị trí mới trong lúc đọc).
        onReaderClosed: () => updateJumpLastButton(),
        // Gọi từ ui_grid_card.js khi Behaviour = "Summary view"
        openSummary: (book) => {
            openSummaryPanel(state.books.find(b => b.path === book.path) || book, {
                onRead: (b) => openReader(b),
                onEdit: (b) => openEditModal(b, () => refreshUi()),
                onStarChanged: () => updateGrid(),
                onAi: (b) => window.__APP_ACTIONS__.runAiOnBooks([b.path]),
                onNavigate: (b, dir) => {
                    const next = window.__APP_ACTIONS__.getAdjacentBook(b.path, dir);
                    if (next) window.__APP_ACTIONS__.openSummary(next);
                },
            });
        },
        // "Activate AI" trong AI Settings — summary panel / context menu dùng để hiện nút AI
        isAiEnabled: () => state.aiEnabled !== false,
        // Mở cửa sổ AI auto với đúng những sách này (scope mặc định = "Selected books")
        runAiOnBooks: (paths) => openAi(new Set(paths)),
    };

    function openAi(selected) {
        openAiAutoTag(state.books.filter(b => !b.hidden), selected, state.currentFilterPath, () => refreshUi());
    }

    // ==========================================
    // MULTI-SELECT
    // ==========================================

    // Toggle select 1 sách
    // Nếu shiftKey = true → select range từ lastClickedIndex đến index hiện tại
    function toggleSelectBook(path, shiftKey = false) {
        const currentIndex = getBookIndex(path);

        if (shiftKey && getLastClickedIndex() >= 0) {
            // Shift+click → select tất cả cards trong range
            getShiftSelectRange(getLastClickedIndex(), currentIndex).forEach(p => {
                state.selectedBooks.add(p);
                updateCardSelectionVisual(p, true);
            });
        } else {
            // Click thường → toggle 1 card
            const selected = !state.selectedBooks.has(path);
            if (selected) state.selectedBooks.add(path);
            else state.selectedBooks.delete(path);
            updateCardSelectionVisual(path, selected);
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
        txtSelectionCount.innerText = `${count} selected`;

        // Multi-select doesn't apply in a Read Mode (click opens the PDF instead
        // of selecting it), so hide the selection count and "Select all" there.
        const isReadMode = state.clickBehavior !== "select";
        txtSelectionCount.style.display = isReadMode ? "none" : "";
        btnSelectAll.style.display      = isReadMode ? "none" : "";

        const hasSelection = count > 0;
        btnBulkHide.style.display       = (hasSelection && state.viewMode === "library") ? "" : "none";
        btnBulkRestore.style.display    = (hasSelection && state.viewMode === "trash")   ? "" : "none";
        btnClearSelection.style.display = hasSelection ? "" : "none";
    }

    async function bulkAction(apiCall, message, color) {
        if (state.selectedBooks.size === 0) return;
        const paths = [...state.selectedBooks];
        for (const path of paths) await apiCall(path);
        state.selectedBooks.clear();
        await refreshUi();
        setStatus(`${paths.length} book(s) ${message}.`, color);
    }
    btnBulkHide.addEventListener("click", () => bulkAction(api.hideBook, "hidden", "gray"));
    btnBulkRestore.addEventListener("click", () => bulkAction(api.restoreBook, "restored", "green"));
    btnSelectAll.addEventListener("click", selectAllVisible);
    btnClearSelection.addEventListener("click", clearSelection);

    // ==========================================
    // THÙNG RÁC
    // ==========================================
    function updateTrashButton() {
        const count = state.books.filter(b => b.hidden).length;
        txtTrashCount.innerText = count;
        if (count === 0 && state.viewMode === "trash") switchToLibrary();
        btnTrashView.disabled = count === 0; // styles.css: #btn-trash-view:disabled
    }

    function switchToTrash() {
        state.viewMode = "trash";
        state.currentFilterPath = null;
        state.selectedTags = [];
        state.selectedBooks.clear();
        btnTrashView.style.background = "var(--danger-soft)";
        btnTrashView.style.borderColor = "var(--danger)";
        btnTrashView.style.color = "var(--danger)";
        updateSelectionUI();
        updateGrid();
    }

    function switchToLibrary() {
        state.viewMode = "library";
        state.selectedBooks.clear();
        btnTrashView.style.background = "";
        btnTrashView.style.borderColor = "";
        btnTrashView.style.color = "";
        updateSelectionUI();
        updateGrid();
    }

    btnTrashView.addEventListener("click", () => {
        if (state.viewMode === "trash") switchToLibrary();
        else switchToTrash();
    });

    btnSettings.addEventListener("click", () => openSettings({
        clickBehavior: state.clickBehavior,
        onClickBehaviorChange: (value) => setClickBehavior(value),
        showShortDescription: state.showShortDescription,
        onShowShortDescriptionChange: (value) => setLargeCards(value),
        onAddPath: addPath,
        onRemovePath: removePath,
        onExport: exportBackup,
        onImport: importBackup,
        onAiEnabledChange: applyAiEnabledVisibility,
        onUpdateDb: updateDatabase,
        onFindDuplicates: () => openDuplicates(() => refreshUi()),
    }));

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

    async function removePath(folderPath) {
        try {
            const result = await api.removeFolder(folderPath);
            await refreshUi();
            setStatus(
                result.removed_books > 0
                    ? `Path removed — ${result.removed_books} book(s) removed from the library.`
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
        if (!folder) return;
        try {
            await api.addFolder(folder);
            await refreshUi();
            setStatus(`Folder added: ${folder}`, "green");
        } catch (err) {
            setStatus("Error adding folder: " + err, "red");
        }
    }

    async function updateDatabase() {
        setStatus("Updating database...", "orange");
        scanProgress.hidden = false;
        progressBar.value = 0;
        progressText.innerText = "Scanning files...";
        btnUpdateDB.disabled = true;
        try {
            const result = await api.updateDatabase();
            await refreshUi();
            setStatus(result, "green");
        } catch (err) {
            setStatus("Error: " + err, "red");
            scanProgress.hidden = true;
        } finally {
            btnUpdateDB.disabled = false;
        }
    }

    btnUpdateDB.addEventListener("click", () => updateDatabase());

    const BACKUP_FILTERS = [{ name: "JSON Backup", extensions: ["json"] }];

    async function exportBackup() {
        try {
            const savePath = await window.__TAURI__.dialog.save({
                title: "Export Database",
                defaultPath: "pdf_library_backup.json",
                filters: BACKUP_FILTERS
            });
            if (!savePath) return null;
            const result = await api.exportDB(savePath);
            setStatus(result, "green");
            return result;
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
                filters: BACKUP_FILTERS
            });
            if (!srcPath) return null;
            const result = await api.importDB(srcPath);
            await refreshUi();
            setStatus(result, "green");
            return result;
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
        btnThemeToggle.innerText = theme === "dark" ? "☀️" : "🌙";
        btnThemeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
        localStorage.setItem("theme", theme);
    }

    applyTheme(localStorage.getItem("theme") || "light");
    btnThemeToggle.addEventListener("click", () => {
        applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });

    // ==========================================
    // BEHAVIOUR — dùng chung cho Settings và nút Behaviour trên toolbar
    // ==========================================
    function setClickBehavior(value) {
        state.clickBehavior = value;
        localStorage.setItem("clickBehavior", value);
        if (value !== "summary") closeSummaryPanel();
        updateBehaviourButton();
        updateSelectionUI();
        updateGrid();
    }

    // Nút Behaviour trên toolbar: hiện chế độ hiện tại, click mở menu chọn 1 trong 4
    function updateBehaviourButton() {
        const current = BEHAVIOURS.find(c => c.value === state.clickBehavior) || BEHAVIOURS[0];
        btnBehaviour.innerText = `${current.label} ▾`;
        btnBehaviour.title = `Behaviour: ${current.label} — ${current.hint}`;
    }
    bindMenuButton(btnBehaviour, () => {
        const menu = showMenu(BEHAVIOURS.map(choice => {
            const selected = choice.value === state.clickBehavior;
            const content = el("span");
            content.style.cssText = "display:flex; gap:8px;";
            content.innerHTML = `<span style="width:14px; color:var(--primary);">${selected ? "✓" : ""}</span>
                <span><div style="font-weight:${selected ? 600 : 500};">${choice.label}</div>
                <div class="hint">${choice.hint}</div></span>`;
            return { content, action: () => { if (!selected) setClickBehavior(choice.value); } };
        }), btnBehaviour);
        menu.style.minWidth = "230px";
    });
    updateBehaviourButton();

    // ==========================================
    // CARD NHỎ / CARD LỚN — dùng chung cho Settings ("Show short description") và nút trên toolbar
    // ==========================================
    const ICON_LARGE_CARDS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/></svg>';
    const ICON_SMALL_CARDS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    function setLargeCards(value) {
        state.showShortDescription = value;
        localStorage.setItem("showShortDescription", String(value));
        updateCardSizeToggle();
        updateGrid();
    }
    // Icon cho biết bấm vào sẽ chuyển sang kiểu nào
    function updateCardSizeToggle() {
        const large = state.showShortDescription;
        btnCardSizeToggle.innerHTML = large ? ICON_SMALL_CARDS : ICON_LARGE_CARDS;
        btnCardSizeToggle.title = large ? "Switch to small cards" : "Switch to large cards (with short description)";
    }
    btnCardSizeToggle.addEventListener("click", () => setLargeCards(!state.showShortDescription));
    updateCardSizeToggle();

    // ==========================================
    // SIDEBAR THU GỌN — nhớ trạng thái qua localStorage
    // ==========================================
    const appShell = $(".app-shell");
    function setSidebarCollapsed(collapsed) {
        appShell.classList.toggle("sidebar-collapsed", collapsed);
        btnToggleSidebar.title = collapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)";
        localStorage.setItem("sidebarCollapsed", String(collapsed));
    }
    function toggleSidebar() {
        setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed"));
    }
    setSidebarCollapsed(localStorage.getItem("sidebarCollapsed") === "true");
    btnToggleSidebar.addEventListener("click", toggleSidebar);

    btnFindDuplicates.addEventListener("click", () => openDuplicates(() => refreshUi()));
    btnAiAutoTag.addEventListener("click", () => openAi(state.selectedBooks));

    // Nút "AI Auto-Tag" chỉ hiện khi AI được bật (toggle "Activate AI" trong AI Settings).
    // Khi ẩn đi, "Find Duplicates" bỏ full-width để tự trôi lên chiếm chỗ của nó
    // trong lưới 2 cột — tránh để lại 1 ô trống nhìn lệch.
    function applyAiEnabledVisibility(enabled) {
        state.aiEnabled = enabled;
        btnAiAutoTag.style.display = enabled ? "" : "none";
        btnFindDuplicates.classList.toggle("full-width", enabled);
        // Nút "AI auto" trong summary panel hiện/ẩn theo trạng thái này
        refreshSummaryPanel(state.books);
    }
    api.getAiSettings()
        .then(s => applyAiEnabledVisibility(s.enabled !== false))
        .catch(() => {});

    searchInput.addEventListener("input", () => {
        state.currentSearch = searchInput.value;
        updateGrid();
    });

    sortSelect.addEventListener("change", () => {
        state.currentSort = sortSelect.value;
        updateGrid();
    });

    tagSearchInput.addEventListener("input", renderTags);

    // ==========================================
    // TAG MANAGEMENT CALLBACKS
    // ==========================================
    function renderTags() {
        renderTagsUI(tagContainer, tagSearchInput, state.tags, state.selectedTags,
            (newTags) => { state.selectedTags = newTags; updateGrid(); },
            handleTagRenamed, handleTagDeleted,
            state.untaggedOnly, (newUntagged) => { state.untaggedOnly = newUntagged; updateGrid(); });
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

        renderSidebar(sidebarContainer, paths, handleFolderSelection, removePath, state.books);
        renderTags();

        updateTrashButton();
        updateSelectionUI();
        updateGrid();
        refreshSummaryPanel(state.books);
    }

    function updateGrid() {
        const visibleBooks = state.books.filter(b => b.hidden === (state.viewMode === "trash"));

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

        // Mirrors the live filter state to localStorage on every grid re-render so
        // f_reader.js can snapshot "what was I looking at" into its own saved
        // reading position without importing main.js — see f_reading_history.js.
        writeCurrentFilters({
            currentFilterPath: state.currentFilterPath,
            currentSearch: state.currentSearch,
            currentSort: state.currentSort,
            selectedTags: state.selectedTags,
            untaggedOnly: state.untaggedOnly,
        });
        updateJumpLastButton();
    }

    // The saved entries whose book still exists and isn't hidden/trashed —
    // what's actually offered, in {entry, book} pairs, most-recent first.
    function validLastReadEntries() {
        return readList()
            .map(entry => ({ entry, book: state.books.find(b => b.path === entry.path && !b.hidden) }))
            .filter(x => x.book);
    }

    // Only offered in Read Mode "open-reader" (per the feature's own scope —
    // multi-select/Manage mode has no use for a reading-position shortcut).
    function updateJumpLastButton() {
        const entries = validLastReadEntries();
        const show = state.clickBehavior === "open-reader" && entries.length > 0;
        btnJumpLast.style.display = show ? "" : "none";
        btnJumpLastArrow.style.display = show ? "" : "none";
        if (show) {
            const { entry, book } = entries[0];
            btnJumpLast.title = `Continue reading "${book.file_name}" — page ${entry.page}`;
        }
    }

    // Marks the matching sidebar folder item active without a full sidebar
    // re-render — mirrors the data-path convention set in f_sidebar.js.
    function highlightActiveFolder(path) {
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

        searchInput.value = state.currentSearch;
        sortSelect.value = state.currentSort;
        highlightActiveFolder(state.currentFilterPath);
        renderTags();
        updateSelectionUI();
        updateGrid();

        openReader(book, entry.page);
    }

    btnJumpLast.addEventListener("click", () => {
        const entries = validLastReadEntries();
        if (!entries.length) {
            updateJumpLastButton(); // saved book(s) gone — hide and bail
            return;
        }
        jumpToEntry(entries[0].entry, entries[0].book);
    });

    // ==========================================
    // "Continue reading" dropdown — last up-to-3 distinct books, each
    // showing its page and (if any were active for that session) its tags.
    // ==========================================
    function openJumpLastDropdown() {
        const entries = validLastReadEntries();
        if (!entries.length) return;

        const menu = showMenu(entries.map(({ entry, book }) => {
            const content = el("span");
            content.style.cssText = "display:flex; align-items:center; gap:8px; flex:1; min-width:0;";
            const textCol = el("div");
            textCol.style.cssText = "flex:1; min-width:0;";
            const ellipsis = "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
            const titleEl = el("div", "", `${book.file_name} — p.${entry.page}`);
            titleEl.style.cssText = ellipsis;
            textCol.appendChild(titleEl);

            const tags = entry.filters?.selectedTags;
            if (Array.isArray(tags) && tags.length > 0) {
                const tagsEl = el("div", "hint", tags.join(", "));
                tagsEl.style.cssText = "margin-top:2px;" + ellipsis;
                textCol.appendChild(tagsEl);
            }

            // Pins this session so it's kept regardless of the normal
            // "last 3" rotation — same action as the reader toolbar's own
            // bookmark button (both go through f_reading_history.js).
            const bookmarkBtn = el("span", "", "🔖");
            bookmarkBtn.title = entry.bookmarked ? "Remove bookmark" : "Bookmark this session";
            bookmarkBtn.style.cssText = `flex-shrink:0; cursor:pointer; font-size:14px; line-height:1; opacity:${entry.bookmarked ? "1" : "0.3"};`;
            bookmarkBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // don't also trigger the row's own jump-to click
                toggleBookmark(entry.path);
                // Rebuild in place — simplest way to keep every row's icon
                // state and the button's own visibility/title all consistent.
                menu.hidePopover();
                updateJumpLastButton();
                openJumpLastDropdown();
            });

            content.append(textCol, bookmarkBtn);
            return { content, action: () => jumpToEntry(entry, book) };
        }), btnJumpLastArrow);
        menu.style.minWidth = "220px";
        menu.style.maxWidth = "320px";
    }
    bindMenuButton(btnJumpLastArrow, openJumpLastDropdown);

    function setStatus(msg, color = "inherit") {
        txtStatus.innerText = msg;
        txtStatus.style.color = color;
    }

    // ==========================================
    // KEYBOARD SHORTCUTS
    // ==========================================
    document.addEventListener("keydown", (e) => {
        // Bỏ qua khi đang gõ trong input/textarea, hoặc khi modal / menu đang mở
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || overlayOpen()) return;

        // Escape — bỏ chọn tất cả
        if (e.key === "Escape") {
            clearSelection();
        }

        // Ctrl/Cmd + A — chọn tất cả đang hiện
        if ((e.ctrlKey || e.metaKey) && e.key === "a") {
            e.preventDefault();
            selectAllVisible();
        }

        // Ctrl/Cmd + B — thu gọn / mở sidebar
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            toggleSidebar();
        }

        // Ctrl/Cmd + F — focus ô tìm kiếm
        if ((e.ctrlKey || e.metaKey) && e.key === "f") {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
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
