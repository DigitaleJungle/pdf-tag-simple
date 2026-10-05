import { api } from "./api.js";
import { el, button, openModal, setStatus, addCover } from "./ui.js";

// =============================================
// f_duplicates.js — Find & Remove Duplicates
//
// Flow:
//   1. User bấm "Find Duplicates"
//   2. openDuplicates() — hiện modal với progress bar
//   3. Backend tính SHA1 toàn bộ file, emit "duplicate_progress"
//   4. Hiện danh sách nhóm duplicate
//   5. Mỗi nhóm: user chọn file nào GIỮ lại, còn lại vào trash
//   6. Bấm "Move to trash" → gọi api.hideBook cho từng file bị loại
// =============================================
export async function openDuplicates(onApplied) {
    const body = el("div", "modal-body");
    const statusText = el("div", "status", "Click Scan to find duplicate files.");
    const progress = el("progress");
    progress.max = 1;
    progress.value = 0;
    progress.hidden = true;
    const resultsWrap = el("div");
    resultsWrap.style.cssText = "display:flex; flex-direction:column; gap:16px;";
    body.append(statusText, progress, resultsWrap);

    const footer = el("div");
    const footerLeft = el("div", "spacer");
    const scanBtn = button("Scan for duplicates", "primary");
    const trashBtn = button("Move selected to trash", "danger");
    trashBtn.hidden = true;

    // --- Listen progress events ---
    const unlisten = await window.__TAURI__.event.listen("duplicate_progress", (event) => {
        const { current, total, done } = event.payload;
        if (total > 0) {
            progress.value = current / total;
            statusText.innerText = `Scanning... ${current}/${total} files`;
        }
        if (done) {
            progress.value = 1;
            setTimeout(() => { progress.hidden = true; }, 500);
        }
    });

    const { close } = openModal({
        title: "Find Duplicates",
        subtitle: "Compares file content (SHA1). Duplicates will be moved to trash, not deleted.",
        width: 720,
        body,
        footer,
        onClose: unlisten,
    });
    footer.append(footerLeft, button("Close", "", close), scanBtn, trashBtn);

    // --- Scan ---
    let allGroups = [];
    // Map groupIndex → path user chọn GIỮ
    let keepMap = {};

    scanBtn.onclick = async () => {
        scanBtn.disabled = true;
        scanBtn.innerText = "Scanning...";
        progress.hidden = false;
        progress.value = 0;
        resultsWrap.innerHTML = "";
        keepMap = {};

        try {
            allGroups = await api.findDuplicates();
            if (allGroups.length === 0) {
                setStatus(statusText, "No duplicates found!", "ok");
            } else {
                setStatus(statusText, `Found ${allGroups.length} group(s) of duplicates.`, "error");
                allGroups.forEach((group, groupIdx) => {
                    // Mặc định giữ file đầu tiên
                    keepMap[groupIdx] = group.books[0].path;
                    resultsWrap.appendChild(renderGroup(group, groupIdx, keepMap));
                });
                trashBtn.hidden = false;
                footerLeft.innerText = "Select which file to KEEP in each group. Others will be moved to trash.";
            }
        } catch (err) {
            setStatus(statusText, "Error: " + err, "error");
        }
        scanBtn.disabled = false;
        scanBtn.innerText = "Scan again";
    };

    // --- Move to trash ---
    trashBtn.onclick = async () => {
        trashBtn.disabled = true;
        trashBtn.innerText = "Moving to trash...";
        for (const [groupIdx, group] of allGroups.entries()) {
            for (const book of group.books.filter(b => b.path !== keepMap[groupIdx])) {
                try {
                    await api.hideBook(book.path);
                } catch (err) {
                    console.error("Hide error:", book.path, err);
                }
            }
        }
        close();
        onApplied();
    };
}

// =============================================
// RENDER 1 NHÓM DUPLICATE
// =============================================
function renderGroup(group, groupIdx, keepMap) {
    const wrap = el("div");
    wrap.style.cssText = "border:1px solid var(--border); border-radius:10px; overflow:hidden;";

    const groupHeader = el("div", "hint", `Group ${groupIdx + 1} — ${group.books.length} identical files`);
    groupHeader.style.cssText = "background:var(--panel-soft); padding:8px 12px; font-size:12px; border-bottom:1px solid var(--border);";
    wrap.appendChild(groupHeader);

    const highlight = () => wrap.querySelectorAll(".dup-row").forEach(r => {
        r.style.background = r.dataset.path === keepMap[groupIdx] ? "var(--active-bg)" : "";
    });

    group.books.forEach((book) => {
        const row = el("label", "dup-row");
        row.dataset.path = book.path;
        row.style.cssText = "display:flex; align-items:center; gap:12px; padding:10px 14px; border-bottom:1px solid var(--border); cursor:pointer;";

        // Radio button — chọn file KEEP
        const radio = el("input");
        radio.type = "radio";
        radio.name = `dup-group-${groupIdx}`;
        radio.checked = keepMap[groupIdx] === book.path;
        radio.style.cssText = "width:16px; height:16px; flex-shrink:0;";
        radio.addEventListener("change", () => {
            keepMap[groupIdx] = book.path;
            highlight();
        });

        const thumb = el("div", "", "📄");
        thumb.style.cssText = "width:36px; height:48px; background:var(--hover); border-radius:4px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:18px;";
        addCover(thumb, book.thumbnail_path);

        const info = el("div");
        info.style.cssText = "flex:1; min-width:0;";
        const name = el("div", "", book.file_name);
        name.style.cssText = "font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
        name.title = book.file_name;
        const path = el("div", "hint", book.path);
        path.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;";
        path.title = book.path;
        info.append(name, path);

        const openBtn = el("button", "", "📁");
        openBtn.title = "Open location";
        openBtn.style.cssText = "border:none; background:transparent; cursor:pointer; font-size:16px; padding:4px; flex-shrink:0;";
        openBtn.onclick = (e) => { e.preventDefault(); api.revealInExplorer(book.path); };

        row.append(radio, thumb, info, openBtn);
        wrap.appendChild(row);
    });
    highlight();
    return wrap;
}
