// =============================================
// f_backup_prompt.js — popup hỏi khôi phục auto-backup lúc khởi động
//
// Export:
//   openAutoBackupPrompt(info, { onRestore, onDiscard, onNotNow })
//     info: { exported_at, book_count, folder_count } — từ api.checkAutoBackup()
//     onRestore()  — user chọn "Restore" (có thể async)
//     onDiscard()  — user chọn "No, discard it" (có thể async)
//     onNotNow()   — user chọn "Not now" hoặc đóng popup — không đụng gì cả,
//                    file backup vẫn còn, lần khởi động sau sẽ hỏi lại
// =============================================
export function openAutoBackupPrompt(info, { onRestore, onDiscard, onNotNow } = {}) {
    document.querySelectorAll(".auto-backup-overlay").forEach(el => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "auto-backup-overlay";
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:4000; padding:20px;";

    const box = document.createElement("div");
    box.style.cssText = "width:min(440px,100%); background:var(--panel); color:var(--text); border-radius:14px; box-shadow:var(--shadow-md); font-family:inherit; border:1px solid var(--border); padding:18px; display:flex; flex-direction:column; gap:12px;";

    const title = document.createElement("div");
    title.style.cssText = "font-size:15px; font-weight:700;";
    title.innerText = "Restore backup?";

    const when = info?.exported_at
        ? new Date(info.exported_at * 1000).toLocaleString()
        : "an unknown time";
    const message = document.createElement("div");
    message.style.cssText = "font-size:13px; color:var(--text-secondary); line-height:1.5;";
    message.innerHTML = `A backup from <b style="color:var(--text);">${escapeHtml(when)}</b> (${info?.book_count ?? 0} book(s), ${info?.folder_count ?? 0} folder(s)) was found. This usually means a previous "Update DB" didn't finish cleanly.<br><br>Restore it, discard it, or decide later.`;

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; margin-top:4px;";

    function close() {
        overlay.remove();
        document.removeEventListener("keydown", onEsc);
    }

    function disableAll() {
        notNowBtn.disabled = true;
        discardBtn.disabled = true;
        restoreBtn.disabled = true;
    }

    const notNowBtn = document.createElement("button");
    notNowBtn.innerText = "Not now";
    notNowBtn.style.cssText = "border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:8px; padding:9px 14px; cursor:pointer;";
    notNowBtn.onclick = () => {
        close();
        if (typeof onNotNow === "function") onNotNow();
    };

    const discardBtn = document.createElement("button");
    discardBtn.innerText = "No, discard it";
    discardBtn.style.cssText = "border:1px solid var(--danger); background:var(--panel); color:var(--danger); border-radius:8px; padding:9px 14px; cursor:pointer;";
    discardBtn.onclick = async () => {
        disableAll();
        discardBtn.innerText = "Discarding...";
        if (typeof onDiscard === "function") await onDiscard();
        close();
    };

    const restoreBtn = document.createElement("button");
    restoreBtn.innerText = "Restore";
    restoreBtn.style.cssText = "border:1px solid var(--primary); background:var(--primary); color:white; border-radius:8px; padding:9px 16px; cursor:pointer; font-weight:600;";
    restoreBtn.onclick = async () => {
        disableAll();
        restoreBtn.innerText = "Restoring...";
        if (typeof onRestore === "function") await onRestore();
        close();
    };

    footer.appendChild(notNowBtn);
    footer.appendChild(discardBtn);
    footer.appendChild(restoreBtn);

    box.appendChild(title);
    box.appendChild(message);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Click ra ngoài hoặc Escape = "Not now" (không đụng file backup)
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
            close();
            if (typeof onNotNow === "function") onNotNow();
        }
    });
    function onEsc(e) {
        if (e.key === "Escape") {
            close();
            if (typeof onNotNow === "function") onNotNow();
        }
    }
    document.addEventListener("keydown", onEsc);
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
}
