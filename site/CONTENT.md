# rach3 website content

This copy is grounded in the current application. The site is in English and Turkish;
the Turkish text lives in `site/tr.json` (see the README).
The product name is **rach3**. Real application screenshots carry the main
product story; generated keyboard artwork is supporting atmosphere, not a screenshot.

## Hero

**Your piano. Your pace.**

Follow the notes. Play the right keys. rach3 waits until you’re ready to
move on — so you can focus on making music, one phrase at a time.

Primary action: **Download for Mac** when a published binary is available.
Pending state: **Download coming soon**, without a live download link.
Secondary action: **See how practice works** (in-page section).
Requirements: **macOS 14 or later · Apple Silicon and Intel** (from 0.9.0, the first universal
release; `site/build.py` keeps Apple Silicon only wording for older published releases).

Use the real practice screenshot directly below the main statement, large enough
to read the score, see the falling notes and identify the keyboard together.

## The differentiator

**Music that waits for you.**

rach3 follows the keys you actually play. When the notes aren’t right,
the lesson pauses. Find the chord, hold it, and move on when you’re ready.

1. **See what’s next.** Read the score or follow the notes down to the keyboard.
2. **Play the right keys.** Press a note or chord on your connected piano.
   The lesson waits for missing notes and extra keys to be corrected.
3. **Hold. Release. Continue.** Keep each note down for its indicated duration,
   then release it as the music moves forward.

This is an interactive practice clock, not a video that keeps playing while you
catch up. Do not turn this into a claim about scoring, finger technique, posture,
automatic difficulty adjustment or a complete learning curriculum.

## Understand the music

**Two ways to see it. One place to practice.**

Traditional sheet music sits above the falling-note view. Follow the musical
phrase, see which keys come next, and keep your hands oriented with blue and coral
parts. The score and keyboard follow the same lesson position.

Small product callouts can identify **Score**, **Falling notes**, **Keyboard**, and
**Sustain** next to the relevant parts of the actual screenshot. Do not draw these
as if they were controls inside the app.

## Practice controls

**Make the difficult part feel possible.**

- **Set your tempo.** Slow down while you learn the notes, then bring the speed back up.
- **Focus on a hand or part.** Work with a separate part before bringing the music together.
- **Listen, then play.** Hear the lesson before switching into guided practice.
- **Come back where you left off.** Your lesson position and workspace settings are saved.

Use “repeat the lesson” for the Repeat control. The current implementation restarts
the entire lesson at its end. It does not provide A–B selection or loop an arbitrary
section. Seeking back to a passage is supported, but must not be described as an
A–B loop. Hand names are present in lessons with separate hand parts; imported MIDI
can instead expose instrument/channel parts.

## Create a Lesson

**Bring the music you want to play.**

Start with a video, a YouTube link, a MIDI file or a sheet-music PDF. Create a lesson,
save it to your library, and practice it with the same guided controls.

- **Video & YouTube.** Turn an audio performance into a practice lesson.
- **MIDI.** Import existing note timing, velocity and sustain information.
- **Sheet-music PDF.** Try turning printed notation into playable notes.

Show the actual Create a Lesson screenshot here, including the supported source
choices and saved lessons area. The source options should not look like separate
products or subscriptions.

Small caveat: **Audio and PDF transcription is experimental and can contain note
or rhythm errors. Review the result before practicing.**

Privacy/supporting line: **Local files are processed on your Mac. YouTube requires
an internet connection.** Do not claim all processing is instant, all songs are
accurately transcribed, PDF pedal markings are preserved, or that the app contains
a score editor for correcting transcription.

## Your piano and your Mac

**A practice space that feels like yours.**

Use a full-screen workspace, adjust the score and keyboard panels, and keep your
attention on the instrument in front of you. The app includes the tools it needs;
there’s no separate runtime to install and no account to create.

