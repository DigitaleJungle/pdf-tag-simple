# Changelog

## [1.3.1] - 2026-10-09

### Added
- Star a book from the reader: there's a star button in the reader's toolbar, next to the bookmark.

### Changed
- While you filter by tags, tags that would leave no books (combined with your folder, search and description filters) are greyed out and can't be clicked. Right-click still lets you rename or delete them.

## [1.3.0] - 2026-10-09

### Added
- Each book card has a small circle in the top-left corner to select it. Shift+click on the circle selects a range like Windows Explorer: a new Shift+click replaces the previous range, Shift+clicking the same book again undoes it, and if the last click deselected a book the range is deselected instead.
- New **Filter by Description** section in the sidebar: show only books that do or don't have a short description and/or a long description.
- The Folders, Tags and Description sections in the sidebar can be collapsed by clicking their title. The app remembers which ones are collapsed.
- New setting *Settings → General → Use the in-app reader*. When it's off, books open in your default PDF app.

### Changed
- One way of working replaces the four behaviour modes: click a book to see its summary (click it again to close the panel), double-click to read it. The summary panel has a large **Read** button.
- "Continue reading", bookmarks, the selection counter and "Select all" are always available now, not just in some modes. The selection counter only shows when something is selected.
- The search box now comes before "Continue reading" in the toolbar. When the middle of the window gets narrow (for example a tablet in portrait with the sidebar and summary panel open), Continue reading, the selection buttons and sort move together onto a second row and the other toolbar buttons stay visible.

### Removed
- The Behaviour button in the toolbar and the Behaviour setting.
- The "Missing short/long description first" sort options. Use the new description filter instead.
- The bulk **Hide** button in the toolbar. You can still hide a book from its right-click menu.
- Double-click to edit a book. Use **Edit details** in the right-click menu or the summary panel.

## [1.2.3] - 2026-10-08

### Added
- AI auto: when books fail (no text in the PDF, file too large, run stopped), two new buttons appear after the run. **Retry failed** selects those books in the grid and reopens AI auto with just them, so you can try another AI method. **Tag failed & close** gives them a tag (default "AI failed") so you can find them later. Both also apply the successful results.

## [1.2.2] - 2026-10-08

### Added
- AI auto: new **Name** option under "Fill in". The AI suggests a clean display name (title, plus author or volume when it can tell) that you can edit before applying. Only the name shown in the app changes; the file on disk keeps its name.

## [1.2.1] - 2026-10-07

### Changed
- New flat app icon that stays sharp at small sizes, like in the taskbar, title bar and Start menu.

## [1.2.0] - 2026-10-07

### Added
- AI auto: change the tag vocabulary for a single run under **Advanced**. It starts from the vocabulary in AI Settings, changes aren't saved, and **Reset to AI Settings** puts it back. The field is greyed out when Tags isn't being filled in.

## [1.1.0] - 2026-10-07

### Added
- Installers are now published on the [Releases](https://github.com/DigitaleJungle/pdf-tag-simple/releases) page for every new version.

### Changed
- New app icon.
- The README has been rewritten to describe the current app: the built-in reader, summary panel, behaviour modes, AI auto providers and methods, where data is stored, and how to build from source.
