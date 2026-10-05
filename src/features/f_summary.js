import { api } from "./api.js";
import { addCover, overlayOpen } from "./ui.js";

// =============================================
// f_summary.js — Summary panel bên phải (Behaviour = "Summary view")
//
// Export:
//   openSummaryPanel(book, actions) — mở panel (hoặc đổi sang sách khác)
//     actions.onRead(book)          — mở trong reader
//     actions.onEdit(book)          — mở "Edit details"
//     actions.onStarChanged()       — sau khi toggle star (refresh grid)
//     actions.onAi(book)            — mở cửa sổ AI auto cho riêng sách này (chỉ hiện khi AI bật)
//   refreshSummaryPanel(books)      — gọi sau refreshUi: cập nhật dữ liệu sách đang hiện,
//                                     đóng panel nếu sách không còn (bị xóa / vào thùng rác)
//   closeSummaryPanel()
//   isSummaryPanelOpen()
//   summaryBookPath()               — path của sách đang hiện (null nếu đóng)
//   mountSummaryPanel(container)    — chuyển panel vào container khác (vd reader), null = về app-shell
//
//   actions.onRead không có → ẩn nút "Read" (vd khi panel nằm trong reader)
//   actions.onUserClose()           — user bấm × (để reader nhớ trạng thái đóng)
//   actions.onNavigate(book, dir)   — nút ‹ › (dir = -1 | 1): chuyển sang sách trước/sau
//                                     (nút ẩn nếu không có, mờ khi đã ở đầu/cuối danh sách)
// =============================================

let currentBook = null;
let currentActions = null;
// Số trang / dung lượng theo path — khỏi hỏi lại backend mỗi lần render
const fileInfoCache = new Map();

// Độ rộng panel kéo được, nhớ qua localStorage
const MIN_PANEL_WIDTH = 280;
const DEFAULT_PANEL_WIDTH = 340;
function savedPanelWidth() {
    try {
        const w = parseInt(localStorage.getItem("summaryPanelWidth"));
        return Number.isFinite(w) ? w : DEFAULT_PANEL_WIDTH;
    } catch {
        return DEFAULT_PANEL_WIDTH;
    }
}
// Giữ lại ít nhất ~400px cho grid sách
function clampPanelWidth(w) {
    const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 400);
    return Math.min(max, Math.max(MIN_PANEL_WIDTH, Math.round(w)));
}
function applyPanelWidth(panel, w) {
    panel.style.width = `${w}px`;
    panel.style.minWidth = `${w}px`;
}

function panelEl() {
    return document.querySelector("#summary-panel");
}

export function isSummaryPanelOpen() {
    return currentBook !== null;
}

export function summaryBookPath() {
    return currentBook ? currentBook.path : null;
}

// Cùng 1 element panel được dùng ở grid và trong reader — chỉ đổi chỗ trong DOM
export function mountSummaryPanel(container) {
    const panel = panelEl();
    const target = container || document.querySelector(".app-shell");
    if (panel && target && panel.parentElement !== target) target.appendChild(panel);
}

export function openSummaryPanel(book, actions) {
    const panel = panelEl();
    if (!panel || !book) return;
    const sameBook = currentBook?.path === book.path;
    currentBook = book;
    currentActions = actions || {};
    render(!sameBook);
    applyPanelWidth(panel, clampPanelWidth(savedPanelWidth()));
    panel.classList.add("open");
}

export function closeSummaryPanel() {
    const panel = panelEl();
    currentBook = null;
    currentActions = null;
    if (panel) {
        panel.classList.remove("open");
        panel.style.width = "";
        panel.style.minWidth = "";
        panel.innerHTML = "";
    }
}

export function refreshSummaryPanel(books) {
    if (!currentBook) return;
    const updated = (books || []).find(b => b.path === currentBook.path);
    if (!updated || updated.hidden) {
        closeSummaryPanel();
        return;
    }
    currentBook = updated;
    render(false);
}

// Esc đóng panel (trừ khi đang có modal / reader mở phía trên)
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !currentBook) return;
    if (overlayOpen() || document.querySelector(".pdf-reader-overlay")) return;
    closeSummaryPanel();
});

