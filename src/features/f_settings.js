import { api } from "./api.js";
import { renderAiSettingsSection } from "./f_ai.js";
import { useInAppReader, setUseInAppReader } from "./f_reader.js";
import { el, label, hint, input, button, checkbox, divider, openModal, setStatus } from "./ui.js";

// =============================================
// f_settings.js — App Settings modal
//
// Export:
//   openSettings(ctx)   — mở modal settings (sidebar trái + panel phải)
//     ctx.showShortDescription — bool, card ngang có short description
//     ctx.onShowShortDescriptionChange(value) — gọi khi user bật/tắt checkbox đó
//     ctx.onAddPath()         — gọi khi user bấm "Add Path"
//     ctx.onRemovePath(path)  — gọi sau khi user xác nhận xóa 1 path
//     ctx.onExport()          — gọi khi user bấm "Export Backup", trả về message hoặc null
//     ctx.onImport()          — gọi khi user bấm "Import Backup", trả về message hoặc null
//     ctx.onUpdateDb()        — gọi khi user bấm "Update DB"
//     ctx.onFindDuplicates()  — gọi khi user bấm "Find Duplicates"
//     ctx.onAiEnabledChange(enabled) — xem f_ai.js
//
// Thêm section mới: push vào SECTIONS bên dưới với { id, label, render(container, ctx) }
// render(container, ctx) có thể là async.
// =============================================

const SECTIONS = [
    { id: "general", label: "General", render: renderGeneralSection },
    { id: "backup", label: "Backup", render: renderBackupSection },
    { id: "ai", label: "AI Settings", render: renderAiSettingsSection },
];

export function openSettings(ctx) {
    // Body: nav (left) + content (right)
    const body = el("div");
    body.style.cssText = "height:min(520px, calc(90vh - 70px)); display:flex; min-height:0;";

    const nav = el("div");
    nav.style.cssText = "width:180px; flex-shrink:0; border-right:1px solid var(--border); padding:10px; display:flex; flex-direction:column; gap:2px; overflow-y:auto; background:var(--panel-soft);";

    const content = el("div");
    content.style.cssText = "flex:1; min-width:0; overflow-y:auto; padding:20px;";

    function selectSection(id) {
        const section = SECTIONS.find(s => s.id === id);
        [...nav.children].forEach(btn => {
            const active = btn.dataset.sectionId === section.id;
            btn.style.background = active ? "var(--active-bg)" : "transparent";
            btn.style.color = active ? "var(--active-text)" : "var(--text)";
            btn.style.fontWeight = active ? "600" : "400";
        });
        content.innerHTML = "";
        // Container riêng cho mỗi lần render — nếu render là async và user chuyển
        // section trước khi xong, kết quả trễ sẽ đổ vào node đã bị gỡ khỏi DOM.
        const pane = el("div");
        content.appendChild(pane);
        section.render(pane, ctx);
    }

    SECTIONS.forEach(section => {
        const btn = el("button", "", section.label);
        btn.dataset.sectionId = section.id;
        btn.style.cssText = "text-align:left; padding:8px 10px; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; background:transparent; color:var(--text); transition:all var(--transition);";
        btn.addEventListener("click", () => selectSection(section.id));
        nav.appendChild(btn);
    });

    body.append(nav, content);
    openModal({ title: "Settings", width: 720, body });
    selectSection(SECTIONS[0].id);
}

// =============================================
// SECTIONS
// =============================================
function group(title) {
    const node = el("div");
    node.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    node.appendChild(label(title));
    return node;
}

function sectionWrap() {
    const wrap = el("div");
    wrap.style.cssText = "display:flex; flex-direction:column; gap:20px;";
    return wrap;
}

