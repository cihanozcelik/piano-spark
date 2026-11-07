# Piano Spark website content

This copy is grounded in the current application. Public marketing copy is English.
The product name is **Piano Spark**. Real application screenshots carry the main
product story; generated keyboard artwork is supporting atmosphere, not a screenshot.

## Hero

**Your piano. Your pace.**

Follow the notes. Play the right keys. Piano Spark waits until you’re ready to
move on — so you can focus on making music, one phrase at a time.

Primary action: **Download for Mac** when a published binary is available.
Pending state: **Download coming soon**, without a live download link.
Secondary action: **See how practice works** (in-page section).
Requirements: **macOS 14 or later · Apple Silicon**.

Use the real practice screenshot directly below the main statement, large enough
to read the score, see the falling notes and identify the keyboard together.

## The differentiator

**Music that waits for you.**

Piano Spark follows the keys you actually play. When the notes aren’t right,
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
**Apple Silicon Mac · macOS 14 or later. Bluetooth connection is currently configured
for Yamaha CLP-835.**

The current native connection starts the BLE helper without a custom device name,
and that helper defaults to CLP-835. There is no general device picker in the app.
Do not claim that every Bluetooth or USB MIDI keyboard is currently supported.

## Download

**Your next practice starts here.**

Download Piano Spark for Mac.

Use the published release’s exact asset URL. The primary button must download the
binary, not open the GitHub releases listing. Keep a separate **Release notes** link.
If the release does not exist, show a disabled pending state instead of presenting
an active Download button.

Small supporting information:

- **No account required.**
- **Small DMG download.** Drag Piano Spark to Applications. There is no separate installer app. Lesson tools download at first use with visible size, progress and cancellation. They remain on the Mac across app updates.
- **Smaller updates afterward.** Unchanged model files are not downloaded again in normal delta updates.

Do not promise that every update is 16 KB or 24 KB: those measurements describe
specific local changes. Updates that change models or repair an installation can
be larger. The app may restart automatically for updates, including during practice;
do not claim updates always wait until a lesson ends.

## Current-source evidence

- `practice-clock.js`: expected/pending notes, key holds, release allowance and incorrect-key blocking.
- `player.js`: part/channel selection, tempo, Listen/Practice, seeking, whole-lesson repeat and checkpoints.
- `sheet-music.js` / `staff-notation.js`: score rendering and note display.
- `workspace-state.js`: local persistent controls, layout, lesson selection/position and draft state.
- `create-lesson.js` / `lesson-engine/worker.py`: video, YouTube, MIDI and PDF import paths.
- `desktop/main.m` / `bluetooth-connection/main.m`: native BLE service and CLP-835 target.
- `desktop/release.py` / `desktop/UpdateController.m`: signed delta update publication and automatic restart.
