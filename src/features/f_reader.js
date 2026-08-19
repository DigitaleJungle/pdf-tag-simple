import { api } from "./api.js";

// =============================================
// f_reader.js — In-app PDF reader
//
// Fullscreen overlay: continuous vertical scroll through all pages,
// pages lazy-rendered as they scroll into view, zoom via CSS (no re-render
// per zoom step). Esc / Back button returns to the library grid.
// =============================================

const RENDER_WIDTH = 1600;     // px — backend rasterizes each page at this width
const BASE_DISPLAY_WIDTH = 720; // css px at zoom = 1
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.2;

let currentSession = null;

export async function openReader(book) {
    document.querySelectorAll(".pdf-reader-overlay").forEach(el => el.remove());
    if (currentSession) currentSession.close();

    const overlay = document.createElement("div");
    overlay.className = "pdf-reader-overlay";
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 6000;
        background: var(--panel-soft);
        display: flex; flex-direction: column;
    `;

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.style.cssText = `
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; background: var(--panel);
        border-bottom: 1px solid var(--border);
        box-shadow: var(--shadow-sm); flex-shrink: 0; z-index: 1;
    `;

    const backBtn = document.createElement("button");
    backBtn.innerText = "← Back to library";
    backBtn.style.cssText = `
        border: 1px solid var(--border); background: var(--hover); color: var(--text);
        border-radius: 8px; padding: 7px 14px; cursor: pointer;
        font-size: 13px; font-weight: 500; flex-shrink: 0;
    `;

    const title = document.createElement("div");
    title.innerText = book.file_name;
    title.title = book.path;
    title.style.cssText = `
        flex: 1; font-size: 13px; font-weight: 600; color: var(--text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    `;

    const pageIndicator = document.createElement("div");
    pageIndicator.style.cssText = "font-size:12px; color:var(--text-secondary); flex-shrink:0; min-width:70px; text-align:center;";
    pageIndicator.innerText = "…";

    function zoomButton(label) {
        const b = document.createElement("button");
        b.innerText = label;
        b.style.cssText = `
            border: 1px solid var(--border); background: var(--hover); color: var(--text);
            border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 14px;
        `;
        return b;
    }

    const zoomWrap = document.createElement("div");
    zoomWrap.style.cssText = "display:flex; align-items:center; gap:4px; flex-shrink:0;";
    const zoomOutBtn = zoomButton("−");
    const zoomLabel = document.createElement("div");
    zoomLabel.style.cssText = "font-size:12px; color:var(--text-secondary); min-width:42px; text-align:center;";
    const zoomInBtn = zoomButton("+");
    zoomWrap.appendChild(zoomOutBtn);
    zoomWrap.appendChild(zoomLabel);
    zoomWrap.appendChild(zoomInBtn);

    toolbar.appendChild(backBtn);
    toolbar.appendChild(title);
    toolbar.appendChild(pageIndicator);
    toolbar.appendChild(zoomWrap);

    // --- Scroll area ---
    const scrollArea = document.createElement("div");
    scrollArea.style.cssText = `
        flex: 1; overflow: auto;
        display: flex; flex-direction: column; align-items: center;
        gap: 16px; padding: 24px 16px;
        touch-action: pan-y;
    `;

    overlay.appendChild(toolbar);
    overlay.appendChild(scrollArea);
    document.body.appendChild(overlay);

    // --- State ---
    let zoom = 1;
    let closed = false;
    let observer = null;
    const pageEls = []; // { index, container, img, loaded, requested }
    const objectUrls = [];

    function applyZoom() {
        zoomLabel.innerText = Math.round(zoom * 100) + "%";
        const width = BASE_DISPLAY_WIDTH * zoom;
        pageEls.forEach(p => { p.container.style.width = width + "px"; });
    }

    // Sets zoom while keeping the content under (anchorX, anchorY) — a point in
    // viewport/client coordinates — visually stationary on screen. Defaults to
    // the scroll area's center when no anchor is given (button/keyboard zoom).
    function setZoom(newZoom, anchorX, anchorY) {
        newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +newZoom.toFixed(2)));
        if (newZoom === zoom) return;

        const rect = scrollArea.getBoundingClientRect();
        const pointerX = (anchorX ?? (rect.left + rect.width / 2)) - rect.left;
        const pointerY = (anchorY ?? (rect.top + rect.height / 2)) - rect.top;
        const contentX = scrollArea.scrollLeft + pointerX;
        const contentY = scrollArea.scrollTop + pointerY;
        const scale = newZoom / zoom;

        zoom = newZoom;
        applyZoom();

        scrollArea.scrollLeft = contentX * scale - pointerX;
        scrollArea.scrollTop = contentY * scale - pointerY;
    }

    function changeZoom(delta, anchorX, anchorY) {
        setZoom(zoom + delta, anchorX, anchorY);
    }

    zoomInBtn.onclick = () => changeZoom(ZOOM_STEP);
    zoomOutBtn.onclick = () => changeZoom(-ZOOM_STEP);

    scrollArea.addEventListener("wheel", (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        changeZoom(e.deltaY < 0 ? 0.1 : -0.1, e.clientX, e.clientY);
    }, { passive: false });

    // --- Pinch to zoom (touch) ---
    let pinchStartDist = null;
    let pinchStartZoom = 1;

    function touchMidpoint(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2,
        };
    }

    function touchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
    }

    scrollArea.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            pinchStartDist = touchDistance(e.touches);
            pinchStartZoom = zoom;
        }
    }, { passive: true });

    scrollArea.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
            e.preventDefault();
            const scale = touchDistance(e.touches) / pinchStartDist;
            const mid = touchMidpoint(e.touches);
            setZoom(pinchStartZoom * scale, mid.x, mid.y);
        }
    }, { passive: false });

    function endPinch(e) {
        if (e.touches.length < 2) pinchStartDist = null;
    }
    scrollArea.addEventListener("touchend", endPinch, { passive: true });
    scrollArea.addEventListener("touchcancel", endPinch, { passive: true });

    async function loadPage(entry) {
        if (entry.loaded || entry.requested) return;
        entry.requested = true;
        try {
            const bytes = await api.renderPdfPage(book.path, entry.index, RENDER_WIDTH);
            if (closed) return;
            if (bytes && bytes.length > 0) {
                const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
                const url = URL.createObjectURL(blob);
                objectUrls.push(url);
                entry.img.src = url;
                entry.img.style.opacity = "1";
                entry.loaded = true;
            }
        } catch (err) {
            console.error("Render page failed:", entry.index, err);
            entry.requested = false;
        }
    }

    function updatePageIndicator() {
        const areaTop = scrollArea.getBoundingClientRect().top;
        let current = 1;
        for (const p of pageEls) {
            const rect = p.container.getBoundingClientRect();
            if (rect.top - areaTop <= 80) current = p.index + 1;
        }
        pageIndicator.innerText = `${current} / ${pageEls.length}`;
    }

    scrollArea.addEventListener("scroll", updatePageIndicator);

    function onKeydown(e) {
        if (e.key === "Escape") {
            e.stopPropagation();
            close();
            return;
        }
        if (e.key === "+" || (e.ctrlKey && e.key === "=")) {
            e.preventDefault();
            e.stopPropagation();
            changeZoom(ZOOM_STEP);
        }
        if (e.key === "-") {
            e.preventDefault();
            e.stopPropagation();
            changeZoom(-ZOOM_STEP);
        }
    }

    function close() {
        if (closed) return;
        closed = true;
        if (observer) observer.disconnect();
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        document.removeEventListener("keydown", onKeydown, true);
        overlay.remove();
        if (currentSession === session) currentSession = null;
    }

    backBtn.onclick = close;
    document.addEventListener("keydown", onKeydown, true);

    const session = { close };
    currentSession = session;

    // --- Load page count & build placeholders ---
    pageIndicator.innerText = "Loading…";
    let pageCount = 0;
    try {
        pageCount = await api.getPdfPageCount(book.path);
    } catch (err) {
        console.error("Get page count failed:", err);
        pageIndicator.innerText = "Error";
        return;
    }

    if (closed) return;

    if (!pageCount || pageCount === 0) {
        const errMsg = document.createElement("div");
        errMsg.style.cssText = "color:var(--text-secondary); font-size:13px; padding:40px;";
        errMsg.innerText = "Couldn't open this PDF.";
        scrollArea.appendChild(errMsg);
        pageIndicator.innerText = "—";
        return;
    }

    for (let i = 0; i < pageCount; i++) {
        const container = document.createElement("div");
        container.style.cssText = `
            width: ${BASE_DISPLAY_WIDTH * zoom}px;
            min-height: 300px;
            background: var(--hover);
            box-shadow: var(--shadow-card);
            border-radius: 4px;
            overflow: hidden;
            flex-shrink: 0;
        `;

        const img = document.createElement("img");
        img.style.cssText = "display:block; width:100%; height:auto; opacity:0; transition:opacity 0.15s;";
        img.alt = `Page ${i + 1}`;

        container.appendChild(img);
        scrollArea.appendChild(container);

        pageEls.push({ index: i, container, img, loaded: false, requested: false });
    }

    updatePageIndicator();

    observer = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                const entry = pageEls.find(p => p.container === e.target);
                if (entry) loadPage(entry);
            }
        });
    }, { root: scrollArea, rootMargin: "600px 0px" });

    pageEls.forEach(p => observer.observe(p.container));
}
