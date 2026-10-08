# PDF Tag Simple

A fast desktop app for browsing, tagging, describing and reading a large PDF library. You scan your folders once, and after that browsing runs from a local cache, so even a library on a slow HDD feels instant.

Built with [Tauri 2](https://tauri.app/) (Rust backend, plain HTML/JS frontend) and [PDFium](https://pdfium.googlesource.com/pdfium/) for rendering.

> **Fork notice.** This is a fork of [mencolovepizza/pdf-tag-simple](https://github.com/mencolovepizza/pdf-tag-simple) by [@mencolovepizza](https://github.com/mencolovepizza). Thanks for the original idea and codebase: scan once, browse forever. This fork adds a built-in reader, descriptions, a summary panel, more AI providers and a lot of UI work. It is developed separately from upstream.

## Download

Get the latest Windows installer (`.msi` or `.exe`) from the [Releases](https://github.com/DigitaleJungle/pdf-tag-simple/releases) page. The installers aren't code-signed, so Windows SmartScreen may show a warning the first time you run one. Click **More info → Run anyway**.

## Getting started

1. Open **Settings** (gear icon, bottom left) and click **Add Path** to add a PDF folder. You can add several. Subfolders are scanned too.
2. Click **Update DB**. It scans the folders and renders a cover thumbnail for each PDF. The first run is slow on large libraries; later runs only pick up changes.
3. Browse, search, tag and read.

Click **Update DB** again whenever files are added, moved or removed. Before each update the app makes an automatic backup of your tags and descriptions. If something looks wrong afterwards, it offers to restore it.

## Features

### Library
- **Thumbnail grid** with small or large cards. Large cards also show the short description.
- **Folders sidebar**: filter by library folder. The sidebar can be collapsed (`Ctrl + B`), and each sidebar section (Folders, Tags, Description) can be collapsed by clicking its title.
- **Tag filter**: click tags to filter. Tags can be searched, renamed and deleted, and you can filter on untagged books.
- **Description filter**: show only books that do (Yes) or don't (No) have a short and/or long description.
- **Search** across file name, tags, short description and description.
- **Sort** by name or date added.
- **Star** favourites.
- **Hide / Trash**: hide a book from the library (right-click menu) and restore books from the Trash view.
- **Find duplicates**: a basic duplicate finder.
- **Edit details**: name, tags, short description and long description, for one book or for a selection (bulk tag editing).

### Clicking books

| Action | Result |
|--------|--------|
| Click a book | Show its details in the summary panel (click it again to close the panel) |
| Double-click a book | Read it |
| Click the circle in the top-left corner | Select or deselect the book |
| `Shift` + click the circle | Select or deselect a range, like Windows Explorer |
| Right-click | Read in app, open in default app, edit details, hide, AI auto, ... |

Books open in the built-in reader. Turn off *Settings → General → Use the in-app reader* to open them in your default PDF app instead.

The **summary panel** shows the cover, star, tags, descriptions, date added, path, page count and file size, with a large Read button and buttons for Open in default app, Edit details, Show in folder and AI auto. The panel can be resized, and it can also be opened inside the reader.

### Built-in reader
- Zoom with the mouse wheel, keyboard or pinch, and swipe between books on touch screens.
- **Continue reading**: remembers the book, page and filters you had, plus your last 3 books. You can bookmark a session so it is kept.
- Rendered pages are cached on disk (size limit configurable under *Settings → General*).

### AI auto
Fills in **tags**, a **name**, a **short description** and/or a **long description** for all books, the current folder, a selection, or a single book.

Providers (set in *Settings → AI Settings*):

| Provider | Notes |
|----------|-------|
| OpenAI (API key) | Get a key at [platform.openai.com](https://platform.openai.com/) |
| Gemini (API key) | Get a key at [aistudio.google.com](https://aistudio.google.com/) |
| Gemini (free tier) | Rate-limited (one request about every 6.5 s). Google may use free-tier data. |
| ChatGPT (beta) | Sign in with your ChatGPT plan. No API key needed. |
| Ollama (local) | Install [Ollama](https://ollama.com/), pull a model and point the app at `http://localhost:11434` |

The **AI method** sets what the AI gets for each book:
- Filename only
- Filename + PDF text (the text layer, fast, works with every provider)
- Filename + cover image
- Filename + all pages (as images)
- Filename + PDF file (OpenAI, ChatGPT and Gemini only, up to 30 MB)

Other options: maximum tags per book, skip books that already have enough tags, output language, a tag vocabulary of preferred tags, extra instructions (which you can save as named prompts), and "apply results immediately". The AI method, extra instructions and tag vocabulary can be changed for a single run under **Advanced** in the AI auto window. Otherwise you review and edit the results before applying them. If some books fail (for example a scanned PDF with no text, or a file that is too large), you can retry just those books with another AI method, or tag them (default "AI failed") to find them later. Several books run in parallel, and progress updates live.

### Backup
*Settings → Backup* exports and imports the whole tag/description database as JSON.

## Keyboard shortcuts

**Library**

| Key | Action |
|-----|--------|
| `Ctrl + A` | Select all visible books (follows the current folder, search and tag filter) |
| `Ctrl + F` | Focus the search box |
| `Ctrl + B` | Show or hide the sidebar |
| `Esc` | Clear the selection |
| `Shift + Click` (on the circle) | Select or deselect a range |

**Reader**

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next book |
| `+` / `-` | Zoom in / out |
| `Ctrl + Wheel` | Zoom |
| `Esc` | Close the reader |

## Where data is stored

Everything is stored in the app data folder, `%AppData%\com.menco.pdftag\` on Windows:

- `database.json`: library folders
- `library_books.json`: books, tags, stars and descriptions
- `cache\`: cover thumbnails and the reader's page cache
- `auto_backup_before_update.json`: backup made before each Update DB

Your PDFs are never modified.

## Building from source

Requirements: [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). `pdfium.dll` must be in `src-tauri/` (it is bundled with the app).

```sh
npm install
npm run dev            # development build, uses its own data folder (com.menco.pdftag.dev)
npm run tauri build    # release build
```

`npm run dev` merges `src-tauri/tauri.dev.conf.json`, so a dev session never touches your real library. The dev build is titled "PDF Tag Simple (Dev)" and has an orange-band icon, so you can tell it apart from the installed app.

The app icon is generated from `app-icon.svg` (`npx tauri icon app-icon.svg`); the dev icon set in `src-tauri/icons/dev/` comes from `app-icon-dev.svg`.

### Project layout

```
src/                 frontend (no framework, no bundler)
  main.js            app wiring, toolbar, filters, shortcuts
  features/          one file per feature (grid, reader, summary, AI, settings, ...)
src-tauri/src/
  db.rs              folders, books, tags, backup/import/export
  scanner.rs         folder scan + thumbnail rendering
  page_cache.rs      reader page rendering and disk cache
  ai_service.rs      AI providers and prompts
  chatgpt_auth.rs    "Sign in with ChatGPT" OAuth flow
```

## Credits

The original app was created by [@mencolovepizza](https://github.com/mencolovepizza) ([original repository](https://github.com/mencolovepizza/pdf-tag-simple)). If the original saved you time, consider supporting them through the tip addresses in the upstream README.
