// =============================================
// ui.js — helpers dùng chung: form controls, modal (<dialog>), menu (popover),
// ảnh bìa, so khớp folder. Style nằm trong styles.css (mục SHARED UI).
// =============================================

export function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.innerText = text;
    return node;
}

export const label = (text) => el("div", "label", text);
export const hint = (text) => el("div", "hint", text);
export const divider = () => el("hr", "divider");

export function input(type, value = "", placeholder = "") {
    const node = el("input", "field");
    node.type = type;
    node.value = value;
    node.placeholder = placeholder;
    return node;
}

export function textarea(value = "", placeholder = "", rows = 3) {
    const node = el("textarea", "field");
    node.value = value;
    node.placeholder = placeholder;
    node.rows = rows;
    return node;
}

export function select(options, selected) {
    const node = el("select", "field");
    options.forEach(opt => {
        const o = el("option", "", opt.label);
        o.value = opt.value;
        o.selected = opt.value === selected;
        node.appendChild(o);
    });
    return node;
}

// variant: "" | "primary" | "danger" | "danger-outline" | "success" | "small"
export function button(text, variant = "", onclick = null) {
    const node = el("button", `btn ${variant}`.trim(), text);
    if (onclick) node.onclick = onclick;
    return node;
}

export function checkbox(text, checked) {
    const row = el("label", "check-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!checked;
    row.append(box, text);
    return { row, box };
}

// Thông báo trạng thái: kind = "" | "ok" | "error"
export function setStatus(node, text, kind = "") {
    node.innerText = text;
    node.className = `status ${kind}`.trim();
}

export function escapeHtml(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
}

// Sách có nằm trong folder không (bỏ qua khác biệt \ và /)
export function isInFolder(bookPath, folderPath) {
    const folder = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return bookPath.replace(/\\/g, "/").startsWith(folder + "/");
}

// Ảnh bìa qua asset protocol, phủ lên placeholder trong `target` (class .cover).
// Thumbnail chưa render / lỗi → img tự gỡ, placeholder vẫn còn.
export function addCover(target, thumbnailPath) {
    target.classList.add("cover");
    if (!thumbnailPath) return;
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => img.remove();
    img.src = window.__TAURI__.core.convertFileSrc(thumbnailPath);
    target.appendChild(img);
}

// =============================================
// MODAL — <dialog>.showModal(): top layer, Esc đóng sẵn
// body / footer: element do caller tạo (thường class modal-body / để trống)
// onClose: gọi sau khi đóng bằng bất kỳ cách nào (nút x, Esc, click nền, close())
// =============================================
export function openModal({ title, subtitle = "", width = 640, body, footer = null, onClose = null }) {
    const dialog = el("dialog", "modal");
    dialog.style.width = `min(${width}px, calc(100vw - 40px))`;

    const header = el("div", "modal-header");
    const heading = el("div");
    heading.appendChild(el("div", "modal-title", title));
    if (subtitle) heading.appendChild(el("div", "modal-subtitle", subtitle));
    const closeBtn = el("button", "close-btn", "x");
    closeBtn.onclick = () => dialog.close();
    header.append(heading, closeBtn);

    dialog.append(header, body);
    if (footer) {
        footer.classList.add("modal-footer");
        dialog.appendChild(footer);
    }

    // Chỉ đóng khi cả mousedown lẫn click đều ở nền — bôi đen text trong modal
    // rồi thả chuột ra ngoài không làm modal đóng ngoài ý muốn.
    let downOnBackdrop = false;
    dialog.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === dialog; });
    dialog.addEventListener("click", (e) => {
        if (downOnBackdrop && e.target === dialog) dialog.close();
        downOnBackdrop = false;
    });
    dialog.addEventListener("close", () => {
        dialog.remove();
        if (onClose) onClose();
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    return { dialog, close: () => dialog.close() };
}

// Có modal / menu nào đang mở không — để phím tắt toàn cục (Esc, mũi tên...) nhường
export function overlayOpen() {
    return !!document.querySelector("dialog[open], .menu:popover-open");
}

// =============================================
// MENU — popover="auto": click ra ngoài / Esc tự đóng, mở menu khác thì menu cũ đóng
// items: [{ label | content (Node), action, danger }]
// anchor: Element (menu mở ngay dưới) hoặc { x, y } (vị trí chuột)
// =============================================
export function showMenu(items, anchor, className = "") {
    const menu = el("div", `menu ${className}`.trim());
    menu.popover = "auto";
    items.forEach(item => {
        const row = el("div", item.danger ? "menu-item danger" : "menu-item");
        if (item.content) row.appendChild(item.content);
        else row.innerText = item.label;
        row.onclick = async () => {
            menu.hidePopover();
            await item.action();
        };
        menu.appendChild(row);
    });
    menu.addEventListener("toggle", (e) => { if (e.newState === "closed") menu.remove(); });
    document.body.appendChild(menu);
    menu.showPopover();

    // Đặt vị trí, kẹp trong viewport (lật sang trái / lên trên nếu tràn)
    const isEl = anchor instanceof Element;
    const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const gap = isEl ? 4 : 0;
    const m = menu.getBoundingClientRect();
    const left = r.left + m.width > window.innerWidth ? r.right - m.width : r.left;
    const top = r.bottom + gap + m.height > window.innerHeight ? r.top - gap - m.height : r.bottom + gap;
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
    return menu;
}

// Nút mở/đóng menu: bấm lần nữa khi menu đang mở thì chỉ đóng.
// (Popover tự đóng khi nhả chuột ngoài nó — tức là trước "click" của chính nút này,
// nên phải ghi nhận trạng thái từ lúc pointerdown.)
export function bindMenuButton(btn, open) {
    let wasOpen = false;
    btn.addEventListener("pointerdown", () => { wasOpen = !!document.querySelector(".menu:popover-open"); });
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!wasOpen) open();
        wasOpen = false;
    });
}