// reloadThumb = false khi chỉ cập nhật dữ liệu (giữ ảnh bìa đang hiện, khỏi nháy)
function render(reloadThumb) {
    const panel = panelEl();
    const book = currentBook;
    if (!panel || !book) return;

    const oldThumb = reloadThumb ? null : panel.querySelector(".summary-cover");
    panel.innerHTML = "";
    panel.appendChild(makeResizer(panel));

    // Header: tiêu đề "Summary" + nút đóng
    const header = document.createElement("div");
    header.className = "summary-header";
    const heading = document.createElement("div");
    heading.className = "summary-heading";
    heading.innerText = "Summary";
    const closeBtn = document.createElement("button");
    closeBtn.className = "summary-close";
    closeBtn.innerText = "×";
    closeBtn.title = "Close (Esc)";
    closeBtn.onclick = () => {
        const onUserClose = currentActions?.onUserClose;
        closeSummaryPanel();
        if (typeof onUserClose === "function") onUserClose();
    };
    // ‹ › — sách trước/sau theo đúng thứ tự đang hiện trong grid
    const headerRight = document.createElement("div");
    headerRight.style.cssText = "display:flex; align-items:center; gap:6px;";
    if (typeof currentActions?.onNavigate === "function") {
        const getAdjacent = (dir) => window.__APP_ACTIONS__?.getAdjacentBook?.(book.path, dir) || null;
        [[-1, "‹", "Previous book"], [1, "›", "Next book"]].forEach(([dir, label, tip]) => {
            const btn = document.createElement("button");
            btn.className = "summary-close summary-nav";
            btn.innerText = label;
            btn.title = tip;
            if (!getAdjacent(dir)) {
                btn.disabled = true;
                btn.style.opacity = "0.35";
                btn.style.cursor = "default";
            }
            btn.onclick = () => currentActions?.onNavigate?.(book, dir);
            headerRight.appendChild(btn);
        });
    }
    headerRight.appendChild(closeBtn);
    header.appendChild(heading);
    header.appendChild(headerRight);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "summary-body";
    panel.appendChild(body);

    // Ảnh bìa
    let cover = oldThumb;
    if (!cover) {
        cover = document.createElement("div");
        cover.className = "summary-cover";
        cover.innerText = "📕";
        addCover(cover, book.thumbnail_path);
    }
    body.appendChild(cover);

    // Tiêu đề + star
    const titleRow = document.createElement("div");
    titleRow.className = "summary-title-row";
    const title = document.createElement("div");
    title.className = "summary-title";
    title.innerText = book.file_name;
    const star = document.createElement("button");
    star.className = "summary-star";
    star.innerText = "⭐";
    star.style.opacity = book.starred ? "1" : "0.3";
    star.title = book.starred ? "Unstar" : "Star";
    star.onclick = async () => {
        try {
            const newState = await api.toggleStar(book.path);
            book.starred = newState;
            star.style.opacity = newState ? "1" : "0.3";
            star.title = newState ? "Unstar" : "Star";
            currentActions?.onStarChanged?.();
        } catch (err) {
            console.error("Toggle star fail:", err);
        }
    };
    titleRow.appendChild(title);
    titleRow.appendChild(star);
    body.appendChild(titleRow);

    // Nút hành động
    const actionsRow = document.createElement("div");
    actionsRow.className = "summary-actions";
    const makeAction = (label, onClick, primary = false) => {
        const btn = document.createElement("button");
        btn.innerText = label;
        if (primary) btn.className = "summary-primary";
        btn.onclick = onClick;
        actionsRow.appendChild(btn);
    };
    if (currentActions?.onRead) makeAction("Read", () => currentActions.onRead(book), true);
    // Chỉ hiện khi AI được bật (toggle "Activate AI" trong AI Settings)
    if (currentActions?.onAi && window.__APP_ACTIONS__?.isAiEnabled?.()) {
        makeAction("AI auto", () => currentActions.onAi(book));
    }
    makeAction("Open in default app", () => window.__TAURI__.opener.openPath(book.path));
    makeAction("Edit details", () => currentActions?.onEdit?.(book));
    makeAction("Show in folder", () => api.revealInExplorer(book.path).catch(err => console.error("Reveal fail:", err)));
    body.appendChild(actionsRow);

    // Tags
    body.appendChild(sectionLabel("Tags"));
    const tags = Array.isArray(book.tags) ? book.tags : [];
    if (tags.length === 0) {
        body.appendChild(emptyText("No tags"));
    } else {
        const tagWrap = document.createElement("div");
        tagWrap.className = "summary-tags";
        tags.forEach(t => {
            const chip = document.createElement("span");
            chip.className = "summary-tag";
            chip.innerText = t;
            tagWrap.appendChild(chip);
        });
        body.appendChild(tagWrap);
    }

    // Descriptions
    body.appendChild(sectionLabel("Short description"));
    body.appendChild(book.short_description ? paragraph(book.short_description) : emptyText("No short description"));
    body.appendChild(sectionLabel("Description"));
    body.appendChild(book.description ? paragraph(book.description) : emptyText("No description"));

    // Thông tin file
    body.appendChild(sectionLabel("File"));
    const meta = document.createElement("div");
    meta.className = "summary-meta";
    const added = book.date_added ? new Date(book.date_added * 1000).toLocaleDateString() : "—";
    meta.innerText = `Added: ${added}\n${book.path}`;
    body.appendChild(meta);

    // Số trang + dung lượng trên disk (tải sau, có cache)
    const fileInfo = document.createElement("div");
    fileInfo.className = "summary-meta summary-fileinfo";
    body.appendChild(fileInfo);
    showFileInfo(fileInfo, book.path);
}

