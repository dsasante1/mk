# mk

A standalone Markdown viewer and editor with [Harper](https://github.com/automattic/harper) built in.

Harper runs inside the app as a library (`harper-core`), not as a language server beside it, so there is nothing else to install. It checks your prose as you type: spelling, grammar and style. Code blocks, inline code and front matter are skipped, and nothing leaves your machine.

```sh
./run.sh samples/tour.md        # build once (a few minutes), then open
./install.sh                    # put `mk` on your PATH and in "Open With"
mk notes.md                     # edit
mk -v README.md                 # open in preview-only mode
```

## What it does

**Editing.** A CodeMirror 6 editor set up for prose. Headings, emphasis, links and code are styled in place, fenced code is highlighted in its own language, and lists continue when you press Enter. It also has find and replace, multiple cursors and full undo history.

**Viewing.** A live preview with GitHub-flavoured rendering: tables, task lists, strikethrough, autolinks, heading anchors, highlighted code, raw HTML (sanitised) and front matter. Images next to the document load from disk. The preview scrolls in step with the editor. You can tick a task in the preview and the editor changes with it. A link to another Markdown file opens that file in mk.

**Harper.** Underlines come in three colours:

| | Group | Harper kinds |
| --- | --- | --- |
| red | Spelling | Spelling, Typo |
| amber | Grammar | Grammar, Agreement, Punctuation, Capitalization, Repetition, Usage, … |
| blue, dotted | Style | Style, Readability, Redundancy, Word choice, … |

Each issue offers Harper's fixes plus three more actions:

- **Add to dictionary** (spelling only). The word goes into your personal dictionary and is accepted in every document.
- **Ignore here.** Hides this one issue in this file. It stays hidden across edits and restarts, because mk stores Harper's context hash (the lint plus the words around it), not a position.
- **Turn off rule.** Disables the rule everywhere. You can turn it back on in Settings.

You can reach these actions by hovering an underline, pressing Ctrl+. on it, or using the issues panel (Ctrl+Shift+M). The panel lists every issue with its context and can be filtered by group.

**Staying current.** mk polls the open file every two seconds. If it changes on disk and you have no unsaved edits, mk reloads it silently, so you can leave it open as a viewer beside another editor. If you do have unsaved edits, mk asks before reloading. Line endings (LF or CRLF) are kept as they were. Saves are atomic, and they keep symlinks and file permissions intact.

## Keys

| Key | |
| --- | --- |
| Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S | New, open, save, save as |
| Ctrl+1 / Ctrl+2 / Ctrl+3 | Editor only, split, preview only |
| Ctrl+Shift+V | Toggle preview only |
| Ctrl+Shift+M | Harper issues panel |
| Ctrl+. | Quick fix at the cursor (1–9 picks, Enter applies, Esc closes) |
| F8 / Shift+F8 | Next / previous issue |
| Ctrl+B / Ctrl+I / Ctrl+` / Ctrl+Shift+X | Bold, italic, code, strikethrough (toggle) |
| Ctrl+K | Link. The URL placeholder is selected, ready to type over |
| Ctrl+H | Cycle heading level |
| Ctrl+F | Find and replace |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size |
| F7 | Toggle light and dark |
| Ctrl+, | Settings |
| Ctrl+Q | Quit (asks if there are unsaved changes) |

You can also drop a file on the window to open it.

## Settings

Settings live in `~/.config/mk/` (or `$XDG_CONFIG_HOME/mk/`):

- `settings.json` holds the theme, view, font, wrapping, dialect (American, British, Canadian, Australian, Indian) and per-rule overrides. Rules you have not touched follow Harper's defaults, so rules added in a newer Harper arrive switched on. A malformed file never stops mk from starting. A field with the wrong type falls back to its default on its own, and keys mk does not recognise are kept when it saves.
- `dictionary.txt` is your personal dictionary, one word per line. You can edit it by hand.
- `ignored.json` holds the issues you ignored, by file.

## Building

You need Rust 1.85 or newer, Node 20 or newer, and the WebKitGTK development packages Tauri 2 uses on Linux (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`).

```sh
npm install
npx tauri build --no-bundle     # binary at src-tauri/target/release/mk
npx tauri build                 # also a .deb and an AppImage
npm run app                     # dev build with hot reload

npm test                        # frontend unit tests (vitest)
npx tsc --noEmit                # typecheck
cargo test --manifest-path src-tauri/Cargo.toml    # Harper bridge, settings, CLI
```

## How it is put together

| | |
| --- | --- |
| `src-tauri/src/grammar.rs` | Harper on its own thread. It keeps one `LintGroup` for the app's lifetime, so Harper's per-sentence cache works, and it answers only the newest request. It also converts Harper's `char` offsets to the UTF-16 offsets JavaScript uses. |
| `src-tauri/src/settings.rs` | Tolerant settings, the dictionary, ignored issues, and atomic writes. |
| `src-tauri/src/main.rs` | File I/O, the command line, and the Tauri commands. |
| `src/grammar.ts` | When to lint and how to show the results. Edits made while a lint is running are mapped onto its results, so underlines never land on the wrong words. |
| `src/editor.ts` | CodeMirror setup and the formatting commands. |
| `src/markdown.ts`, `src/preview.ts` | Rendering with source-line anchors, sanitising, images, links and scroll sync. |
| `src/main.ts` | The app shell. |
