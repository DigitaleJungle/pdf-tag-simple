import { renderAiSettingsSection } from "./f_ai.js";

// =============================================
// f_settings.js — App Settings modal
//
// Export:
//   openSettings(ctx)   — mở modal settings (sidebar trái + panel phải)
//     ctx.clickBehavior       — "select" | "open-default" | "open-reader"
//     ctx.onClickBehaviorChange(value) — gọi khi user đổi Click behaviour
//     ctx.onAddPath()         — gọi khi user bấm "Add Path"
//     ctx.onRemovePath(path)  — gọi sau khi user xác nhận xóa 1 path
//     ctx.getFolders()        — trả về Promise<string[]> danh sách path hiện có
//     ctx.onExport()          — gọi khi user bấm "Export Backup", trả về message hoặc null
//     ctx.onImport()          — gọi khi user bấm "Import Backup", trả về message hoặc null
//     ctx.onUpdateDb()        — gọi khi user bấm "Update DB"
//     ctx.onFindDuplicates()  — gọi khi user bấm "Find Duplicates"
//
// Thêm section mới: push vào SECTIONS bên dưới với { id, label, render(container, ctx) }
// render(container, ctx) có thể là async.
// =============================================

const SECTIONS = [
    { id: "general", label: "General", render: renderGeneralSection },
    { id: "backup", label: "Backup", render: renderBackupSection },
    { id: "ai", label: "AI Settings", render: renderAiSettingsSection },
];

export function openSettings(ctx = {}) {
    document.querySelectorAll(".settings-overlay").forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:3000; padding:20px;";

    const modal = document.createElement("div");
    modal.style.cssText = "width:min(720px,100%); height:min(520px,90vh); background:var(--panel); color:var(--text); border-radius:14px; box-shadow:var(--shadow-md); overflow:hidden; font-family:inherit; display:flex; flex-direction:column; border:1px solid var(--border);";

    // Header
    const header = document.createElement("div");
    header.style.cssText = "padding:16px 18px 12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-shrink:0;";
    header.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text);">Settings</div>`;
    header.appendChild(makeCloseBtn(() => overlay.remove()));

    // Body: nav (left) + content (right)
    const body = document.createElement("div");
    body.style.cssText = "flex:1; display:flex; min-height:0;";

    const nav = document.createElement("div");
    nav.style.cssText = "width:180px; flex-shrink:0; border-right:1px solid var(--border); padding:10px; display:flex; flex-direction:column; gap:2px; overflow-y:auto; background:var(--panel-soft);";

    const content = document.createElement("div");
    content.style.cssText = "flex:1; min-width:0; overflow-y:auto; padding:20px;";

    function selectSection(id) {
        const section = SECTIONS.find(s => s.id === id) || SECTIONS[0];
        [...nav.children].forEach(btn => {
            const active = btn.dataset.sectionId === section.id;
            btn.style.background = active ? "var(--active-bg)" : "transparent";
            btn.style.color = active ? "var(--active-text)" : "var(--text)";
            btn.style.fontWeight = active ? "600" : "400";
        });
        content.innerHTML = "";
        // Container riêng cho mỗi lần render — nếu render là async và user chuyển
        // section trước khi xong, kết quả trễ sẽ đổ vào node đã bị gỡ khỏi DOM.
        const pane = document.createElement("div");
        content.appendChild(pane);
        section.render(pane, ctx);
    }

    SECTIONS.forEach(section => {
        const btn = document.createElement("button");
        btn.dataset.sectionId = section.id;
        btn.innerText = section.label;
        btn.style.cssText = "text-align:left; padding:8px 10px; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; background:transparent; color:var(--text); transition:all var(--transition);";
        btn.addEventListener("click", () => selectSection(section.id));
        nav.appendChild(btn);
    });

    body.appendChild(nav);
    body.appendChild(content);

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    selectSection(SECTIONS[0].id);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); }
    }, { once: true });
}

// =============================================
// SECTIONS
// =============================================
const CLICK_BEHAVIOR_OPTIONS = [
    { value: "select", label: "Select", hint: "Click selects the book; double-click opens it in the reader." },
    { value: "open-default", label: "Open PDF with default application", hint: "Click opens the PDF in your system's default PDF viewer." },
    { value: "open-reader", label: "Open PDF with reader", hint: "Click opens the PDF directly in the built-in reader." },
];

