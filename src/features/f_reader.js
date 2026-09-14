import { api } from "./api.js";

// =============================================
// f_reader.js — In-app PDF reader
//
// Fullscreen overlay: continuous vertical scroll through all pages,
// pages lazy-rendered as they scroll into view, zoom via CSS (no re-render
// per zoom step). Esc / Back button returns to the library grid.
//
// The overlay/toolbar/nav buttons are built once per reader session and
// stay mounted while browsing — switching to the prev/next book (arrows,
// keyboard, swipe) reuses that shell and just reloads the scroll area's
// content (see loadBook), so only the PDF content animates, not the
// whole reader chrome.
// =============================================

const RENDER_WIDTH = 1600;     // px — backend rasterizes each page at this width
const BASE_DISPLAY_WIDTH = 720; // css px at zoom = 1
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;
const ZOOM_STORAGE_KEY = "pdfReaderZoom";

function loadStoredZoom() {
    const stored = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY));
    if (Number.isNaN(stored)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored));
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// Adjacent-book page cache — best-effort prefetch of the first couple pages
// of the prev/next book so swiping/arrow-navigating there feels instant.
// Deliberately low priority: kicked off after the current book's own pages
// are underway, capped to a handful of books (FIFO) and a couple pages each
// so it never competes seriously with loading the document actually on screen.
// =============================================
const PREFETCH_PAGE_COUNT = 2;
const MAX_CACHED_BOOKS = 6;
const bookCache = new Map(); // path -> { pageCount, pages: Map(index -> bytes) }
const prefetchInFlight = new Set();

function cacheBook(path, entry) {
    bookCache.set(path, entry);
    while (bookCache.size > MAX_CACHED_BOOKS) {
        const oldestPath = bookCache.keys().next().value;
        if (oldestPath === path) break;
        bookCache.delete(oldestPath);
    }
}

async function prefetchBook(path) {
    if (!path || bookCache.has(path) || prefetchInFlight.has(path)) return;
    prefetchInFlight.add(path);
    try {
        const pageCount = await api.getPdfPageCount(path);
        const entry = { pageCount, pages: new Map() };
        cacheBook(path, entry);
        const pagesToLoad = Math.min(PREFETCH_PAGE_COUNT, pageCount || 0);
        for (let i = 0; i < pagesToLoad; i++) {
            const bytes = await api.renderPdfPage(path, i, RENDER_WIDTH);
            entry.pages.set(i, bytes);
        }
    } catch (err) {
        console.error("Prefetch failed:", path, err);
    } finally {
        prefetchInFlight.delete(path);
    }
}

let currentSession = null;

