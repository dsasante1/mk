# mk

A standalone Markdown viewer and editor with [Harper](https://github.com/automattic/harper) built in.

Harper runs inside the app as a library (`harper-core`), not as a language server beside it, so there is nothing else to install. It checks your prose as you type: spelling, grammar and style. Code blocks, inline code and front matter are skipped, and your text never leaves your machine.

```sh
./run.sh samples/tour.md        # build once (a few minutes), then open
./install.sh                    # put `mk` on your PATH and in "Open With"
mk notes.md                     # edit
mk a.md b.md c.md               # open several files, one tab each
mk -v README.md                 # open in preview-only mode
```

The scripts above are for Linux. For macOS and Windows, see [Installing](#installing).

## Installing

Installers for each platform are attached to each [GitHub Release](https://github.com/dsasante1/mk/releases):

| Platform | Download | Notes |
| --- | --- | --- |
| Linux | `.deb`, `.rpm` or `.AppImage` | Or build from source and run `./install.sh`, below. |
| macOS (Apple silicon and Intel) | `.dmg` | Open it and drag mk to Applications. |
| Windows 10 and 11 | `-setup.exe` or `.msi` | Run it and follow the steps. |

The installers are not code-signed yet, so the first launch shows a warning:

- **macOS** says mk "cannot be opened because the developer cannot be verified". Right-click mk in Applications, choose **Open**, then choose **Open** again. You only need to do this once.
- **Windows** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.

On a Mac, the keys below use Cmd where they say Ctrl.

## What it does

**Editing.** A CodeMirror 6 editor set up for prose. Headings, emphasis, links and code are styled in place, fenced code is highlighted in its own language, and lists continue when you press Enter. It also has find and replace, multiple cursors and full undo history.

**Viewing.** A live preview with GitHub-flavoured rendering: tables, task lists, strikethrough, autolinks, heading anchors, highlighted code, raw HTML (sanitised) and front matter. Images next to the document load from disk. The preview scrolls in step with the editor. You can tick a task in the preview and the editor changes with it. A link to another Markdown file opens that file in mk.

**Several files at once.** Each open file gets a tab. Open several from the Open dialog, the command line or by dropping them on the window. A file that is already open is not opened twice. Each tab keeps its own undo history, cursor and scroll position. Click a tab or press Ctrl+Tab to switch between them. Click a tab's × (or middle-click the tab, or press Ctrl+W) to close it. A tab with unsaved changes shows a dot in place of the × and asks before it closes. Closing the window asks about every unsaved tab in turn.

**Recent files.** The clock button in the top bar (or Ctrl+Shift+O) drops down the files you opened most recently, newest first, each with its folder. Click one — or use the arrow keys and Enter — to open it; Esc closes the menu. The list is kept across restarts and shared between windows, and "Clear recent files" empties it.

**Finding your place.** A short dash for each heading sits at the right edge of the page. The dash for the section you are reading is longer and coloured, and it moves as you scroll. Click a dash to go to its section, or hover over the dashes to see the headings by name. It works in the editor-only view too, and you can turn it off in Settings.

**Finding text.** Ctrl+F, or the magnifying-glass button in the top bar, opens a find bar that works in every view. Every match is highlighted as you type, and the bar counts them ("3 of 12"). Enter and Shift+Enter (or F3 and Shift+F3) move to the next and previous match, wrapping at the ends. When the editor is showing, each match is selected in the source, and in split view the preview follows. In preview-only view the bar searches the rendered text, so "foo bar" finds `foo **bar**`, and moving to a match scrolls the preview to it. Aa turns on match case. Esc closes the bar and leaves the last match selected. Ctrl+Shift+F opens find and replace in the editor, starting from whatever you searched for.

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

**Auto save.** Turn on "Save automatically" in Settings and mk saves each file about a second after you stop typing. It also saves when you switch tabs or leave the window, and it saves files as you close them instead of asking. Auto save is off by default. Untitled documents still need Ctrl+S the first time, because mk will not choose a name for you. If another program changes a file while you have unsaved edits, auto save stops for that file and the usual reload question decides. If a save fails, mk tells you once and tries again after your next edit.

**Read aloud.** The speaker button in the top bar (or Ctrl+Shift+Space) reads the document to you, starting from the first sentence on screen. In the editor-only view it starts at the cursor. The sentence being read is highlighted in the preview, and its lines are marked in the editor; the preview scrolls to keep it in view. A bar at the bottom of the window has play and pause, previous and next sentence, stop, the speed, and a switch between reading to the end and stopping at the end of the current section. Alt+click a sentence in the preview to read from there. Alt+[ and Alt+] step back and on while reading, and Esc stops. You can keep typing while it reads: the highlight follows your edits. mk remembers where you stopped in each file and carries on from there the next time you press play. Code blocks are skipped unless you turn that off in Settings.

The voice is [piper](https://github.com/rhasspy/piper) if it is installed, which sounds natural and runs entirely on your machine. mk finds piper and its voices on `PATH`, in the [Pied](https://pied.mikeasoft.com) app's folder, in `~/.local/share/piper`, `~/.local/share/piper-voices` and `/usr/share/piper-voices`, and in `voices/` in mk's settings folder. You can also give the program's path in Settings. Choose the voice in Settings, under Read aloud, where "Hear the voice" plays a sample. Medium-quality voices start speaking sooner than high-quality ones, so "Automatic" prefers them. Without piper, mk uses your system's voices through the webview. On macOS and Windows these sound good; on Linux WebKitGTK only has Flite's, which sound robotic.

**Speech rules.** Text written to be read is not always text that sounds right. mk already drops URLs and reads "e.g.", arrows and currency properly. For anything particular to your documents, put a `.mk-speech.json` beside them, or in any folder above them; mk uses the nearest one. For example:

```json
{
  "skip": { "sections": ["Links"], "startingWith": ["Sources:"], "code": true },
  "abbreviations": ["v", "No", "Ltd"],
  "words": { "SSNIT": "snit", "Ltd": "Limited" },
  "spell": { "acronyms": true, "except": ["ECOWAS"] },
  "replace": [
    { "find": "\\bAct (\\d{3,4})\\b", "with": "Act ${digits:1}", "note": "Act 992 → Act 9 9 2" },
    { "find": "^0(\\d)\\. ", "with": "Topic $1. ", "in": "headings" }
  ]
}
```

| Key | What it does |
| --- | --- |
| `skip.sections` | Headings whose sections are not read, up to the next heading of the same or a higher level |
| `skip.startingWith` | A paragraph or list item that starts with one of these is not read |
| `skip.code` | Overrides the Settings choice about code blocks |
| `abbreviations` | Words whose full stop does not end a sentence. Common ones (Mr, Dr, e.g., No, …) are built in |
| `words` | Whole words to say differently: names the voice gets wrong, abbreviations to expand |
| `spell.acronyms` | Spell out words in capitals ("SEC" as "S E C"), except those in `except` and Roman numerals. Lines set entirely in capitals are left alone |
| `replace` | Regular expressions, applied in order to each sentence. `with` takes `$1`, `$&` and `${name:N}`, which transforms group N: `digits` ("992" as "9 9 2"), `letters` ("L.I." as "L I"), `upper`, `lower`, `roman` ("iv" as 4) and `sub` (a subsection: "a" as "A", "ii" as 2). `repeat` applies a rule until nothing changes, `in` limits it to `headings` or `text`, and `note` is for you |

The file holds regular expressions and word lists, never code, so a folder someone else wrote can change how its text is read but nothing more. A rule with a mistake in it is reported when reading starts, and the others still apply.

## Privacy and untrusted files

Grammar checking runs entirely on your machine. The one thing that goes over the network is a remote image: when a document contains `![](https://…)`, the preview fetches it, as a browser or GitHub would. That means opening a Markdown file someone else wrote can tell the server hosting its images that the file was opened, and from what IP address. Read untrusted documents in the editor-only view (Ctrl+1) if that matters to you.

Everything else about an untrusted document is contained. Raw HTML in the preview is sanitised and scripts cannot run. The preview can load local images only from the document's own folder. Links open in your browser only if they are `http`, `https` or `mailto`, and a relative link opens only if it points to a Markdown file.

## Keys

| Key | |
| --- | --- |
| Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S | New tab, open, save, save as |
| Ctrl+Shift+O | Recent files menu (arrows and Enter to open, Esc closes) |
| Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PageDown / PageUp) | Next / previous tab |
| Ctrl+W | Close tab |
| Ctrl+1 / Ctrl+2 / Ctrl+3 | Editor only, split, preview only |
| Ctrl+Shift+V | Toggle preview only |
| Ctrl+Shift+M | Harper issues panel |
| Ctrl+. | Quick fix at the cursor (1–9 picks, Enter applies, Esc closes) |
| F8 / Shift+F8 | Next / previous issue |
| Ctrl+B / Ctrl+I / Ctrl+` / Ctrl+Shift+X | Bold, italic, code, strikethrough (toggle) |
| Ctrl+K | Link. The URL placeholder is selected, ready to type over |
| Ctrl+H | Cycle heading level |
| Ctrl+F | Find in any view (Enter / Shift+Enter, or F3 / Shift+F3, to step through matches; Esc closes) |
| Ctrl+Shift+F | Find and replace in the editor |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size |
| F7 | Toggle light and dark |
| Ctrl+Shift+Space | Read aloud from where you are; pause; resume |
| Alt+[ / Alt+] | Previous / next sentence while reading |
| Alt+click in the preview | Read aloud from that sentence |
| Esc | Stop reading (once nothing else is open) |
| Ctrl+, | Settings |
| Ctrl+Q | Quit (asks if there are unsaved changes) |

You can also drop files on the window to open them.

## Settings

Settings live in `~/.config/mk/` (or `$XDG_CONFIG_HOME/mk/`) on Linux and macOS, and in `%APPDATA%\mk\` on Windows:

- `settings.json` holds the theme, view, font, wrapping, auto save, dialect (American, British, Canadian, Australian, Indian) and per-rule overrides. Rules you have not touched follow Harper's defaults, so rules added in a newer Harper arrive switched on. A malformed file never stops mk from starting. A field with the wrong type falls back to its default on its own, and keys mk does not recognise are kept when it saves.
- `dictionary.txt` is your personal dictionary, one word per line. You can edit it by hand.
- `ignored.json` holds the issues you ignored, by file.
- `speech-places.json` holds where you stopped reading aloud in each file, for the last 200 files.
- `voices/` is one place mk looks for piper voices (a `.onnx` model with its `.onnx.json` beside it).

## Building

You need Rust 1.85 or newer and Node 20 or newer, plus what Tauri 2 needs on your platform:

- **Linux:** the WebKitGTK development packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`).
- **macOS:** the Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** the Microsoft C++ Build Tools ("Desktop development with C++") and WebView2, which Windows 10 and 11 already include.

`npx tauri build` makes this platform's installers: `.deb`, `.rpm` and AppImage on Linux, `.app` and `.dmg` on macOS, and `.msi` and a setup `.exe` on Windows. `run.sh` and `install.sh` are Linux only.

To publish a release, push a version tag (`git tag v0.2.0 && git push origin v0.2.0`). The Release workflow builds the installers on all three platforms and attaches them to a draft GitHub Release. Check the draft, then publish it.

```sh
npm install
npx tauri build --no-bundle     # binary at src-tauri/target/release/mk
npx tauri build                 # also this platform's installers
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
| `src-tauri/src/speech.rs` | Read aloud: finding piper and its voices, synthesising one sentence to WAV, finding the rules file, and remembering places. |
| `src-tauri/src/main.rs` | File I/O, the command line, and the Tauri commands. |
| `src/grammar.ts` | When to lint and how to show the results. Edits made while a lint is running are mapped onto its results, so underlines never land on the wrong words. |
| `src/editor.ts` | CodeMirror setup and the formatting commands. |
| `src/markdown.ts`, `src/preview.ts` | Rendering with source-line anchors, sanitising, images, links and scroll sync. |
| `src/section-nav.ts` | The section rail: which heading you are under, and jumping between them. |
| `src/reader.ts` | Read aloud: the sentences of the rendered page and their highlights, where to start, the player bar. |
| `src/speech-text.ts`, `src/speech-rules.ts` | Splitting text into sentences, and the speech rules file with the built-in clean-up. |
| `src/speech-engine.ts` | The two voices: piper, played through an `<audio>` element one sentence ahead, and the webview's own speech. |
| `src/main.ts` | The app shell. |

## Credits and licence

mk is released under the [MIT licence](LICENSE).

Grammar checking is [Harper](https://github.com/automattic/harper) by Automattic, licensed under Apache-2.0. Read aloud uses [piper](https://github.com/rhasspy/piper) when it is installed; it is not bundled with mk. mk also builds on [Tauri](https://tauri.app), [CodeMirror](https://codemirror.net), [markdown-it](https://github.com/markdown-it/markdown-it), [DOMPurify](https://github.com/cure53/DOMPurify) and [highlight.js](https://highlightjs.org), each under its own permissive licence.
