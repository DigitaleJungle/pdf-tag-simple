import { el, button, openModal, escapeHtml } from "./ui.js";

// =============================================
// f_backup_prompt.js — popup hỏi khôi phục auto-backup lúc khởi động
//
// Export:
//   openAutoBackupPrompt(info, { onRestore, onDiscard })
//     info: { exported_at, book_count, folder_count } — từ api.checkAutoBackup()
//     onRestore()  — user chọn "Restore" (có thể async)
//     onDiscard()  — user chọn "No, discard it" (có thể async)
//   "Not now" / Esc / click nền — không đụng gì cả, file backup vẫn còn,
//   lần khởi động sau sẽ hỏi lại
// =============================================
export function openAutoBackupPrompt(info, { onRestore, onDiscard }) {
    const when = info?.exported_at
        ? new Date(info.exported_at * 1000).toLocaleString()
        : "an unknown time";
    const body = el("div", "modal-body");
    const message = el("div", "status");
    message.style.lineHeight = "1.5";
    message.innerHTML = `A backup from <b style="color:var(--text);">${escapeHtml(when)}</b> (${info?.book_count ?? 0} book(s), ${info?.folder_count ?? 0} folder(s)) was found. This usually means a previous "Update DB" didn't finish cleanly.<br><br>Restore it, discard it, or decide later.`;
    body.appendChild(message);

    const footer = el("div");
    const { close } = openModal({ title: "Restore backup?", width: 440, body, footer });

    const notNowBtn = button("Not now", "", () => close());
    const discardBtn = button("No, discard it", "danger-outline");
    const restoreBtn = button("Restore", "primary");
    const run = (btn, busyText, action) => async () => {
        [notNowBtn, discardBtn, restoreBtn].forEach(b => { b.disabled = true; });
        btn.innerText = busyText;
        await action();
        close();
    };
    discardBtn.onclick = run(discardBtn, "Discarding...", onDiscard);
    restoreBtn.onclick = run(restoreBtn, "Restoring...", onRestore);
    footer.append(notNowBtn, discardBtn, restoreBtn);
}
