import { api } from "./api.js";
import { addCover } from "./ui.js";
import { summaryBookPath, closeSummaryPanel } from "./f_summary.js";

// =============================================
// createCard — tạo 1 card sách trong grid
//
// Params:
//   book           — BookEntry object
//   onOpen         — callback khi double click (đọc sách — reader hoặc app mặc định)
//   onContextMenu  — callback khi right click (context menu)
//   isSelected     — bool, card đang được chọn không
//   onToggleSelect — callback khi click vào chấm tròn góc trên trái (shift = chọn range)
//   Click vào card → mở summary panel bên phải (click lại sách đang hiện → đóng)
//   detailed       — true = card ngang, lớn hơn (setting "Show short description"):
//                    bìa bên trái; bên phải title, star, tags (góc trên phải)
//                    và short description
// =============================================
export function createCard(book, onOpen, onContextMenu, isSelected = false, onToggleSelect = null, detailed = false) {
    const card = document.createElement("div");

    // Hàm apply style theo trạng thái selected/unselected
    function applyCardStyle(selected) {
        card.style.cssText = `
            border: none;
            padding: 10px;
            ${detailed ? "box-sizing: border-box; height: 160px; gap: 12px;" : "width: 130px;"}
            text-align: ${detailed ? "left" : "center"};
            border-radius: 10px;
            cursor: pointer;
            background: var(--panel);
            color: var(--text);
            box-shadow: ${selected
                ? "0 0 0 2px var(--primary), 0 4px 12px rgba(0,0,0,0.1)"
                : "0 2px 8px rgba(0,0,0,0.07)"};
            transition: box-shadow 0.15s, transform 0.15s;
            user-select: none;
            display: flex;
            flex-direction: ${detailed ? "row" : "column"};
            position: relative;
        `;
    }

    applyCardStyle(isSelected);

    // --- Chấm tròn chọn sách (góc trên trái): click = toggle, shift+click = range ---
    const checkmark = document.createElement("div");
    checkmark.setAttribute("role", "checkbox");
    checkmark.title = "Select (Shift+click: select range)";
    function applyCheckStyle(selected) {
        checkmark.setAttribute("aria-checked", String(selected));
        checkmark.innerText = selected ? "✓" : "";
        checkmark.style.cssText = `
            position: absolute;
            top: 6px;
            left: 6px;
            width: 18px;
            height: 18px;
            box-sizing: border-box;
            border-radius: 50%;
            border: 1.5px solid ${selected ? "var(--primary)" : "var(--text-secondary)"};
            background: ${selected ? "var(--primary)" : "var(--panel)"};
            color: white;
            font-size: 11px;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1;
            font-weight: bold;
            opacity: ${selected ? "1" : "0.6"};
        `;
    }
    applyCheckStyle(isSelected);
    checkmark.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof onToggleSelect === "function") onToggleSelect(book.path, e.shiftKey);
    });
    // Click nhanh 2 lần vào chấm = toggle 2 lần, không mở reader
    checkmark.addEventListener("dblclick", (e) => e.stopPropagation());
    card.appendChild(checkmark);

    // --- Star button (góc trên phải) ---
    // Click star → toggle starred, cập nhật visual ngay, lưu vào database
    // Không re-render grid — chỉ update icon + book.starred local
    const starred = !!book.starred;

    const starBtn = document.createElement("div");
    starBtn.style.cssText = `
        ${detailed ? "align-self: flex-start;" : "position: absolute; top: 4px; right: 6px;"}
        font-size: 14px;
        cursor: pointer;
        z-index: 1;
        opacity: ${starred ? "1" : "0.25"};
        transition: opacity 0.15s, transform 0.15s;
        line-height: 1;
    `;
    starBtn.innerText = "⭐";
    starBtn.title = starred ? "Unstar" : "Star";
    if (!detailed) card.appendChild(starBtn);

    starBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
            const newState = await api.toggleStar(book.path);
            book.starred = newState; // Update local object — sort sẽ dùng giá trị này
            starBtn.style.opacity = newState ? "1" : "0.25";
            starBtn.title = newState ? "Unstar" : "Star";
            starBtn.style.transform = "scale(1.4)";
            setTimeout(() => starBtn.style.transform = "scale(1)", 150);
        } catch (err) {
            console.error("Toggle star fail:", err);
        }
    });

    // --- Thumbnail area ---
    const thumbArea = document.createElement("div");
    thumbArea.style.cssText = `
        background: var(--hover);
        height: 140px;
        ${detailed ? "width: 100px;" : ""}
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        margin-bottom: ${detailed ? "0" : "8px"};
        overflow: hidden;
        flex-shrink: 0;
        color: var(--text-secondary);
        font-size: 28px;
    `;
    thumbArea.innerHTML = "📕";
    addCover(thumbArea, book.thumbnail_path);

    // --- Title ---
    const title = document.createElement("p");
    title.style.cssText = `
        font-size: ${detailed ? "13px" : "12px"};
        margin: ${detailed ? "0 0 4px" : "5px 0 6px"};
        line-height: 1.25;
        ${detailed ? "" : "height: 30px;"}
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        text-align: ${detailed ? "left" : "center"};
        font-weight: ${detailed ? "600" : "500"};
        color: var(--text);
        ${detailed ? "overflow-wrap: anywhere;" : ""}
    `;
    title.innerText = book.file_name;
    // Hover tooltip: tên đầy đủ + short description + description (nếu có)
    title.title = [book.file_name, book.short_description, book.description].filter(Boolean).join("\n\n");

    // --- Tags ---
    const tagsWrap = document.createElement("div");
    tagsWrap.style.cssText = `
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: ${detailed ? "flex-end" : "center"};
        align-content: flex-start;
        ${detailed ? "flex: 0 1 auto; max-width: 45%; max-height: 56px;" : "min-height: 36px; max-height: 36px;"}
        overflow: hidden;
    `;

    const allTags = Array.isArray(book.tags) ? book.tags : [];
    const visibleTags = allTags.slice(0, 5);

    visibleTags.forEach(tag => {
        const chip = document.createElement("span");
        chip.innerText = tag;
        chip.title = tag;
        chip.style.cssText = `
            font-size: 10px;
            line-height: 1.1;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--primary-soft);
            color: var(--primary);
            max-width: ${detailed ? "90px" : "52px"};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        `;
        tagsWrap.appendChild(chip);
    });

    if (allTags.length > visibleTags.length) {
        const more = document.createElement("span");
        more.innerText = `+${allTags.length - visibleTags.length}`;
        more.style.cssText = `
            font-size: 10px;
            line-height: 1.1;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--hover);
            color: var(--text-secondary);
        `;
        tagsWrap.appendChild(more);
    }

    card.appendChild(thumbArea);
    if (detailed) {
        // Bên phải bìa: [title + star | tags] ở trên, short description bên dưới
        const info = document.createElement("div");
        info.style.cssText = "flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;";

        const topRow = document.createElement("div");
        topRow.style.cssText = "display: flex; align-items: flex-start; gap: 8px;";
        const titleCol = document.createElement("div");
        titleCol.style.cssText = "flex: 1; min-width: 0; display: flex; flex-direction: column;";
        titleCol.appendChild(title);
        titleCol.appendChild(starBtn);
        topRow.appendChild(titleCol);
        topRow.appendChild(tagsWrap);
        info.appendChild(topRow);

        if (book.short_description) {
            const shortDesc = document.createElement("p");
            shortDesc.style.cssText = `
                margin: 0;
                font-size: 12px;
                line-height: 1.35;
                color: var(--text-secondary);
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 4;
                -webkit-box-orient: vertical;
                overflow-wrap: anywhere;
            `;
            shortDesc.innerText = book.short_description;
            info.appendChild(shortDesc);
        }
        card.appendChild(info);
    } else {
        card.appendChild(title);
        card.appendChild(tagsWrap);
    }

    // --- Events ---
    card.addEventListener("click", (e) => {
        if (e.defaultPrevented) return;
        if (e.detail > 1) return; // 2nd click of a double-click — dblclick opens the reader
        if (summaryBookPath() === book.path) closeSummaryPanel();
        else window.__APP_ACTIONS__?.openSummary?.(book);
    });

    card.addEventListener("dblclick", () => onOpen(book));

    card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY, book);
    });

    // Expose update visual từ bên ngoài
    card.setSelected = (selected) => {
        applyCardStyle(selected);
        applyCheckStyle(selected);
    };

    return card;
}