async function renderGeneralSection(container, ctx) {
    const wrap = sectionWrap();

    // --- Library ---
    const pathGroup = group("Library");
    const pathList = el("div");
    pathList.style.cssText = "display:flex; flex-direction:column; gap:4px; max-height:140px; overflow-y:auto;";

    async function refreshPathList() {
        pathList.innerHTML = "";
        const paths = await api.getFolders();
        if (paths.length === 0) {
            pathList.appendChild(el("div", "status", "No paths added yet."));
            return;
        }
        paths.forEach(p => {
            const row = el("div");
            row.style.cssText = "display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text); padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-soft);";

            const removeBtn = el("button", "", "−");
            removeBtn.title = `Remove ${p}`;
            removeBtn.style.cssText = "flex-shrink:0; width:20px; height:20px; padding:0; line-height:1; border:1px solid var(--border); background:var(--panel); color:var(--text-secondary); border-radius:50%; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center;";
            removeBtn.addEventListener("click", async () => {
                const ok = await window.__TAURI__.dialog.confirm(
                    `This will stop tracking:\n${p}\n\nAll PDFs found under this path will be removed from your library database (tags, thumbnails, trash status included). The actual files on disk will not be touched — you can re-add the path later to rescan them.`,
                    { title: "Remove this path?", kind: "warning", okLabel: "Remove" }
                );
                if (!ok) return;
                await ctx.onRemovePath(p);
                await refreshPathList();
            });

            const pathLabel = el("span", "", p);
            pathLabel.style.wordBreak = "break-all";
            row.append(removeBtn, pathLabel);
            pathList.appendChild(row);
        });
    }
    await refreshPathList();

    const actionRow = el("div");
    actionRow.style.cssText = "display:flex; flex-wrap:wrap; gap:8px;";
    const updateDbBtn = button("Update DB", "", async () => {
        updateDbBtn.disabled = true;
        try {
            await ctx.onUpdateDb();
        } finally {
            updateDbBtn.disabled = false;
        }
    });
    actionRow.append(
        button("Add Path", "", async () => { await ctx.onAddPath(); await refreshPathList(); }),
        updateDbBtn,
        button("Find Duplicates", "", () => ctx.onFindDuplicates()),
    );
    pathGroup.append(pathList, actionRow);
    wrap.appendChild(pathGroup);

    // --- Reading ---
    const readGroup = group("Reading");
    const inAppReader = checkbox("Use the in-app reader", useInAppReader());
    inAppReader.box.addEventListener("change", () => setUseInAppReader(inAppReader.box.checked));
    readGroup.append(
        inAppReader.row,
        hint("Double-click a book or press Read to open it in the built-in reader. When off, books open in your default PDF app."),
    );
    wrap.appendChild(readGroup);

    // --- Overview ---
    const overviewGroup = group("Overview");
    const shortDesc = checkbox("Show short description", ctx.showShortDescription);
    shortDesc.box.addEventListener("change", () => ctx.onShowShortDescriptionChange(shortDesc.box.checked));
    overviewGroup.append(
        shortDesc.row,
        hint("Shows larger cards: cover on the left, with the title, star, tags and short description next to it."),
    );
    wrap.appendChild(overviewGroup);

    // --- Page cache (reader) ---
    const cacheGroup = group("Page cache");
    const cacheSettings = await api.getPageCacheSettings().catch(() => ({ enabled: true, max_size_mb: 500 }));
    const saveCacheSettings = () => api.savePageCacheSettings({ ...cacheSettings });

    const cacheEnabled = checkbox("Cache rendered pages on disk", cacheSettings.enabled);
    cacheEnabled.box.addEventListener("change", () => {
        cacheSettings.enabled = cacheEnabled.box.checked;
        saveCacheSettings();
    });

    const cacheSizeRow = el("div");
    cacheSizeRow.style.cssText = "display:flex; align-items:center; gap:8px;";
    const cacheSizeInput = input("number", cacheSettings.max_size_mb);
    cacheSizeInput.min = "0";
    cacheSizeInput.step = "50";
    cacheSizeInput.style.width = "100px";
    cacheSizeInput.addEventListener("change", () => {
        const n = Math.max(0, Math.floor(Number(cacheSizeInput.value) || 0));
        cacheSizeInput.value = n;
        cacheSettings.max_size_mb = n;
        saveCacheSettings();
    });
    const purgeStatus = el("div", "status");
    const purgeBtn = button("Purge cache", "small", async () => {
        purgeBtn.disabled = true;
        try {
            setStatus(purgeStatus, await api.clearPageCache(), "ok");
        } catch (err) {
            setStatus(purgeStatus, "Purge error: " + err, "error");
        } finally {
            purgeBtn.disabled = false;
        }
    });
    purgeBtn.style.marginLeft = "auto";
    cacheSizeRow.append(cacheSizeInput, el("span", "status", "MB (0 = unlimited)"), purgeBtn);

    cacheGroup.append(
        cacheEnabled.row,
        cacheSizeRow,
        purgeStatus,
        hint("Keeps rendered pages on disk so reopening a book or scrolling back to a page is instant instead of re-rendering it. Once the cap is reached, pages from the oldest PDFs (by the PDF file's own date) are removed first."),
    );
    wrap.appendChild(cacheGroup);

    container.appendChild(wrap);
}

function renderBackupSection(container, ctx) {
    const wrap = sectionWrap();

    // Nút chạy 1 action trả về message (hoặc null nếu user hủy dialog chọn file)
    function actionGroup(title, hintText, btnText, action, errorPrefix) {
        const node = group(title);
        const status = el("div", "status");
        const btn = button(btnText, "", async () => {
            btn.disabled = true;
            try {
                const result = await action();
                if (result) setStatus(status, result, "ok");
            } catch (err) {
                setStatus(status, errorPrefix + err, "error");
            } finally {
                btn.disabled = false;
            }
        });
        btn.style.alignSelf = "flex-start";
        node.append(hint(hintText), btn, status);
        return node;
    }

    wrap.append(
        actionGroup("Export", "Save your library (folders, books, tags) to a JSON backup file.", "Export Backup...", ctx.onExport, "Export error: "),
        divider(),
        actionGroup("Import", "Restore from a backup file. This replaces your current library entirely.", "Import Backup...", ctx.onImport, "Import error: "),
    );
    container.appendChild(wrap);
}