Compatibility detail, visible near setup/download:
**Apple Silicon or Intel Mac · macOS 14 or later. Pianos with standard Bluetooth MIDI
appear in the app's device list.**

One universal download serves both kinds of Mac; the download section shows both
chips and how to check which one a Mac has (Apple menu → About This Mac). On Intel,
vocal separation runs on the processor and takes longer; say so plainly.
The app scans for the standard BLE-MIDI service without a brand filter. Do not claim
that every Bluetooth keyboard has been tested, and do not claim USB MIDI support.
Bluetooth audio alone does not carry keys.

## Download

**Your next practice starts here.**

Download rach3 for Mac.

Use the published release’s exact asset URL. The primary button must download the
binary, not open the GitHub releases listing. Keep a separate **Release notes** link.
If the release does not exist, show a disabled pending state instead of presenting
an active Download button.

Below the Mac details, when the release has `rach3-win-Setup.exe`, show a
secondary **Download for Windows (beta)** link with “Windows 10 or 11 · 64-bit” and its
size, and say plainly that Windows may warn about an unsigned beta (More info → Run
anyway). Without that asset, show nothing about Windows.

Small supporting information:

- **No account required.**
- **Small DMG download.** Drag rach3 to Applications. There is no separate installer app. Lesson tools download at first use with visible size, progress and cancellation. They remain on the Mac across app updates.
- **Smaller updates afterward.** Unchanged model files are not downloaded again in normal delta updates.

Do not promise that every update is 16 KB or 24 KB: those measurements describe
specific local changes. Updates that change models or repair an installation can
be larger. The app may restart automatically for updates, including during practice;
do not claim updates always wait until a lesson ends.

## Beta and open source

The whole app is a **public beta**, on Mac and Windows. Say so in the header (a small
**Beta** badge), the hero eyebrow and the release label, and keep one plain sentence
near the hero: free and open source, still in beta, expect rough edges, with a link to
issues. Do not call any part of the app finished or stable.

**Open to everyone. Built in the open.** rach3 is free software under the GNU
AGPL v3. Link the source code, issues and `LICENSE`. The beta panel names what can go
wrong: features still change, lessons from recordings or PDFs can have wrong notes or
rhythms, Windows Bluetooth is not yet tested with many pianos, and updates arrive
automatically.

**Built on open research.** Credit the models and their teams by name, as people, not
logos: Rubato (Nazif Can Tamer, Victoria Ebert, Guang Yang, Noah A. Smith; NeurIPS
2026), the Mel-Band RoFormer vocal model (Kimberley Jensen; architecture by Ju-Chiang
Wang, Wei-Tsung Lu and Minz Won; run with python-audio-separator by Nomad Karaoke),
homr (Christian Liebhardt, building on oemer and Polyphonic-TrOMR; text by RapidOCR
with PaddleOCR models), Verovio (RISM Digital Center) and music21 (Michael Scott Asato
Cuthbert and contributors). Link `CREDITS.md` for the full list and licenses, and keep
both in sync when a model changes.

## Current-source evidence

- `practice-clock.js`: expected/pending notes, key holds, release allowance and incorrect-key blocking.
- `player.js`: part/channel selection, tempo, Listen/Practice, seeking, whole-lesson repeat and checkpoints.
- `sheet-music.js` / `staff-notation.js`: score rendering and note display.
- `workspace-state.js`: local persistent controls, layout, lesson selection/position and draft state.
- `create-lesson.js` / `lesson-engine/worker.py`: video, YouTube, MIDI and PDF import paths.
- `electron/bluetooth.js` / `electron/bluetooth-page.js`: Bluetooth MIDI over Web Bluetooth with brand-independent discovery, the same on Mac and Windows.
- `electron/lessons.js` / `lesson-engine/tools-x86_64.json`: universal app, per-architecture runtime and Intel tools.
- `desktop/release.py` / `desktop/UpdateController.m`: signed delta update publication and automatic restart.
