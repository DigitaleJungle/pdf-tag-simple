// =============================================
// f_sidebar_sections.js — sidebar sections thu gọn được
//
// Export:
//   initSidebarSections(container) — mọi con trực tiếp có [data-section] trong container:
//     click .section-title → thu gọn / mở (.section-body ẩn đi)
//   Trạng thái thu gọn nhớ qua localStorage.
// =============================================

const COLLAPSED_KEY = "sidebarSectionsCollapsed";

function loadCollapsed() {
    try {
        const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

export function initSidebarSections(container) {
    const collapsed = new Set(loadCollapsed());

    [...container.children].filter(s => s.dataset.section).forEach(section => {
        const id = section.dataset.section;
        const title = section.querySelector(".section-title");

        const setCollapsed = (value) => {
            section.classList.toggle("collapsed", value);
            title.setAttribute("aria-expanded", String(!value));
        };
        setCollapsed(collapsed.has(id));

        title.addEventListener("click", () => {
            const value = !section.classList.contains("collapsed");
            setCollapsed(value);
            if (value) collapsed.add(id); else collapsed.delete(id);
            try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* ignore */ }
        });
    });
}
