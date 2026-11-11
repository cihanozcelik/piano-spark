# rach3

A desktop piano learning app built around practicing on a physical piano at your own pace.
The small, self-contained application supports **Macs running macOS 14 or later, with Apple Silicon or
Intel processors**. See [Intel Macs](#intel-macs) for how lesson creation differs there.
A **Windows 10 and 11 (64-bit) beta** is published with each release; see [Windows (beta)](#windows-beta).

[Website](https://rach3.com/) · [Download the latest release](https://github.com/cihanozcelik/rach3/releases/latest)

rach3 is **free and open source** under the [GNU AGPL v3.0](LICENSE), and the
whole app is in **public beta**: practice works day to day, but features are still
changing and lessons made from recordings or PDFs can contain wrong notes or rhythms.
Please [report what you find](https://github.com/cihanozcelik/rach3/issues).

Lesson creation is built on open models and libraries, including
[Rubato](https://github.com/nctamer/rubato-transcription),
the Mel-Band RoFormer vocal model, [homr](https://github.com/liebharc/homr),
[Verovio](https://github.com/rism-digital/verovio) and
[music21](https://github.com/cuthbertLab/music21). See [CREDITS.md](CREDITS.md) for
every model, its authors and its license.

## Installation and distribution

**`dist/rach3-Setup.dmg`** contains **rach3.app** and an **Applications**
shortcut. Drag the app onto that shortcut, then open the installed copy from
Applications. There is no separate Installer application. Existing installations
receive automatic updates in place, preserving saved lessons.

Users do not need to install Python, Rubato, or other packages. A small portable
Python runtime is bundled with the app. Transcription, vocal separation, and PDF
recognition tools download on first use. Each option displays its download size;
downloads show progress, transferred and total bytes, and speed. Cancelling keeps
downloaded data. Once the tools are downloaded, local files can be processed offline;
YouTube imports require an internet connection. The app does not install system
Python, Homebrew, login items, or system services.

**rach3 → Uninstall rach3…** asks for confirmation, stops the app's
running jobs, and removes the application, downloaded tools,
`~/Library/Application Support/Rach3/`, app preferences, WebKit data, caches,
and saved window state. Saved lessons are also removed. Original videos, exported
MIDI files, and downloaded DMG files remain untouched. Deleting only the app in
Finder does not delete saved lessons. The development repository and its separate
development data are outside the uninstaller's scope.

Use the **Full screen** button, the window's green button, or **Ctrl+⌘+F** to enter
full screen. The piano and falling notes use the full window width, including in
full screen. `Rach3.command` also opens the compiled application.

The package is locally signed with an ad-hoc signature; it is not Developer ID
signed or notarized. macOS may require security approval when opening a downloaded
copy for the first time. This is a limitation of the current distribution package.

## Automatic updates

The app downloads new versions as small signed ZIP archives or, when available,
delta updates. Downloaded lesson tools live in Application Support and do not need
to be downloaded again when the app updates. The update indicator in the top bar
shows the new version and its release notes.

Once an update is verified, the current implementation saves the lesson position
and automatically restarts the app, even during a lesson. Any ongoing conversion
job is cancelled. The new-version notification and release notes remain available
in the top bar. Downloads and updates do not require a GitHub account or access token.

See [the update system guide](desktop/UPDATES.md) for publishing, signing, and initial setup.

## Building from source

`main` only changes through pull requests merged on GitHub; locally it is only updated
with `git pull`. Work on a branch. After cloning, enable the repository's git hooks.
They refuse commits on `main` and pushes to it. They also refuse anything else that
would move local `main` away from `origin/main`, such as a merge or a reset:

```sh
git config core.hooksPath .githooks
```

GitHub enforces the same rule for every push, with or without the hooks.

The developer machine needs Python 3, Node.js 22 and Xcode Command Line Tools.

1. Run `python3 desktop/prepare_engine.py` to prepare the small Apple Silicon and Intel Python runtimes. This step requires uv.
2. Run `npm ci`, then `node node_modules/electron/install.js`, to fetch the Electron shell the app is built on.
3. Run `./build-app.command` to bundle the application and both runtimes, apply an ad-hoc signature, and create `dist/rach3-Setup.dmg`. The app is universal when the Intel build of the same Electron version is in `build/electron/darwin-x64/` (the release workflow fetches and checks it); without it the app is built for this Mac's processor only.

`npm start` opens the same shell from the sources, without building; it keeps its data in the
development folder (`Rach3Development`), apart from the installed app's.

`python3 desktop/build.py --app-only` builds only the application.
`python3 desktop/build.py --installer-only` creates the DMG from an existing app bundle.

`node --test tests/*.test.js` runs the practice tests; it needs only Node.js.

Packaging inputs and the engine lifecycle are documented in
[`lesson-engine/README.md`](lesson-engine/README.md). `build/` and `dist/` contain
generated files and are excluded from Git. Everyday UI development does not require
repackaging; use the browser development workflow below.

## Intel Macs

The app is a universal binary. Practice, Bluetooth, MIDI and PDF import, and
lesson creation from audio and YouTube work the same way on Intel. Intel lesson
tools come from `lesson-engine/tools-x86_64.json`: PyTorch stopped publishing Intel
macOS packages after 2.2.2, so Intel uses PyTorch 2.2.2 with numpy 1.26 and the
other packages that still support them. `lesson-engine/torch_compat.py` adds the
two small PyTorch 2.3 functions that vocal separation expects.

Lessons created from audio on Intel match Apple Silicon: for the same recording,
notes, timing, velocity, pedal, rhythm, and score are identical, and separated
accompaniment differs only below 16-bit resolution. PDF recognition uses an older
ONNX Runtime on Intel and can read a few measures differently; on the bundled Bach
example Apple Silicon reads 608 notes and Intel 608–609, and both match its
reference MIDI about equally well.
Vocal separation runs on the processor rather than the graphics processor on Intel,
so it is considerably slower there.

## Windows (beta)

The Windows app is the same program as the Mac app: the Electron shell in `electron/`
(one JavaScript implementation of the window, lessons, Bluetooth, the ChatGPT features
and settings) around the same page and lesson engine. `windows/build.py` packages it.
The page itself is unchanged; `windows/wording.py` replaces every Mac-specific sentence
with Windows wording, and the build fails if a page string mentions the Mac without one.

- **Lesson engine:** the same Python worker with a portable Windows Python. Lesson
  tools come from `lesson-engine/tools-win_amd64.json`, generated on a Mac with
  `python3 windows/prepare_lock.py` and `python3 desktop/lock_tools.py win_amd64`.
  Windows lessons match the Mac: the Bach MIDI makes 549 notes, the PDF 608 and the
  audio test the same 20 notes.
- **Bluetooth MIDI:** the same code as on the Mac (`electron/bluetooth.js`, Web
  Bluetooth). It has not yet been tried with a real piano on a Windows PC.
- **Installer and updates:** Velopack. `rach3-win-Setup.exe` installs per user
  without administrator rights. Each release also carries a patch from the previous
  Windows release (0.9.1 → 0.9.2: 1.1 MB instead of 26 MB), applied to the installed
  package; without it, the full package is downloaded. Updates download in the
  background and install on quit. Every file must be listed in `releases.win.json`,
  whose Ed25519 signature from the same release key as the Mac app is checked first;
  Velopack then verifies each download against those signed SHA-256 values.
  The installer is not yet signed with a publisher certificate, so SmartScreen warns
  on first launch (More info → Run anyway).
- **Checks:** `.github/workflows/windows.yml` and the `windows` job of the release
  workflow create lessons on a real Windows machine, open the app and take
  screenshots, create a lesson through the page bridge, then install with
  `Setup.exe` and create a lesson with the installed app. They also update an
  installed test version through a signed patch alone (the full package is withheld)
  and check that a feed signed with another key is refused. Nothing is published
  unless these pass.

Build on Windows with Python 3.12, uv and Node.js 22: `npm ci`,
`node node_modules/electron/install.js`, then `python windows/build.py`
(add `--package` for the installer; it needs the .NET SDK for
`dotnet tool install -g vpk --version 1.2.161`).

## Language selection

The **English / Türkçe** selector in the top bar immediately changes the practice
screen, lesson creation interface, application menus, and status messages while
preserving the open lesson and its position. The desktop app stores the preference
in native application settings; the browser stores it locally. Lesson titles and
user content are not translated. macOS and Sparkle system dialogs follow the
operating system's language. Website screenshots use the English interface in an
isolated capture build.

## Application features and architecture

### Playback and lesson imports

**View → Playback sound** selects either **App synthesizer** or
**Connected piano · Bluetooth MIDI**. Piano output sends MIDI notes, velocity, and
sustain through the existing connection; the app synthesizer does not play at the
same time. Adjust playback volume on the piano itself. If the connection is not
ready, Listen reports an explanatory error instead of silently switching outputs.
The output preference is saved. Changing the output pauses playback; seeking or
changing speed rebuilds the note and pedal schedule at the new position. Physical
key input in Practice mode is unchanged. The browser and packaged app use the same
local BLE sender, with no extra end-user package installation.

**Delete** next to a saved lesson removes the lesson and the app's source copy,
preserving the original file. **Create a Lesson → MIDI / PDF** or
**Import MIDI / sheet music PDF…** in the lesson menu imports a file into the
persistent lesson library. MIDI imports preserve timing, velocity, and CC64 data.
PDF recognition uses homr/ONNX without Java and supports progress reporting and
cancellation. PDF import is experimental: it does not transcribe pedal symbols and
can produce pitch and rhythm errors. Detected rhythmic inconsistencies appear in
the score status. If no numeric tempo is found, the selected fallback tempo is used.
Examples and licenses are in
[`assets/example-lessons/README.md`](assets/example-lessons/README.md).

Settings, the selected lesson and playback position, score page, horizontal scroll,
and panel sizes are saved. The desktop window's size and position are also preserved.
Playback never starts automatically on launch. Bluetooth connects automatically
only when the user has enabled that preference for the default device. The browser
and desktop app maintain separate workspaces.

`python3 tools/prepare_omr.py` prepares the PDF engine's development dependencies;
end users do not run this command.

### Practice workspace and built-in lesson

The **Practice** tab contains one lesson title, compact playback controls, and a
note display and keyboard that fill the remaining window. Left-hand notes are blue;
right-hand notes are coral. Bluetooth details live in the piano control in the top
bar. The **View** panel contains notation, zoom, loop, and listening volume options.
The menu beside the lesson title provides imports, saved lessons, and the built-in
**A Small Measure of Peace · Rubato** lesson. Downloading the lesson's MIDI exports
the selected lesson.

The Video and Transkun V2 versions have been removed from the lesson menu and app
bundle. If a saved selection refers to either removed lesson, the app falls back
to Rubato on launch.

The experimental Rubato lesson contains 636 notes from overlapping 40-second audio
analysis windows using Rubato's notation output. Note durations are unchanged; only
the 5.64-second gap before the first model note is removed. Left and right hands come
from the model's PL/PR parts, without information from the visual-reference lesson.

Note-on events from Rubato's MIDI output for the same audio are matched one-to-one
by pitch and an onset difference of at most 150 ms. This supplies velocities for
all 636 notes, ranging from 38 to 84. Sustain comes from CC64 events in the same
output. Since the model predicts sustain as pressed for almost the entire piece,
this is not presented as verified pedal movement. Compared with the accepted first
lesson, 129 notes still have duration errors greater than 250 ms, so the result is
labelled experimental. To embed the data again, run
`transcription/rubato/.venv/bin/python transcription/rubato/embed_lesson.py`,
then rebuild the app. Auditory and visual acceptance checks are performed by the user.

### Layout, sheet music, and expression

Mode and hand selection are centered in the top bar, with app tabs and lesson
selection on the left and Bluetooth on the right. Listen/Start, rewind, and speed
controls sit to the left of the timeline. Dropdowns share consistent text and arrow
alignment. Score page controls float at the upper right of the score area, and the
View button floats at the upper right of the piano area; both stay in place while
their content scrolls.

Drag the horizontal dividers between the score and falling notes, or between the
falling notes and keyboard, to resize the panels. The dividers are also keyboard
accessible. Sizes are saved in the browser or app and constrained to the available
height when the window shrinks. `app-shell.js` owns the layout; `player.js` owns the
renderer that responds to size changes.

Sustain appears in a purple lane directly beside the right edge of the keyboard.
Held intervals fall from the top using the same six-second view as the note bars.
The pedal icon at keyboard level shows the pressed or released state. The lane
combines CC64 intervals from the selected parts and follows the same lesson clock
during seeking, speed changes, and practice pauses. There is no horizontal pedal
timeline.

Above the falling notes, the score uses traditional black piano notation on lightly
textured white paper. music21 writes treble and bass clefs, measures, rhythmic note
values, rests, ties, dynamics, and sustain markings to MusicXML; Verovio renders it.
Page buttons and Expand provide navigation. During playback, a red time cursor spans
both staves, active notes are colored, and the view follows the current system.
The cursor and colors use the player clock: they stop while practice waits and
update when seeking. Pages can be browsed manually while playback is paused.

On first load, the score area shows engine preparation, time mapping, and the number
of rendered pages. Engraving runs in a separate Worker; switching lessons terminates
the previous job.

Meter, rhythm, and key are Rubato estimates. Dynamics are derived from velocity,
and pedal markings from CC64. Overlapping source windows are combined on a shared
rhythmic clock; meter changes require agreement between independent windows. Only
an approximate initial tempo is displayed. Small timing differences are mapped to
readable sixteenth- or thirty-second-note values; triplets absent from the source
are not invented solely to express precise timing.

Hand-marker losses supported by evidence in the raw Rubato text are corrected
automatically only in the Rubato lesson's score. The visual-reference lesson's hand
assignments are preserved. A notation engine does not automatically correct the
model's wrong duration or hand predictions. This is not a verified printed edition.
Quantization for engraving does not alter the player's actual onset or key-release
times.

Existing Peace lessons use the stored Peace Rubato measures. The existing Pervane
lesson uses the stored raw-audio Rubato measures while retaining its accepted notes
from separated audio. New video lessons use measures from their own analysis.
`transcription/separation/.venv/bin/python tools/update_notation.py` regenerates
existing scores from the source windows. Older lessons without score data remain
usable with falling notes; the app does not fabricate a score for them.

The View menu shows velocities for held and upcoming notes on a 1–127 scale, and
note bars contain small velocity indicators. Velocity and pedal matching are
optional in Practice: differences do not stop the exercise. In Listen mode,
velocity affects volume and timbral brightness, while sustain keeps sound ringing
after key release without triggering release damping. Natural string decay
continues; voices that become inaudible are stopped even while sustain is held.
Seeking, pausing, and changing parts use the same note and pedal timeline.
In Listen mode, clicking a measure on the score plays from the start of that measure,
whether playback is running or paused (a measure that opens with a rest keeps its rest).
The playing measure is tinted on the score. Speed and part selection are unchanged, and
Practice ignores score clicks. A measure's clickable area and the playhead follow its
staves, so pedal lines or slurs that run past a barline do not widen it.

Lesson MIDI downloads include original key-release times, velocities, and CC64
messages on each hand's channel. Imported MIDI files also display sustain from the
selected channels and apply it in Listen mode.

### Creating lessons

**Create a Lesson** accepts a local video or YouTube URL. Choose a title and optional
vocal separation, then select **Create lesson**. Progress and cancellation are
available on the same screen. The result is saved to the persistent lesson library
and can be opened from this tab or the menu beside the lesson title.

Vocal separation also leaves other accompaniment instruments in the audio. The
resulting notes are piano transcription model estimates; no visual reference or
manual duration correction is used. Velocity and pedal estimates affect Listen
mode but are not required for practice. The lesson description reports the number
of notes without a velocity match.

`app-shell.js` owns the tabs and popover tool panels. `create-lesson.js` owns the
selected video file in memory, its preview URL, and the draft YouTube URL. Leaving
Practice pauses playback while preserving lesson position, settings, and Bluetooth.
Leaving Create pauses the video preview. The hidden practice workspace is not
measured or rendered; it is resized when shown again. Practice shortcuts and MIDI
drag-and-drop are active only in Practice.

### Native application and engine ownership

The app is one Electron shell for Mac and Windows. `electron/main.js` owns the
window, the menus and the page's bridge; the page cannot reach the internet.
`desktop/build.py` (Mac) and `windows/build.py` combine the player's JavaScript
modules and embedded note data into one offline HTML resource and package it with
the shell. Audio and animation run inside the page. `electron/lessons.js` owns one
analysis job; `lesson-engine/worker.py` runs the models in a separate process using
bundled Python. `electron/customize.js` runs the ChatGPT features with the bundled
Codex, under Codex's own permissions profile. Updates stay with each system's own
updater: Sparkle on the Mac (`desktop/UpdateController.m`, loaded by the shell as
`electron/native/updates.m`) and Velopack on Windows (`electron/updates-windows.js`).
Local files and imported notes are not uploaded.

What the page had saved in the apps before the Electron shell (the Mac's WebKit
storage, the Windows WebView2 profile) is read once, without changing it, and
handed to the page (`electron/earlier-state.js`).

`electron/bluetooth.js` owns the piano connection: Web Bluetooth in a hidden window
of the shell, so no helper process or separate installation is needed. Events reach
the page's input interface through the shell. Device names, UUIDs, output
channels, the default device, and automatic connection preferences belong to the
`bluetooth` section of the shared `WorkspaceState` owner. The note stream is not
recorded to disk.

## Bluetooth connection

Opening the piano panel in the top bar starts discovery when no connection is
active. It scans devices advertising the standard BLE-MIDI service. Scanning ends
after 45 seconds, retaining the results for selection. **Saved pianos** and
**Nearby MIDI devices** are separate lists. A saved identifier does not prove that
a device is currently nearby. After scanning ends, the UI shows that the device was
seen in the last scan rather than presenting a live signal indicator. Devices with
the same name are distinguished by a UUID suffix.

**Connect** targets only the selected UUID; the first discovered device is never
chosen automatically. **Stop scanning** stops only the app's discovery session.
Disconnect the current device before scanning for a different one.

Input is shown as ready after MIDI notification subscription completes; the first
actual key message changes it to receiving key presses. Output availability comes
from the characteristic's MIDI write capability and does not prove that the
speakers are producing sound. **Play a short test note on the piano** pauses current
playback and sends a short C4 only when clicked. There is no automatic test note.
Listen and Practice share the same physical input interface; incoming notes are
not echoed back to the piano.

A successful connection saves the device. Select its saved row to change its name,
**MIDI output channel** (1–16), default-device selection, and automatic connection
preference. Both hands use the same output channel while keeping their separate
practice assignments. The generic default is channel 1; Roland FP-30X/60X/90X use
channel 4 for the tone selected on the piano. Changing channels pauses playback.
**Forget this device** removes only the app preference, leaving macOS pairing intact.

Automatic connection is off by default. When enabled, the default piano is tried
on launch. Connection loss or an unreachable-device error permits up to three
additional attempts, with delays of 1, 3, and 7 seconds. Permission errors or disabled
Bluetooth do not start an automatic retry loop. Cancellation, manual disconnection,
scanning, hiding the page, or closing it cancels pending retries. Reconnecting never
resumes lesson playback automatically.

Bluetooth Audio alone is not sufficient; this transport requires standard Bluetooth
MIDI. Cross-brand compatibility is based on the protocol and still requires testing
with actual devices. macOS may request Bluetooth permission or device pairing on
first use. The panel distinguishes confirmed Mac-side errors from remote piano
availability problems whose cause cannot be established remotely.

**Disconnect**, **Cancel**, and quitting the app end the app's own Bluetooth
connection. If the page's process exits, Bluetooth is stopped and the interface
reloads. Other apps' Bluetooth connections are never taken over or stopped.

## Fast browser development

Run `./dev.command` or `python3 server.py --dev --open --port 8784` to open
<http://127.0.0.1:8784>. HTML, JavaScript, and font changes refresh the page in roughly
one second without repackaging the app or models. Refreshes reload the UI and its
saved workspace; source selections that have not been submitted are not preserved.
Reloading waits during video upload. Analysis already started and the Bluetooth
connection continue across a normal page refresh.

The browser uses the real lesson creation, saved lesson library, and Bluetooth
interface. `/api/lessons/command` is only the local HTTP transport: the
Objective-C `LessonService.m` runs in a small `LessonHost` process and the Bluetooth
helper in `bluetooth-connection/` is started by the server. These two serve only this
browser development mode on a Mac; the app itself uses `electron/lessons.js` and
`electron/bluetooth.js`.
The model implementation remains in `lesson-engine/worker.py`. Development engine
links live under `build/browser/Engine/`; existing local Python, package, and model
files are not copied again. Development lessons live in
`~/Library/Application Support/Rach3Development/`, separate from the installed
app's lessons.

When LessonService or LessonHost changes, the small helper is rebuilt while idle;
an ongoing analysis job is allowed to finish before replacement. Worker changes
take effect on the next lesson. Changes to `server.py` require restarting the
service; changes to the shell, menus, or installer require an app build (or `npm start`).
Ctrl+C or SIGTERM shuts down the development service, its analysis job, and its
Bluetooth connection. `python3 server.py --open` serves the app on port 8783 without
automatic reload.

In this workflow, Python's `BluetoothBridge` owns the Bluetooth process. Native JSON
events arrive through the `/api/bluetooth/events` SSE stream; status is available at
`/api/bluetooth/status`. Commands use POST requests to `/api/bluetooth/scan`,
`/api/bluetooth/connect` with a selected UUID, and `/api/bluetooth/disconnect`.
Commands must come from the same local origin with JSON and the `X-Rach3: 1`
header. The server listens only on loopback, rejects other Host/Origin values, and
does not enable CORS.

Bluetooth is closed five seconds after the last live page connection disappears.
Normal refreshes and other open tabs preserve the connection. Saved device
preferences belong to `WorkspaceState`; the old `.runtime/last-device.json` record
is read only for migration. Reopening the event stream delivers a snapshot of the
connection and held keys.

## Practice behavior

**Staff on falling notes** is enabled by default. Each falling note includes a small
five-line staff, treble or bass clef, notehead, ledger lines when needed, and sharps.
Notes below C4 use bass clef; C4 and above use treble clef. Extreme octaves are
explicitly marked with `8vb`, `8va`, or `15ma`. Black keys use sharps consistently
with the note labels; the source does not provide key or enharmonic spelling
information for this view. Note-name visibility is independent of the staff display.
Use **Zoom** to enlarge the view, then scroll the keyboard horizontally.

This view teaches pitch reading. Since video note data does not necessarily include
meter, beats, or rhythmic values, it does not infer quarter or eighth notes. A
stemless notehead represents pitch, and bar length represents the actual hold time.
Imported MIDI uses the same display. The Bravura music font and its OFL license are
bundled, so symbols require neither internet access nor an installed system music font.

The default **Practice** mode follows physical key presses for the selected part.
All practice methods require a connected piano: Start and keyboard shortcuts use
the same connection requirement. A MIDI disconnection pauses the exercise; reconnecting
enables Start without automatically resuming. Listen with the app synthesizer works
without a piano connection.
When notes reach the strike line, time waits until all chord keys are correct.
Missing or incorrect keys, or key releases outside the tolerance, stop progress.
Once the correct state returns, the remaining duration continues; real time spent
waiting does not count toward lesson time. Repeated notes require a fresh note-on.
Overlapping notes of the same pitch are treated as one shared physical key hold.

**Practice method → Timing** selects **Off, Easy, Normal, or Hard**. Normal is
selected by default. These are app presets, not external performance standards:

| Timing | Early press | Late press / chord wait | Early or late release |
| --- | --- | --- | --- |
| Off | Not graded | Not graded | Not graded |
| Easy | 500 ms | 1,000 ms | 400 ms |
| Normal | 300 ms | 500 ms | 200 ms |
| Hard | 150 ms | 200 ms | 100 ms |

With timing enabled, early-input and release tolerances are converted to lesson
time using playback speed. The late-press allowance uses real time and determines
whether a row attempt counts as clean; whole-piece practice still waits without
a failure counter. Waiting beyond the allowance does not skip the missing note.
A correctly pressed chord key remains accepted while waiting for another key.
Practice uses physical key-release `end`; listening uses pedal-adjusted `soundEnd`.

With timing off, each target still requires a fresh correct attack, but taps count
without holding for the written duration. After the current chord has been played,
the next onset group can be played early without a timing penalty. Unrelated pitches
are not accepted merely because they appear later in the piece. Notes still follow
the lesson clock, and all keys must be released before the next row attempt.
Wrong pitches and unrelated extra attacks still break the clean streak.

Changing timing pauses the current attempt. The selected preset is saved, and
completed progress is kept separately for each timing preset. Returning to Hard
also restores progress earned under the original fixed tolerances.

### Practice strategies

In **Practice**, open **Practice method** in the top toolbar. **Practice the piece**
is the default and retains the existing wait-for-me behavior. Two additional
strategies use the grand-staff systems—the complete rows containing both hands—in
the sheet music:

| Strategy | Progression |
| --- | --- |
| Practice the piece | Follow the selected part through the whole piece. |
| Master each row | Repeat row 1 until mastered, then row 2, and continue. |
| Build up rows | Master row 1, row 2, then rows 1–2 together; learn row 3, then rows 1–3, and continue. |

The row strategies require **3, 5, or 10 consecutive clean repetitions**, with 10
selected initially. An error immediately resets the current streak; the attempt
finishes at the normal boundary and repeats the same section. A compact status line within the bottom timeline
shows the current section, streak, and attempt feedback.

The **‹** and **›** buttons beside that status line move to the previous or next
section of the plan at any time, including after the plan is complete. Mastery is
kept per section: skipping ahead never marks a section as learned, and going back
never removes earned mastery. Leaving a section discards its unfinished streak.
After a section is mastered, practice continues with the next section that is not
yet mastered, wrapping back to any that were skipped. Velocity and pedal use
remain optional and are never graded. Timing follows the selected preset above;
with timing off, waiting and hold durations never invalidate an attempt.


The score shows a status badge beside every row: **Waiting**, **Learning**, or
**Learned**, with a percentage and a check mark when its standalone repetition
goal is complete. Rows without notes in the selected part show **No notes** and
are excluded from mastery totals. The current exercise has an amber outline;
learned rows use green marks outside the printed notation.

Learning progress belongs to rows and practice stages. Row badges remain beside
the score; the current row, repetition count and attempt feedback sit within the
bottom timeline. This status line occupies normal layout space and stays outside
the falling-note area.

The score summary shows **Practice plan %** and **Rows learned X/Y**. Row
percentages use clean passes toward each standalone goal. Plan percentage uses
completed clean passes across all required stages, including cumulative stages.
For example, in a two-row build-up plan, mastering both rows separately gives
2/2 rows learned but only 66% of the plan; the remaining third is playing them
together. Current combined-stage progress is displayed separately. Only completed
clean passes count, so a streak-breaking error can lower partial progress while
already mastered rows remain learned. These displays are derived from the saved
practice context, update on reset or context changes, and appear in row-based
practice methods; ungraded listening and whole-piece practice award no mastery.

Row boundaries come from the notation's measure playback times, not arbitrary time
windows or screen coordinates. A barline within 80 ms of a performed downbeat
moves to that downbeat (the earliest onset of the nearest chord), so adjacent rows
share the boundary the performance actually played. A held note crossing the start
of an isolated row must be pressed again for that exercise; a carried-over fragment
shorter than 80 ms is timing skew and never a target. Within combined rows, the original holds
continue across their boundaries. Only the exercise targets are cropped; the
original lesson notes and score remain unchanged. Rows with no notes in the
selected part do not earn empty repetitions. The score still reflects its imported
or automatically estimated source; row practice does not certify transcription or
engraving accuracy. Without usable sheet music, whole-piece practice remains
available and the row methods explain why they cannot start.

Practice settings and completed progress are saved with the workspace. Progress is
scoped to the lesson, selected part, speed, timing preset, method, target, and score row structure;
changing those does not transfer mastery to a different exercise. A pause, seek,
focus loss, or MIDI disconnection interrupts the current attempt rather than
awarding a repetition. Resume starts a fresh attempt at the section boundary.
**Reset practice progress** restarts the current exercise without deleting the
lesson. Resizing the workspace alone does not change musical row boundaries.

**Listen** plays the lesson automatically. Practice does not add automatic
accompaniment or synthesize the physical piano's sound again. Blue outlines show
target keys, colored fills show held keys, and red fills show incorrect or extra keys.

The on-screen keyboard only displays physical keys and target notes. It does not
accept mouse, touch, or computer-keyboard note input. Playback pauses when the app
loses focus or the mode changes. Seeking or changing parts rebuilds the target
notes. Resizing the view does not reset physically held keys.

### Profiles and hand span

**Practice method** starts with a **Profile** selector, so people sharing a piano keep
separate practice progress. The **Default** profile keeps all progress saved before
profiles existed. **Measure hand span** asks for each hand in turn: press the two
farthest keys the thumb and little finger reach comfortably and hold them for three
seconds. The connected piano reports the exact keys, so the span is stored in
semitones (5–24); keys that cannot be one hand's span are rejected.

With a measured span, practice adapts chords wider than that hand's reach. The
right hand keeps its highest note (usually the melody), the left hand its lowest
(the bass); notes farther away from that anchor than the span become optional. Optional
notes are dimmed in the falling notes, are never awaited, and are accepted when
played, for example by rolling the chord. Wrong notes remain errors. This is
calculated during practice only: the lesson, its score, listening and MIDI export
keep every note. Each profile and adaptation has its own progress context. Notes
are grouped per hand by their part, or by middle C when a lesson has no hand parts,
so a lesson whose parts assign notes to the wrong hand can mark extra notes optional.

## Note input interface

`piano-input.js` tracks held keys and fresh-press identities per source.
`practice-clock.js` uses the Bluetooth source state and is the sole owner of practice
time. `practice-session.js` owns row plans, attempt grading, and completed progress;
`sheet-music.js` supplies the engraved row boundaries. `player.js` coordinates
input, transport, rendering, and persistence. There is no on-screen
keyboard input source.

`bluetooth-connection/bluetooth.js` feeds `window.rach3Input`. The interface emits
`rach3-input-ready` when ready. This is not a simulated connection; adapters must
report actual connection state:

```js
// Once the native transport is actually ready:
window.rach3Input.connect('bluetooth', 'Yamaha CLP-835');
// After decoding a native JSON event:
window.rach3Input.receive({event: 'note_on', note: 60, velocity: 82, channel: 1});
window.rach3Input.receive({event: 'note_off', note: 60, velocity: 0, channel: 1});
// When the stream is interrupted or the connection ends:
window.rach3Input.disconnect('bluetooth');
```

`receive` also accepts `ready`, `disconnected`, `stopped`, `error`, and
`all_notes_off`. A `note_on` with velocity 0 is a release. `input_id`, `group`, and
`channel` distinguish key identities; note-off must carry the same identity. Pedal
and other events do not currently affect practice grading. Notes from a disconnected
source are rejected. Reconnection clears previously held keys. `reset(source)`
clears keys while preserving the connection. Native timestamps do not drive the
practice clock; it uses local event arrival order and the browser's monotonic clock.

Physical note and pedal input, and reconnection without touching the piano, were
verified with the native helper the app used before the Electron shell. The Web
Bluetooth connection of the Electron shell has not yet been tried with a real piano,
on the Mac or on Windows; its packet decoding and connection flow are covered by
`electron/tests/`. End-to-end acceptance testing with a real piano is performed by
the user.

## Public website

The English website is at <https://rach3.com/>, served by GitHub Pages with rach3.com as
its custom domain.
Its source lives in `site/`, and `.github/workflows/pages.yml` publishes it.
`site/build.py` includes only the explicit public asset list; download buttons link
to an actual published release asset, with the latest published release shown on
the site.

To refresh product screenshots, run
`python3 desktop/build.py --capture-assets site/assets` and
`python3 desktop/build.py --capture-assets site/assets/tr --capture-language tr`
(the Turkish website shows the app in Turkish). This builds a development-only
capture executable, exports the actual app renderer using an isolated WebKit store
and preferences, then removes the capture executable. Personal lessons, library
data, and workspace preferences are not used or modified. Generated artwork
provenance is recorded in `site/IMAGEGEN.md`. `python3 site/compose.py` puts the
practice screenshot onto the laptops in the photos.

The picture shown when the site is shared is the top of the page itself:
`python3 site/social.py` screenshots the built site at 1200×630 in each language
into `site/assets/social-card.jpg` and `site/assets/tr/social-card.jpg`.

The app icons, favicons and the website's hero artwork come from one image, the
pianist under the moon on a black stage: `brand/rach3-artwork.png`. The written
name in the headers is lifted from the first logo drawing,
`brand/rach3-logo-source.png`. After changing either, run `python3 brand/make.py`
(needs numpy and Pillow) and commit what it writes: the icons and wordmarks in
`brand/`, the website images in `site/assets/`, the app header wordmark in
`assets/brand/`, `desktop/AppIcon.png` (the macOS icon) and
`windows/Rach3/Rach3.ico`.

The website is in English (the site root) and Turkish (`tr/`). `site/index.html`
is written in English; `site/tr.json` holds the Turkish for each text, and
`site/build.py` fails if the page changes a text that has a translation, so the
two stay in step. First-time visitors in Turkey or with a Turkish browser get
the Turkish page; the language link in the header and footer overrides that.

## License and credits

rach3 is licensed under the [GNU Affero General Public License v3.0](LICENSE).
Models, libraries and fonts keep their own licenses; [CREDITS.md](CREDITS.md) lists
each one with its authors. Lesson tools are downloaded from their original publishers
on first use and are not redistributed in this repository.
