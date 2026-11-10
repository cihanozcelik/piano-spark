# rach3 interface: a guide for changing it

This folder is the interface of rach3, a free piano practice app for Mac and Windows.
The person using the app asked you for a change. They are not a programmer. Make the
change they asked for and nothing else, then check it with `rach3.preview`.

## How your work is kept

- This folder is a scratch copy of the design on the person's screen. The original
  app is never changed.
- When you finish, rach3 compares this folder with the design you started from. If
  files differ, it saves them as a new design, shows it on screen and keeps the
  earlier one, so the person can switch back at any time.
- A change that breaks the page is still saved, so preview before you finish.
- You cannot reach the internet, install packages, use git, or read files outside
  this folder. You do not need any of that.

## Tools

| Tool | Use it to |
| --- | --- |
| `rach3.preview` | Open this folder in a hidden rach3 window and get a screenshot and runtime errors. Pass `script` (an async function body that may `return`) to act before the screenshot, for example `document.getElementById('tab-create').click()`. Call it after every change. |
| `rach3.page_errors` | Read errors seen on the person's screen in the design they are using. Use it when they say something is broken. |
| `rach3.list_lessons` | List the person's lessons. |
| `rach3.read_lesson` | Read a lesson's notes, optionally a time range. |
| `rach3.save_lesson` | Create a lesson, or change one by id. The old version is backed up. |

## How the page works

- `piano.html` loads `i18n.js`, `i18n-messages.js`, then `player.js` as an ES module,
  then `desktop.js`. Modules import each other with relative paths (`./file.js`).
- Everything is plain JavaScript and CSS. No build step, no framework.
- The page talks to the native app with
  `window.webkit.messageHandlers.rach3.postMessage({command, ...})` and receives
  events as `window` events named `rach3-native-event`. Keep that contract as it is.
  In the preview, commands that would change something are ignored.

## Files

| File | What it holds |
| --- | --- |
| `piano.html` | The layout and all CSS, in one `<style>` block at the top. After the markup comes the bundled Tone.js (`<script id="midi-library">`, do not edit) and the built-in example song (`#rubato-song-data`). |
| `player.js` | The practice screen. `draw()` paints the falling notes, the time grid and the keyboard on a canvas every frame. Hand colours are `const colors = ['#75a7ff','#efab91']` (left, right). Transport (play, rewind, speed, seek, loop), track and mode selection, practice settings and profiles are wired here too. |
| `practice-clock.js` | Matches played notes to the score; timing profiles (easy, normal, hard). |
| `practice-session.js` | Practice plans: whole piece, row by row, build up; progress. |
| `sheet-music.js` | Engraves the score with Verovio into `#sheet-paper` and follows playback. |
| `staff-notation.js` | Small staff badges on the falling bars, drawn with the Bravura font. |
| `hand-reach.js` | Adapts wide chords to the player's measured hand span. |
| `piano-input.js` / `piano-output.js` | Notes from the piano; notes sent to the piano. |
| `bluetooth.js`, `bluetooth-diagnostics.js` | The piano connection panel (`#bluetooth-panel`). |
| `create-lesson.js` | The Create a Lesson tab (`#create-panel`): video, YouTube, MIDI and PDF import. |
| `app-shell.js` | Tabs, the lesson list and the lesson menu. |
| `workspace-state.js` | What the app remembers between launches (localStorage `rach3.workspace.v1`). |
| `i18n.js`, `i18n-messages.js` | English and Turkish text. |
| `desktop.js` | Full screen and title bar behaviour. |
| `assets/` | The Bravura music font, the logo and the notation engine. Do not edit `assets/notation`. |

## Look and feel

- Colours are CSS variables on `:root` in `piano.html`: `--bg #171719`, `--panel #222225`,
  `--raised #2c2c30`, `--line #ffffff12`, `--ink #f1f1f3`, `--muted #96969f`,
  `--accent #86b8ff`, `--hand-left #75a7ff`, `--hand-right #efab91`, `--target #c5d8ff`.
  Canvas colours in `player.js` are separate literals; change both when a colour
  should match.
- The header is `.app-bar`, 48 px tall. Its left side leaves room for the Mac window
  buttons. Keep its height.
- Main regions: `#practice-panel` (score `#sheet-viewport`, falling notes `#roll`,
  keyboard `#keyboard`, transport at the bottom) and `#create-panel`.
- The app is dark. Keep text readable on dark backgrounds.

## Text and languages

The app is in English and Turkish. Turkish strings in the markup and code are the
keys: elements carry `data-i18n="Türkçe metin"`, and code calls
`window.PianoI18n.t('Türkçe metin')`. The English for every key is in `i18n.js`
(static text) or `i18n-messages.js` (messages). When you add visible text, write
the Turkish key and add its English entry, so both languages work.

## Lessons

A lesson is the piece the person practises. Lessons live outside this folder; use
the lesson tools. Notes are `[midi, start, end, velocity]`: MIDI number 21 to 108
(60 is middle C), start and end in seconds from the beginning, velocity from 0 to 1.
Hand 0 is the left hand, hand 1 the right. A lesson made or edited with
`save_lesson` has no engraved score; the falling notes still work.

## Rules

- Keep it fast: `draw()` runs every frame. No heavy work, layout reads or
  allocations in it.
- Do not remove or hide features the person did not ask to change.
- Keep the page working without a piano connected.
- Answer the person in a few plain sentences, in their language, without code.
