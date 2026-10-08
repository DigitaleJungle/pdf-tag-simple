// =============================================
// f_reading_history.js — shared "Continue reading" storage
//
// main.js (the toolbar button + its dropdown) and f_reader.js (saving
// position while reading, the in-reader bookmark button) both read and
// write this same localStorage-backed list. Centralized here instead of
// each file hand-rolling its own copy, so the rotation/bookmark rules can't
// drift between the two call sites.
//
// LAST_READ_KEY holds an array of entries, most-recently-read first:
//   { path, page, filters, savedAt, bookmarked }
// Up to MAX_RECENT_ENTRIES non-bookmarked entries are kept automatically
// (the normal "last 3 books" rotation); bookmarked entries are kept
// regardless, up to the generous MAX_BOOKMARKS safety cap — bookmarking is
// what exempts a session from that rotation.
//
// LAST_FILTERS_KEY is a live mirror of main.js's current filter state,
// written on every grid render. It's read here at save time as a snapshot
// of "what was I looking at when this reading session started" — safe
// because the library UI is hidden behind the reader's fullscreen overlay
// for the whole session, so the mirror can't change mid-read.
// =============================================

const LAST_READ_KEY = "pdfReaderLastRead";
const LAST_FILTERS_KEY = "pdfReaderLastFilters";
const MAX_RECENT_ENTRIES = 3;
const MAX_BOOKMARKS = 20; // generous safety cap, not meant as a real-world limit

export function readList() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_READ_KEY) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeList(list) {
    try {
        localStorage.setItem(LAST_READ_KEY, JSON.stringify(list));
    } catch { /* localStorage unavailable/full — feature degrades silently */ }
}

function capList(list) {
    const bookmarks = list.filter(e => e.bookmarked).slice(0, MAX_BOOKMARKS);
    const recents = list.filter(e => !e.bookmarked).slice(0, MAX_RECENT_ENTRIES);
    const keep = new Set([...bookmarks, ...recents]);
    return list.filter(e => keep.has(e)); // preserves the original most-recent-first order
}

export function writeCurrentFilters(filters) {
    try {
        localStorage.setItem(LAST_FILTERS_KEY, JSON.stringify(filters));
    } catch { /* "continue reading" just won't have filters to restore */ }
}

function readCurrentFilters() {
    try {
        return JSON.parse(localStorage.getItem(LAST_FILTERS_KEY) || "null");
    } catch {
        return null;
    }
}

// Records the current page for `path` — preserving its bookmark flag if it
// already had one — and moves it to the front (most recently read).
export function saveEntry(path, page) {
    let list = readList();
    const existing = list.find(e => e && e.path === path);
    const bookmarked = existing?.bookmarked === true;
    list = list.filter(e => e && e.path !== path);
    list.unshift({ path, page, filters: readCurrentFilters(), savedAt: Date.now(), bookmarked });
    writeList(capList(list));
}

// Flips the bookmark flag for `path`'s current entry and returns the new
// state (or null if there's no recorded entry for it — bookmarking only
// ever happens from an already-visible entry, so this shouldn't occur in
// practice). Un-bookmarking can cause the entry to drop out of the list
// entirely if it no longer fits in the plain "recent" window — that's the
// intended trade of removing its bookmark exemption.
export function toggleBookmark(path) {
    const list = readList();
    const entry = list.find(e => e && e.path === path);
    if (!entry) return null;
    entry.bookmarked = !entry.bookmarked;
    writeList(capList(list));
    return entry.bookmarked;
}

export function isBookmarked(path) {
    return readList().find(e => e && e.path === path)?.bookmarked === true;
}