async function showFileInfo(el, path) {
    const show = (info) => {
        const pages = info.pages == null ? "—" : `${info.pages} page${info.pages === 1 ? "" : "s"}`;
        const size = info.size == null ? "—" : formatBytes(info.size);
        el.innerText = `Pages: ${pages}\nSize on disk: ${size}`;
    };
    const cached = fileInfoCache.get(path);
    if (cached) { show(cached); return; }
    el.innerText = "Pages: …\nSize on disk: …";
    const [pages, size] = await Promise.all([
        api.getPdfPageCount(path).catch(() => null),
        api.getFileSize(path).catch(() => null),
    ]);
    const info = { pages, size };
    if (pages != null || size != null) fileInfoCache.set(path, info);
    // Panel có thể đã chuyển sang sách khác trong lúc chờ
    if (currentBook?.path === path && el.isConnected) show(info);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

// Tay nắm ở cạnh trái panel: kéo sang trái để rộng ra, sang phải để hẹp lại
function makeResizer(panel) {
    const handle = document.createElement("div");
    handle.className = "summary-resizer";
    handle.title = "Drag to resize (double-click to reset)";
    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        panel.classList.add("resizing");
        const onMove = (ev) => applyPanelWidth(panel, clampPanelWidth(startWidth + (startX - ev.clientX)));
        const onUp = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);
            handle.removeEventListener("pointercancel", onUp);
            panel.classList.remove("resizing");
            try { localStorage.setItem("summaryPanelWidth", String(Math.round(panel.getBoundingClientRect().width))); } catch { /* ignore */ }
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
    });
    // Double-click: về độ rộng mặc định
    handle.addEventListener("dblclick", () => {
        applyPanelWidth(panel, clampPanelWidth(DEFAULT_PANEL_WIDTH));
        try { localStorage.setItem("summaryPanelWidth", String(DEFAULT_PANEL_WIDTH)); } catch { /* ignore */ }
    });
    return handle;
}

function sectionLabel(text) {
    const el = document.createElement("div");
    el.className = "summary-label";
    el.innerText = text;
    return el;
}

function paragraph(text) {
    const el = document.createElement("div");
    el.className = "summary-text";
    el.innerText = text;
    return el;
}

function emptyText(text) {
    const el = document.createElement("div");
    el.className = "summary-empty";
    el.innerText = text;
    return el;
}