export async function openReader(book) {
    // Already open — reuse the shell and just swap its content instead of
    // tearing down and rebuilding the whole reader.
    if (currentSession) {
        currentSession.loadBook(book, 0);
        return;
    }

    document.querySelectorAll(".pdf-reader-overlay").forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "pdf-reader-overlay";
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 6000;
        background: var(--panel-soft);
        display: flex; flex-direction: column;
    `;

    // --- Toolbar ---
    // Three sections so the prev/next/first/last group sits in the middle
    // regardless of how long the title or the right-hand controls are:
    // [ back + title ] --- [ |< < page > >| ] --- [ zoom  ⋮ ]
    const toolbar = document.createElement("div");
    toolbar.style.cssText = `
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; background: var(--panel);
        border-bottom: 1px solid var(--border);
        box-shadow: var(--shadow-sm); flex-shrink: 0; z-index: 1;
    `;

    function toolbarIconButton(label, fontSize = "14px") {
        const b = document.createElement("button");
        b.innerHTML = label;
        b.style.cssText = `
            border: 1px solid var(--border); background: var(--hover); color: var(--text);
            border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: ${fontSize};
            line-height: 1; flex-shrink: 0;
        `;
        return b;
    }

    function setBtnEnabled(btn, enabled) {
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? "1" : "0.35";
        btn.style.cursor = enabled ? "pointer" : "default";
    }

    // Left: back button + title
    const leftGroup = document.createElement("div");
    leftGroup.style.cssText = "flex:1; display:flex; align-items:center; gap:12px; min-width:0;";

    const backBtn = document.createElement("button");
    backBtn.innerText = "← Back to library";
    backBtn.style.cssText = `
        border: 1px solid var(--border); background: var(--hover); color: var(--text);
        border-radius: 8px; padding: 7px 14px; cursor: pointer;
        font-size: 13px; font-weight: 500; flex-shrink: 0;
    `;

    const title = document.createElement("div");
    title.style.cssText = `
        flex: 1; font-size: 13px; font-weight: 600; color: var(--text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    `;

    leftGroup.appendChild(backBtn);
    leftGroup.appendChild(title);

    // Middle: first/prev/next/last — PDF-to-PDF navigation only (no page
    // number here — that reads as page navigation and it isn't).
    const centerGroup = document.createElement("div");
    centerGroup.style.cssText = "display:flex; align-items:center; gap:6px; flex-shrink:0;";

    const firstBtn = toolbarIconButton("⏮");
    const prevBtn = toolbarIconButton("‹", "18px");
    const nextBtn = toolbarIconButton("›", "18px");
    const lastBtn = toolbarIconButton("⏭");

    firstBtn.title = "First PDF";
    prevBtn.title = "Previous PDF";
    nextBtn.title = "Next PDF";
    lastBtn.title = "Last PDF";

    centerGroup.appendChild(firstBtn);
    centerGroup.appendChild(prevBtn);
    centerGroup.appendChild(nextBtn);
    centerGroup.appendChild(lastBtn);

    // Right: page indicator (click to jump to a page) + zoom controls + "more actions" (⋮) menu
    const rightGroup = document.createElement("div");
    rightGroup.style.cssText = "flex:1; display:flex; align-items:center; justify-content:flex-end; gap:8px; min-width:0;";

    const pageIndicator = document.createElement("div");
    pageIndicator.style.cssText = `
        font-size:12px; color:var(--text-secondary); flex-shrink:0; min-width:70px;
        text-align:center; cursor:pointer; padding:4px 6px; border-radius:6px;
    `;
    pageIndicator.title = "Click to go to a page";
    pageIndicator.innerText = "…";
    pageIndicator.onmouseenter = () => pageIndicator.style.background = "var(--hover)";
    pageIndicator.onmouseleave = () => pageIndicator.style.background = "transparent";

    const zoomWrap = document.createElement("div");
    zoomWrap.style.cssText = "display:flex; align-items:center; gap:4px; flex-shrink:0;";
    const zoomOutBtn = toolbarIconButton("−");
    const zoomLabel = document.createElement("div");
    zoomLabel.style.cssText = "font-size:12px; color:var(--text-secondary); min-width:42px; text-align:center;";
    const zoomInBtn = toolbarIconButton("+");
    zoomWrap.appendChild(zoomOutBtn);
    zoomWrap.appendChild(zoomLabel);
    zoomWrap.appendChild(zoomInBtn);

    const menuBtn = toolbarIconButton("⋮", "16px");
    menuBtn.title = "More actions";

    rightGroup.appendChild(pageIndicator);
    rightGroup.appendChild(zoomWrap);
    rightGroup.appendChild(menuBtn);

    toolbar.appendChild(leftGroup);
    toolbar.appendChild(centerGroup);
    toolbar.appendChild(rightGroup);

    // --- Scroll area ---
    const scrollArea = document.createElement("div");
    scrollArea.style.cssText = `
        flex: 1; overflow: auto;
        padding: 24px 16px;
        touch-action: pan-y;
    `;

    overlay.appendChild(toolbar);
    overlay.appendChild(scrollArea);
    document.body.appendChild(overlay);

    // --- Session state (persists across prev/next navigation within this session) ---
    let currentBook = null;
    let zoom = loadStoredZoom();
    let closed = false;
    let observer = null;
    let pageEls = []; // { index, container, img, loaded, requested }
    let objectUrls = [];
    let navigating = false;

    function applyZoom() {
        zoomLabel.innerText = Math.round(zoom * 100) + "%";
        const width = BASE_DISPLAY_WIDTH * zoom;
        pageEls.forEach(p => { p.container.style.width = width + "px"; });
        // Below/at fit zoom there's no horizontal overflow to pan, so a one-finger
        // horizontal drag is free to mean "swipe to next/prev book" (see below).
        // Above fit zoom, that drag needs to pan the zoomed-in page instead, so let
        // native touch scrolling handle both axes and don't treat it as a swipe.
        scrollArea.style.touchAction = zoom > 1 ? "pan-x pan-y" : "pan-y";
    }
    applyZoom(); // show "100%" immediately instead of only after the first zoom change

    // Finds the page under viewport y-coordinate `y` (or the closest one, for
    // y above/below all pages) — used as a geometry reference for setZoom.
    // Binary search: pages stack monotonically top-to-bottom regardless of
    // individual (possibly not-yet-loaded) page heights, so rect.bottom is
    // non-decreasing across pageEls — this keeps repeated calls during a
    // pinch gesture cheap even for PDFs with hundreds of pages.
    function pageNear(y) {
        if (!pageEls.length) return null;
        let lo = 0, hi = pageEls.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (y < pageEls[mid].container.getBoundingClientRect().bottom) hi = mid;
            else lo = mid + 1;
        }
        return pageEls[lo];
    }

    // Sets zoom while keeping the content under (anchorX, anchorY) — a point in
    // viewport/client coordinates — visually stationary on screen. Defaults to
    // the scroll area's center when no anchor is given (button/keyboard zoom).
    //
    // Pages are horizontally centered (margin: auto) and separated by a fixed,
    // non-scaling margin/padding, so scroll position doesn't scale linearly
    // with zoom — instead this measures a reference page's actual position
    // before and after the zoom change and corrects the scroll offset by the
    // observed delta, which works regardless of how the layout shifts things.
    function setZoom(newZoom, anchorX, anchorY) {
        newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +newZoom.toFixed(2)));
        if (newZoom === zoom) return;

        const rect = scrollArea.getBoundingClientRect();
        const pointerX = anchorX ?? (rect.left + rect.width / 2);
        const pointerY = anchorY ?? (rect.top + rect.height / 2);
        const scale = newZoom / zoom;

        const ref = pageNear(pointerY);
        if (!ref) {
            zoom = newZoom;
            applyZoom();
            localStorage.setItem(ZOOM_STORAGE_KEY, zoom);
            return;
        }

        const before = ref.container.getBoundingClientRect();
        const dx = pointerX - before.left;
        const dy = pointerY - before.top;

        zoom = newZoom;
        applyZoom();
        localStorage.setItem(ZOOM_STORAGE_KEY, zoom);

        const after = ref.container.getBoundingClientRect();
        const desiredLeft = pointerX - dx * scale;
        const desiredTop = pointerY - dy * scale;
        scrollArea.scrollLeft += after.left - desiredLeft;
        scrollArea.scrollTop += after.top - desiredTop;
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

    // --- Swipe left/right (touch) — navigate to prev/next PDF ---
    // Tracked from the same single-finger gesture that otherwise just scrolls
    // the page (touch-action is pan-y at fit zoom, so horizontal drags don't
    // pan natively there) — only the start/end points are needed, no visual
    // feedback is drawn mid-swipe. Only armed at/below fit zoom (zoom <= 1):
    // above that, the same one-finger drag is needed to pan the zoomed-in
    // page (see applyZoom's touch-action toggle), so it must not also turn
    // into a page-turn.
    const SWIPE_THRESHOLD = 60; // px — minimum horizontal distance to count as a swipe
    let swipeStartX = null;
    let swipeStartY = null;

    scrollArea.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            pinchStartDist = touchDistance(e.touches);
            pinchStartZoom = zoom;
            swipeStartX = null; // a second finger joined — this is a pinch, not a swipe
        } else if (e.touches.length === 1 && zoom <= 1) {
            swipeStartX = e.touches[0].clientX;
            swipeStartY = e.touches[0].clientY;
        } else if (e.touches.length === 1) {
            swipeStartX = null; // zoomed in — this drag pans the page, not a swipe
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

    function endSwipe(e) {
        endPinch(e);
        if (swipeStartX !== null && e.touches.length === 0) {
            const endTouch = e.changedTouches[0];
            const deltaX = endTouch.clientX - swipeStartX;
            const deltaY = endTouch.clientY - swipeStartY;
            // Mostly-horizontal drag past the threshold — vertical drags keep scrolling the page.
            if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                goToAdjacent(deltaX < 0 ? 1 : -1);
            }
        }
        swipeStartX = null;
        swipeStartY = null;
    }
    scrollArea.addEventListener("touchend", endSwipe, { passive: true });
    scrollArea.addEventListener("touchcancel", endSwipe, { passive: true });

    // --- Prev/next/first/last book navigation ---
    // Walks the same filtered/sorted order currently shown in the library
    // grid (main.js), so "next"/"previous"/"first"/"last" match what the
    // user sees there.
    function goToAdjacent(direction) {
        if (navigating) return;
        const next = window.__APP_ACTIONS__?.getAdjacentBook?.(currentBook.path, direction);
        if (!next) return;
        loadBook(next, direction);
    }

    function goToBoundary(edge) {
        if (navigating) return;
        const target = window.__APP_ACTIONS__?.getBoundaryBook?.(edge);
        if (!target || target.path === currentBook.path) return;
        loadBook(target, edge === "first" ? -1 : 1);
    }

    function updateNavButtons() {
        const hasPrev = !!window.__APP_ACTIONS__?.getAdjacentBook?.(currentBook.path, -1);
        const hasNext = !!window.__APP_ACTIONS__?.getAdjacentBook?.(currentBook.path, 1);
        setBtnEnabled(firstBtn, hasPrev);
        setBtnEnabled(prevBtn, hasPrev);
        setBtnEnabled(nextBtn, hasNext);
        setBtnEnabled(lastBtn, hasNext);
    }

    firstBtn.onclick = () => goToBoundary("first");
    prevBtn.onclick = () => goToAdjacent(-1);
    nextBtn.onclick = () => goToAdjacent(1);
    lastBtn.onclick = () => goToBoundary("last");

    // --- "More actions" menu ---
    function showReaderMenu() {
        document.querySelectorAll(".reader-menu").forEach(m => m.remove());

        const menu = document.createElement("div");
        menu.className = "reader-menu";
        menu.style.cssText = `
            position: fixed; background: var(--panel); border: 1px solid var(--border);
            border-radius: 8px; box-shadow: var(--shadow-md); padding: 4px;
            z-index: 7000; min-width: 200px; font-size: 13px; color: var(--text);
        `;

        const items = [
            {
                label: "Open in default app",
                action: async () => await window.__TAURI__.opener.openPath(currentBook.path)
            },
            {
                label: "Open location",
                action: async () => await api.revealInExplorer(currentBook.path)
            },
            {
                label: "Edit name & Tags",
                action: () => {
                    if (!window.__APP_ACTIONS__?.editBook) return;
                    window.__APP_ACTIONS__.editBook(currentBook, (updated) => {
                        if (!updated) return;
                        currentBook.file_name = updated.file_name;
                        currentBook.tags = updated.tags;
                        title.innerText = currentBook.file_name;
                        // A rename can move this book to a new spot in the
                        // sorted grid order — re-check what first/prev/next/last
                        // should now point at.
                        updateNavButtons();
                    });
                }
            },
        ];

        items.forEach(({ label, action }) => {
            const item = document.createElement("div");
            item.innerText = label;
            item.style.cssText = "padding:9px 12px; cursor:pointer; border-radius:6px;";
            item.onmouseenter = () => item.style.background = "var(--hover)";
            item.onmouseleave = () => item.style.background = "transparent";
            item.onclick = async () => { menu.remove(); await action(); };
            menu.appendChild(item);
        });

        document.body.appendChild(menu);

        const btnRect = menuBtn.getBoundingClientRect();
        menu.style.top = (btnRect.bottom + 4) + "px";
        menu.style.left = btnRect.left + "px";
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (btnRect.right - rect.width) + "px";

        setTimeout(() => {
            document.addEventListener("click", () => menu.remove(), { once: true });
        }, 0);
    }

    menuBtn.onclick = (e) => {
        e.stopPropagation();
        showReaderMenu();
    };

    async function loadPage(entry) {
        if (entry.loaded || entry.requested) return;
        entry.requested = true;
        try {
            // A prefetch (triggered while the prev/next book was open) may already
            // have this page's bytes cached — skip the round-trip if so.
            const cached = bookCache.get(currentBook.path)?.pages.get(entry.index);
            const bytes = cached ?? await api.renderPdfPage(currentBook.path, entry.index, RENDER_WIDTH);
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

    let currentPageNum = 1;
    let editingPageIndicator = false;

    function updatePageIndicator() {
        if (editingPageIndicator) return;
        const areaTop = scrollArea.getBoundingClientRect().top;
        let current = 1;
        for (const p of pageEls) {
            const rect = p.container.getBoundingClientRect();
            if (rect.top - areaTop <= 80) current = p.index + 1;
        }
        currentPageNum = current;
        pageIndicator.innerText = `${current} / ${pageEls.length}`;
    }

    scrollArea.addEventListener("scroll", updatePageIndicator);

    function goToPage(n) {
        const entry = pageEls[n - 1];
        if (!entry) return;
        entry.container.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // --- Click the page indicator to jump straight to a page ---
    function enterPageJumpMode() {
        if (!pageEls.length || editingPageIndicator) return;
        editingPageIndicator = true;

        const input = document.createElement("input");
        input.type = "number";
        input.min = "1";
        input.max = String(pageEls.length);
        input.value = String(currentPageNum);
        input.style.cssText = `
            width: 46px; font-size: 12px; text-align: center;
            border: 1px solid var(--primary); border-radius: 4px;
            background: var(--panel); color: var(--text); padding: 2px 4px;
        `;

        function exitPageJumpMode() {
            editingPageIndicator = false;
            updatePageIndicator();
        }

        input.addEventListener("keydown", (e) => {
            // Keep this from also being caught by the document-level shortcut
            // handler (it already ignores focused inputs, this is belt & suspenders).
            e.stopPropagation();
            if (e.key === "Enter") {
                e.preventDefault();
                const n = parseInt(input.value, 10);
                if (!Number.isNaN(n)) goToPage(Math.min(Math.max(n, 1), pageEls.length));
                exitPageJumpMode();
            } else if (e.key === "Escape") {
                e.preventDefault();
                exitPageJumpMode();
            }
        });
        input.addEventListener("blur", exitPageJumpMode);

        pageIndicator.innerHTML = "";
        pageIndicator.appendChild(input);
        input.focus();
        input.select();
    }

    pageIndicator.onclick = enterPageJumpMode;

    function onKeydown(e) {
        // "Edit name & Tags" opens its own overlay on top of the reader, and
        // the page-jump box is an inline input — don't let reader shortcuts
        // (Escape, zoom, prev/next) steal keystrokes meant for either
        // (e.g. typing "-" into the file name, or a page number).
        if (document.querySelector(".edit-book-overlay")) return;
        if (document.activeElement?.tagName === "INPUT") return;

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
        if (e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            goToAdjacent(1);
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            goToAdjacent(-1);
        }
    }

    // Mouse "back" side button (button 3) — same guard as onKeydown so it
    // doesn't close the reader out from under an open "Edit name & Tags" modal.
    function onMouseUp(e) {
        if (e.button !== 3) return;
        if (document.querySelector(".edit-book-overlay")) return;
        e.preventDefault();
        close();
    }

    function close() {
        if (closed) return;
        closed = true;
        if (observer) observer.disconnect();
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        document.removeEventListener("keydown", onKeydown, true);
        document.removeEventListener("mouseup", onMouseUp, true);
        overlay.remove();
        if (currentSession === session) currentSession = null;
    }

    backBtn.onclick = close;
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mouseup", onMouseUp, true);

    // Loads a PDF into the (already-mounted) reader shell. Reused for the
    // initial open (direction 0, no animation) and for prev/next navigation
    // (direction ±1 — animates the scroll area's content sliding out and the
    // new content sliding in, while the toolbar/overlay stay put).
    async function loadBook(newBook, direction = 0) {
        navigating = true;

        if (observer) observer.disconnect();
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        objectUrls = [];
        pageEls = [];

        if (direction !== 0) {
            scrollArea.style.transition = "transform 150ms ease, opacity 150ms ease";
            scrollArea.style.transform = `translateX(${direction > 0 ? "-32px" : "32px"})`;
            scrollArea.style.opacity = "0";
            await wait(150);
            if (closed) return;
        }

        currentBook = newBook;
        title.innerText = newBook.file_name;
        title.title = newBook.path;
        updateNavButtons();

        scrollArea.innerHTML = "";
        scrollArea.scrollTop = 0;
        scrollArea.scrollLeft = 0;
        pageIndicator.innerText = "Loading…";

        function revealScrollArea() {
            if (direction === 0) return;
            // Enter from the opposite side, invisible, then slide/fade into place.
            scrollArea.style.transition = "none";
            scrollArea.style.transform = `translateX(${direction > 0 ? "32px" : "-32px"})`;
            scrollArea.style.opacity = "0";
            void scrollArea.offsetWidth; // force layout before re-enabling the transition
            scrollArea.style.transition = "transform 200ms ease, opacity 200ms ease";
            scrollArea.style.transform = "translateX(0)";
            scrollArea.style.opacity = "1";
        }

        let pageCount = 0;
        try {
            pageCount = await api.getPdfPageCount(newBook.path);
        } catch (err) {
            console.error("Get page count failed:", err);
            if (closed || currentBook !== newBook) return; // superseded by a newer navigation
            pageIndicator.innerText = "Error";
            revealScrollArea();
            navigating = false;
            return;
        }

        if (closed || currentBook !== newBook) return; // superseded by a newer navigation

        if (!pageCount || pageCount === 0) {
            const errMsg = document.createElement("div");
            errMsg.style.cssText = "color:var(--text-secondary); font-size:13px; padding:40px; text-align:center;";
            errMsg.innerText = "Couldn't open this PDF.";
            scrollArea.appendChild(errMsg);
            pageIndicator.innerText = "—";
        } else {
            for (let i = 0; i < pageCount; i++) {
                const container = document.createElement("div");
                container.style.cssText = `
                    width: ${BASE_DISPLAY_WIDTH * zoom}px;
                    min-height: 300px;
                    margin: 0 auto 16px;
                    background: var(--hover);
                    box-shadow: var(--shadow-card);
                    border-radius: 4px;
                    overflow: hidden;
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

        revealScrollArea();
        navigating = false;

        // Prefetch adjacent books, well after this one's own pages are underway.
        // A flat delay is enough to let the current document's requests reach
        // the backend first without any real scheduling machinery.
        setTimeout(() => {
            if (closed || currentBook !== newBook) return;
            const prevBook = window.__APP_ACTIONS__?.getAdjacentBook?.(newBook.path, -1);
            const nextBook = window.__APP_ACTIONS__?.getAdjacentBook?.(newBook.path, 1);
            if (nextBook) prefetchBook(nextBook.path);
            if (prevBook) prefetchBook(prevBook.path);
        }, 1200);
    }

    const session = { close, loadBook };
    currentSession = session;

    await loadBook(book, 0);
}