async function renderGeneralSection(container, ctx) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-direction:column; gap:20px;";

    // --- Library ---
    const pathGroup = document.createElement("div");
    pathGroup.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    pathGroup.appendChild(makeLabel("Library"));

    const pathList = document.createElement("div");
    pathList.style.cssText = "display:flex; flex-direction:column; gap:4px; max-height:140px; overflow-y:auto;";

    async function refreshPathList() {
        pathList.innerHTML = "";
        const paths = typeof ctx.getFolders === "function" ? await ctx.getFolders() : [];
        if (!paths || paths.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "font-size:12px; color:var(--text-secondary);";
            empty.innerText = "No paths added yet.";
            pathList.appendChild(empty);
            return;
        }
        paths.forEach(p => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text); padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-soft);";

            const removeBtn = document.createElement("button");
            removeBtn.innerText = "−";
            removeBtn.title = `Remove ${p}`;
            removeBtn.style.cssText = "flex-shrink:0; width:20px; height:20px; padding:0; line-height:1; border:1px solid var(--border); background:var(--panel); color:var(--text-secondary); border-radius:50%; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center;";
            removeBtn.addEventListener("click", () => {
                confirmRemovePath(p, async () => {
                    if (typeof ctx.onRemovePath === "function") await ctx.onRemovePath(p);
                    await refreshPathList();
                });
            });

            const label = document.createElement("span");
            label.style.cssText = "word-break:break-all;";
            label.innerText = p;

            row.appendChild(removeBtn);
            row.appendChild(label);
            pathList.appendChild(row);
        });
    }
    await refreshPathList();
    pathGroup.appendChild(pathList);

    const actionRow = document.createElement("div");
    actionRow.style.cssText = "display:flex; flex-wrap:wrap; gap:8px;";

    const addPathBtn = document.createElement("button");
    addPathBtn.innerText = "Add Path";
    addPathBtn.style.cssText = "padding:9px 16px; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; cursor:pointer; font-size:13px;";
    addPathBtn.addEventListener("click", async () => {
        if (typeof ctx.onAddPath === "function") await ctx.onAddPath();
        await refreshPathList();
    });
    actionRow.appendChild(addPathBtn);

    const updateDbBtn = document.createElement("button");
    updateDbBtn.innerText = "Update DB";
    updateDbBtn.style.cssText = "padding:9px 16px; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; cursor:pointer; font-size:13px;";
    updateDbBtn.addEventListener("click", async () => {
        updateDbBtn.disabled = true;
        try {
            if (typeof ctx.onUpdateDb === "function") await ctx.onUpdateDb();
        } finally {
            updateDbBtn.disabled = false;
        }
    });
    actionRow.appendChild(updateDbBtn);

    const findDuplicatesBtn = document.createElement("button");
    findDuplicatesBtn.innerText = "Find Duplicates";
    findDuplicatesBtn.style.cssText = "padding:9px 16px; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; cursor:pointer; font-size:13px;";
    findDuplicatesBtn.addEventListener("click", () => {
        if (typeof ctx.onFindDuplicates === "function") ctx.onFindDuplicates();
    });
    actionRow.appendChild(findDuplicatesBtn);

    pathGroup.appendChild(actionRow);
    wrap.appendChild(pathGroup);

    // --- Click behaviour ---
    const clickGroup = document.createElement("div");
    clickGroup.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    clickGroup.appendChild(makeLabel("Click behaviour"));

    const current = ctx.clickBehavior || "select";

    const select = document.createElement("select");
    select.style.cssText = "width:100%; padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; outline:none; background:var(--panel); color:var(--text);";
    CLICK_BEHAVIOR_OPTIONS.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.innerText = opt.label;
        if (opt.value === current) o.selected = true;
        select.appendChild(o);
    });

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px; color:var(--text-secondary);";

    function updateHint() {
        const opt = CLICK_BEHAVIOR_OPTIONS.find(o => o.value === select.value);
        hint.innerText = opt ? opt.hint : "";
    }
    updateHint();

    select.addEventListener("change", () => {
        updateHint();
        if (typeof ctx.onClickBehaviorChange === "function") {
            ctx.onClickBehaviorChange(select.value);
        }
    });

    clickGroup.appendChild(select);
    clickGroup.appendChild(hint);
    wrap.appendChild(clickGroup);

    container.appendChild(wrap);
}

