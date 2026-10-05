import { createCard } from "./ui_grid_card.js";
import { showCardContextMenu, openEditModal, openBulkTagModal } from "./ui_grid_menu.js";
import { openReader } from "./f_reader.js";
import { isInFolder } from "./ui.js";

// =============================================
// GRID STATE — giữ trạng thái giữa các batch
// =============================================
let observer = null;

let gridState = {
    container: null,
    filteredBooks: [],
    displayCount: 0,
    pageSize: 50,
    viewMode: "library",
    detailed: false,      // true = card ngang có short description
    cardMap: {},
    lastClickedIndex: -1  // Lưu index card click lần trước để shift select
};

export function renderAssetGrid(
    container, books, filterPath, search, sort, selectedTags,
    onGridUpdate, viewMode = "library",
    selectedBooks = new Set(), onToggleSelect = null, clickBehavior = "select",
    untaggedOnly = false, showShortDescription = false
) {
    if (observer) observer.disconnect();

    gridState.container = container;
    gridState.filteredBooks = applyFilters(books, filterPath, search, sort, selectedTags, untaggedOnly);
    gridState.displayCount = 0;
    gridState.viewMode = viewMode;
    gridState.detailed = showShortDescription;
    container.classList.toggle("asset-grid--detailed", showShortDescription);
    gridState.cardMap = {};
    gridState.lastClickedIndex = -1;
    container.innerHTML = "";

    if (gridState.filteredBooks.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "padding:24px; color:var(--text-secondary); font-size:14px;";
        empty.innerText = viewMode === "trash" ? "Trash is empty." : "No books found.";
        container.appendChild(empty);
        return;
    }

    renderNextBatch(onGridUpdate, selectedBooks, onToggleSelect, clickBehavior);
}

function renderNextBatch(onGridUpdate, selectedBooks, onToggleSelect, clickBehavior) {
    const { container, filteredBooks, displayCount, pageSize, viewMode, detailed } = gridState;
    const end = Math.min(displayCount + pageSize, filteredBooks.length);

    for (let i = displayCount; i < end; i++) {
        const book = filteredBooks[i];
        const isSelected = selectedBooks.has(book.path);

        const card = createCard(
            book,
            (openedBook) => openReader(openedBook),
            (x, y, b) => showCardContextMenu(x, y, b, onGridUpdate, viewMode, selectedBooks),
            isSelected,
            onToggleSelect,
            clickBehavior,
            (editedBook) => {
                // Double-clicking a book that's part of a multi-selection edits
                // tags for the whole selection, matching the right-click menu.
                const isBulk = selectedBooks.size > 1 && selectedBooks.has(editedBook.path);
                if (isBulk) openBulkTagModal([...selectedBooks], onGridUpdate);
                else openEditModal(editedBook, onGridUpdate);
            },
            detailed
        );

        gridState.cardMap[book.path] = card;
        container.appendChild(card);
    }

    gridState.displayCount = end;

    const oldSentinel = container.querySelector(".grid-sentinel");
    if (oldSentinel) oldSentinel.remove();

    if (end < filteredBooks.length) {
        const sentinel = document.createElement("div");
        sentinel.className = "grid-sentinel";
        sentinel.style.height = "50px";
        container.appendChild(sentinel);

        observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                renderNextBatch(onGridUpdate, selectedBooks, onToggleSelect, clickBehavior);
            }
        }, { rootMargin: "200px" });

        observer.observe(sentinel);
    }
}

export function updateCardSelectionVisual(path, isSelected) {
    const card = gridState.cardMap[path];
    if (card && typeof card.setSelected === "function") {
        card.setSelected(isSelected);
    }
}

// Trả về danh sách paths trong range [fromIndex, toIndex]
// Dùng cho shift+click select nhiều card cùng lúc
export function getShiftSelectRange(fromIndex, toIndex) {
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    return gridState.filteredBooks
        .slice(start, end + 1)
        .map(b => b.path);
}

// Lấy index của 1 book trong filteredBooks
export function getBookIndex(path) {
    return gridState.filteredBooks.findIndex(b => b.path === path);
}

// Lưu index card vừa click (để dùng cho shift+click tiếp theo)
export function setLastClickedIndex(index) {
    gridState.lastClickedIndex = index;
}

export function getLastClickedIndex() {
    return gridState.lastClickedIndex;
}

// Trả về paths của tất cả sách trong filteredBooks hiện tại
// Dùng cho selectAllVisible trong main.js — đảm bảo respect folder/search/tag filter
export function getFilteredPaths() {
    return gridState.filteredBooks.map(b => b.path);
}

function applyFilters(books, filterPath, search, sort, selectedTags, untaggedOnly) {
    let result = books;

    // 1. Filter theo folder (null = All Documents)
    if (filterPath) {
        result = result.filter(b => isInFolder(b.path, filterPath));
    }

    // 2. Filter theo search
    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        result = result.filter(b =>
            b.file_name.toLowerCase().includes(q) ||
            (b.short_description || "").toLowerCase().includes(q) ||
            (b.description || "").toLowerCase().includes(q));
    }

    // 3. Filter theo tags (AND logic) — hoặc chỉ lấy sách chưa có tag nào,
    // 2 kiểu lọc này loại trừ lẫn nhau (chọn "No tags" là bỏ qua selectedTags).
    if (untaggedOnly) {
        result = result.filter(b => !b.tags || b.tags.length === 0);
    } else if (selectedTags && selectedTags.length > 0) {
        result = result.filter(b => {
            const tags = (b.tags || []).map(t => t.toLowerCase());
            return selectedTags.every(st => tags.includes(st.toLowerCase()));
        });
    }

    // 4. Sort — starred LUÔN lên đầu bất chấp sort kiểu gì.
    // Ngoại lệ "missing-*": sách thiếu description lên đầu trước, rồi mới tới starred,
    // để sách có starred mà đã có description không chen lên trên những sách cần điền
    const byName = (a, b) => a.file_name.toLowerCase().localeCompare(b.file_name.toLowerCase());
    const missing = (field) => (a, b) => !(a[field] || "").trim() - !(b[field] || "").trim();
    const comparators = {
        "name-desc": (a, b) => byName(b, a),
        "date-desc": (a, b) => (b.date_added || 0) - (a.date_added || 0),
        "date-asc": (a, b) => (a.date_added || 0) - (b.date_added || 0),
    };
    const starredFirst = (a, b) => !!b.starred - !!a.starred;
    const descField = { "missing-short": "short_description", "missing-long": "description" }[sort];
    const chain = descField
        ? [(a, b) => -missing(descField)(a, b), starredFirst, byName]
        : [starredFirst, comparators[sort] || byName];
    return [...result].sort((a, b) => {
        for (const cmp of chain) {
            const d = cmp(a, b);
            if (d) return d;
        }
        return 0;
    });
}
