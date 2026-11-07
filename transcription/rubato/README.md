# Rubato v1: audio-only MIDI experiment

This isolated experiment uses the released Rubato MIDI task to predict note-on,
key-release, velocity and sustain events from the same full source audio. It
does not read `transcription.json`, visual matches or application lesson data.

Sources:

- [Model/runtime repository](https://github.com/nctamer/rubato-transcription),
  v1 commit `325d90df334f7fe7e8e2c8c90a297c927e635dcc`.
- [Paper](https://arxiv.org/abs/2605.24291).
- [Released weights](https://github.com/nctamer/rubato-transcription/releases/download/v1/rubato.ckpt).

The model and environment remain local and ignored by Git. `requirements.lock.txt`
records the installed versions; no system Python or application service is changed.
The downloaded checkpoint matches the release's published SHA256:
`131649ff95b80713bd327b63d37b2771e1175b3c1c9aa4242a783c67bf27b1fc`.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
mkdir -p models
curl -fL https://github.com/nctamer/rubato-transcription/releases/download/v1/rubato.ckpt -o models/rubato.ckpt
nice -n 10 .venv/bin/python -u run.py
```

`run.py` defaults to `../transkun-v2/source.wav` and output `peace/`. Override with
`--audio /path/audio.wav --output /path/results`. It uses four CPU threads,
eight decoder slots, the model's standard 40-second windows/20-second hops, and
greedy decoding with recovery disabled. Stop the foreground process with Ctrl-C;
rerunning starts a fresh transcription. There is no background service.

Outputs are saved only after inference completes:

- `source.midi.txt`: untouched stitched model text.
- `chunks.json`: model result with the individual window texts and token IDs.
- `peace-rubato-source.mid`: MIDI produced by the official converter.
- `events.json`: notes from the official performance parser plus raw pedal events
  and paired intervals, all in source seconds. No sustain extension is applied
  to note ends. An unreleased pedal has a null interval end.
- `report.json`: model/audio hashes, parameters, versions, timing and decoder stats.

The official parser drops notes with no matching release. Raw text and MIDI are
kept so a parsed count does not hide that limitation. No manual note correction
or visual-reference alignment is applied to these artifacts. Visual comparison
is a separate analysis step, described in `../analysis/README.md`.

## Full-window overlap experiment

`nice -n 10 .venv/bin/python -u overlap.py` writes `peace-overlap/`.
This alternative decodes the complete 40 seconds of each window, rather than
stopping at 20 seconds. A window owns the notes beginning in its first 20 seconds
and retains their model-predicted releases from the full window. The last window
owns the remaining tail. Notes without a release inside their window are omitted
by the official parser; no end is fabricated. Notes held beyond the available
window are a limitation. Every raw window transcript and MIDI is saved.

This eliminated some very long cross-window pairings, but the run still has many
duration errors. It is an experiment, not an application integration or a claim
that the model now produces correct holds.

## Score task

`nice -n 10 .venv/bin/python -u run.py --mode score` writes `peace-score/`.
This requests written music directly from audio and uses the official score
parser/MIDI converter to derive timestamped note durations. The converter uses
constant velocity 80 and predicts no pedal in this path. It therefore cannot
replace a performance transcription for dynamics/pedal. Parser repairs are
recorded in the report. Raw notation is saved as `source.score.txt`.

`nice -n 10 .venv/bin/python -u overlap.py --mode score` applies the same full-window
onset ownership to the score task and writes `peace-score-overlap/`. Per-window
parser repairs and raw text are retained. It extracts 636 of the 640 accepted
reference notes, with no unmatched predicted notes at the 150 ms onset tolerance.
507 matched holds are within 100 ms; 129 differ by more than 250 ms. This is the
best duration candidate so far, but still unsuitable as a claimed-correct lesson.
At the user's request to inspect the result, `embed_lesson.py` installs this
candidate as a separate experimental Rubato lesson in `piano.html`. It preserves
model note durations and PL/PR hand assignments and removes only leading silence
before the first predicted onset.

The lesson now combines those score notes with velocities and CC64 from the
stock MIDI transcript `peace/source.midi.txt`. The official performance event
parser supplies note-on velocities even for notes whose release was missing;
one-to-one pitch/onset matching within 150 ms covers all 636 score notes. Missing
matches stop embedding rather than silently assigning a constant. The original
score/MIDI experiment outputs remain intact; no visual data is used. Velocities
range from 38 to 84. The official parser's default for an omitted velocity token
is 80, so these remain model/decoder estimates, not measured physical strikes.

CC64 is copied from the MIDI transcript, including its near-continuous sustain
estimate. Key ends remain unchanged; the player derives separate sounding ends
from CC64 on load. These values are visible and affect Listen playback and MIDI
export, but never gate PracticeClock advancement. Regenerate the embedded data:

```sh
transcription/rubato/.venv/bin/python transcription/rubato/embed_lesson.py
```

Run this command from the project root, then rebuild the desktop app.
The original and Transkun lessons remain available. The application currently
opens on Rubato for user inspection; this does not mark its durations as accepted.