function renderBackupSection(container, ctx) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-direction:column; gap:20px;";

    // --- Export ---
    const exportGroup = document.createElement("div");
    exportGroup.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    exportGroup.appendChild(makeLabel("Export"));

    const exportHint = document.createElement("div");
    exportHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    exportHint.innerText = "Save your library (folders, books, tags) to a JSON backup file.";
    exportGroup.appendChild(exportHint);

    const exportStatus = document.createElement("div");
    exportStatus.style.cssText = "font-size:12px; color:var(--text-secondary);";

    const exportBtn = document.createElement("button");
    exportBtn.innerText = "Export Backup...";
    exportBtn.style.cssText = "align-self:flex-start; padding:9px 16px; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; cursor:pointer; font-size:13px;";
    exportBtn.addEventListener("click", async () => {
        exportBtn.disabled = true;
        try {
            const result = ctx.onExport ? await ctx.onExport() : null;
            if (result) {
                exportStatus.innerText = result;
                exportStatus.style.color = "#2e7d32";
            }
        } catch (err) {
            exportStatus.innerText = "Export error: " + err;
            exportStatus.style.color = "var(--danger)";
        } finally {
            exportBtn.disabled = false;
        }
    });
    exportGroup.appendChild(exportBtn);
    exportGroup.appendChild(exportStatus);
    wrap.appendChild(exportGroup);

    wrap.appendChild(document.createElement("hr")).style.cssText = "border:none; border-top:1px solid var(--border); margin:0;";

    // --- Import ---
    const importGroup = document.createElement("div");
    importGroup.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    importGroup.appendChild(makeLabel("Import"));

    const importHint = document.createElement("div");
    importHint.style.cssText = "font-size:11px; color:var(--text-secondary);";
    importHint.innerText = "Restore from a backup file. This replaces your current library entirely.";
    importGroup.appendChild(importHint);

    const importStatus = document.createElement("div");
    importStatus.style.cssText = "font-size:12px; color:var(--text-secondary);";

    const importBtn = document.createElement("button");
    importBtn.innerText = "Import Backup...";
    importBtn.style.cssText = "align-self:flex-start; padding:9px 16px; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; cursor:pointer; font-size:13px;";
    importBtn.addEventListener("click", async () => {
        importBtn.disabled = true;
        try {
            const result = ctx.onImport ? await ctx.onImport() : null;
            if (result) {
                importStatus.innerText = result;
                importStatus.style.color = "#2e7d32";
            }
        } catch (err) {
            importStatus.innerText = "Import error: " + err;
            importStatus.style.color = "var(--danger)";
        } finally {
            importBtn.disabled = false;
        }
    });
    importGroup.appendChild(importBtn);
    importGroup.appendChild(importStatus);
    wrap.appendChild(importGroup);

    container.appendChild(wrap);
}

function makeLabel(text) {
    const el = document.createElement("div");
    el.style.cssText = "font-size:13px; font-weight:600; color:var(--text);";
    el.innerText = text;
    return el;
}

// =============================================
// UI HELPERS
// =============================================
function makeCloseBtn(onclick) {
    const el = document.createElement("button");
    el.innerText = "x";
    el.style.cssText = "border:none; background:var(--hover); color:var(--text); width:34px; height:34px; border-radius:999px; cursor:pointer; font-size:14px;";
    el.onclick = onclick;
    return el;
}

// Popup xác nhận xóa 1 path — giải thích rõ hệ quả trước khi user bấm Remove.
// onConfirm có thể là async; overlay chỉ đóng sau khi onConfirm resolve xong.
function confirmRemovePath(path, onConfirm) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:3100; padding:20px;";

    const box = document.createElement("div");
    box.style.cssText = "width:min(420px,100%); background:var(--panel); color:var(--text); border-radius:14px; box-shadow:var(--shadow-md); font-family:inherit; border:1px solid var(--border); padding:18px; display:flex; flex-direction:column; gap:12px;";

    const title = document.createElement("div");
    title.style.cssText = "font-size:15px; font-weight:700;";
    title.innerText = "Remove this path?";

    const message = document.createElement("div");
    message.style.cssText = "font-size:13px; color:var(--text-secondary); line-height:1.5;";
    message.innerHTML = `This will stop tracking:<br><span style="word-break:break-all; color:var(--text);">${escapeHtml(path)}</span><br><br>All PDFs found under this path will be removed from your library database (tags, thumbnails, trash status included). The actual files on disk will not be touched — you can re-add the path later to rescan them.`;

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; justify-content:flex-end; gap:10px; margin-top:4px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "Cancel";
    cancelBtn.style.cssText = "border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; padding:9px 14px; cursor:pointer;";
    cancelBtn.onclick = () => overlay.remove();

    const removeBtn = document.createElement("button");
    removeBtn.innerText = "Remove";
    removeBtn.style.cssText = "border:1px solid var(--danger); background:var(--danger); color:white; border-radius:8px; padding:9px 16px; cursor:pointer; font-weight:600;";
    removeBtn.onclick = async () => {
        removeBtn.disabled = true;
        removeBtn.innerText = "Removing...";
        await onConfirm();
        overlay.remove();
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(removeBtn);

    box.appendChild(title);
    box.appendChild(message);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
}
