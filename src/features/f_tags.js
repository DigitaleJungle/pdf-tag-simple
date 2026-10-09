import { el, input, button, openModal, showMenu } from "./ui.js";
import { getFilteredTags } from "./f_grid.js";

let expanded = false;

export function renderTagsUI(
    container, tagSearchInput, allTags, selectedTags, onTagChange,
    onTagRenamed, onTagDeleted, untaggedOnly, onUntaggedToggle
) {
    container.innerHTML = "";
    const rerender = (selected, untagged) => renderTagsUI(container, tagSearchInput, allTags, selected, onTagChange, onTagRenamed, onTagDeleted, untagged, onUntaggedToggle);

    const filterKeyword = tagSearchInput.value.trim().toLowerCase();

    // "No tags" — filters to books with zero tags. Mutually exclusive with
    // picking actual tags below, so hidden while text-searching tag names
    // (it isn't a tag name match) and not shown as combinable with them.
    if (!filterKeyword) {
        const untaggedBtn = el("button", `tag-chip italic ${untaggedOnly ? "selected" : "muted"}`, "No tags");
        untaggedBtn.onclick = () => {
            const nextUntagged = !untaggedOnly;
            const nextSelected = nextUntagged ? [] : selectedTags;
            onUntaggedToggle(nextUntagged);
            if (nextUntagged && selectedTags.length > 0) onTagChange(nextSelected);
            rerender(nextSelected, nextUntagged);
        };
        container.appendChild(untaggedBtn);
    }

    const displayTags = filterKeyword
        ? allTags.filter(t => t.name.toLowerCase().includes(filterKeyword))
        : allTags.slice(0, expanded ? 30 : 10);

    // While filtering by tags, adding a tag no shown book has would give 0 results
    const availableTags = !untaggedOnly && selectedTags.length > 0 ? getFilteredTags() : null;

    displayTags.forEach(tagObj => {
        const isSelected = selectedTags.includes(tagObj.name);
        const tagBtn = el("button", isSelected ? "tag-chip selected" : "tag-chip", `${tagObj.name} (${tagObj.count})`);
        // aria-disabled, not disabled: a disabled button gets no right-click (rename/delete)
        const unavailable = !isSelected && availableTags && !availableTags.has(tagObj.name.toLowerCase());
        if (unavailable) {
            tagBtn.setAttribute("aria-disabled", "true");
            tagBtn.title = "No books match with this tag added";
        }

        // Left click — toggle filter (luôn tạo array mới, không mutate array gốc)
        tagBtn.onclick = () => {
            if (unavailable) return;
            const newSelected = isSelected
                ? selectedTags.filter(t => t !== tagObj.name)
                : [...selectedTags, tagObj.name];
            // Picking a real tag implies non-empty tags — clear "No tags".
            const clearingUntagged = untaggedOnly && newSelected.length > 0;
            if (clearingUntagged) onUntaggedToggle(false);
            onTagChange(newSelected);
            rerender(newSelected, clearingUntagged ? false : untaggedOnly);
        };

        // Right click — rename / delete
        tagBtn.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showTagContextMenu(e.clientX, e.clientY, tagObj.name, onTagRenamed, onTagDeleted);
        });

        container.appendChild(tagBtn);
    });

    if (!filterKeyword && allTags.length > 10) {
        const toggleBtn = el("button", "tag-chip muted", expanded ? "Show less" : "Show more");
        toggleBtn.style.marginTop = "6px";
        toggleBtn.onclick = () => {
            expanded = !expanded;
            rerender(selectedTags, untaggedOnly);
        };
        container.appendChild(toggleBtn);
    }
}

// =============================================
// TAG CONTEXT MENU — right click tag chip
// =============================================
function showTagContextMenu(x, y, tagName, onTagRenamed, onTagDeleted) {
    showMenu([
        { label: `Rename "${tagName}"`, action: () => showRenameModal(tagName, onTagRenamed) },
        {
            label: `Delete "${tagName}" from all books`,
            danger: true,
            action: async () => {
                const ok = await window.__TAURI__.dialog.confirm(
                    `Remove tag "${tagName}" from all books?`,
                    { title: "Delete Tag", kind: "warning" }
                );
                if (ok) onTagDeleted(tagName);
            },
        },
    ], { x, y });
}

// =============================================
// RENAME MODAL — inline input vì Tauri k có dialog.prompt
// =============================================
function showRenameModal(oldName, onTagRenamed) {
    const body = el("div", "modal-body");
    const nameInput = input("text", oldName);
    body.appendChild(nameInput);

    const footer = el("div");
    const { close } = openModal({ title: "Rename tag", subtitle: `Rename "${oldName}" across all books.`, width: 380, body, footer });

    const confirm = () => {
        const newName = nameInput.value.trim();
        if (newName && newName !== oldName) onTagRenamed(oldName, newName);
        close();
    };
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); });
    footer.append(button("Cancel", "", close), button("Rename", "primary", confirm));

    nameInput.focus();
    nameInput.select();
}
