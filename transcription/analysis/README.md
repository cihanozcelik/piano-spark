# Audio-only key-release investigation

The user requires a transcription tool that predicts note holds directly from
audio. No visual duration, hand correction, snapping, or duration replacement is
fed into these inference runs. Existing application lessons remain unchanged.

## Comparison method

`compare_durations.py` compares raw source-time predictions to the existing
640 visual observations. Matching uses identical pitch and onset distance at
most 150 ms, with one-to-one greedy nearest matches. The known 5.5666667-second
visual timeline offset is applied only to the reference for comparison.

The user confirmed that the first lesson's visually extracted notes and durations
are correct; it is the accepted reference for this recording. Its provenance is
visual extraction, rather than original performance MIDI. Different models match
different subsets; note counts and unmatched notes must be considered alongside
duration errors. The comparator never modifies predictions or lesson data.

Run from any directory:

```sh
python3 transcription/analysis/compare_durations.py
```

`duration-comparison.json` contains the summaries. Each model's `*-comparison.json`
also contains every matched pair for inspection.

## Completed findings

| Model | Predicted notes | Matched | Unmatched audio | Median absolute hold discrepancy |
| --- | ---: | ---: | ---: | ---: |
| Transkun V2 stock | 621 | 621 | 0 | 0.655 s |
| Transkun merge-offset patch | 621 | 621 | 0 | 0.655 s |
| Kong/ByteDance note + pedal | 996 | 632 | 364 | 2.491 s |
| Rubato MIDI stock | 643 | 639 | 4 | 0.040 s |
| Rubato MIDI full-window overlap | 641 | 637 | 4 | 0.033 s |
| Rubato score stock | 628 | 628 | 0 | 0.000 s |
| Rubato score full-window overlap | 636 | 636 | 0 | 0.000 s |

Median alone hides substantial remaining errors:

| Model | Hold differences within 100 ms | Hold differences over 250 ms |
| --- | ---: | ---: |
| Transkun V2 stock | 126 / 621 | 423 / 621 |
| Kong/ByteDance | 38 / 632 | 585 / 632 |
| Rubato MIDI stock | 350 / 639 | 267 / 639 |
| Rubato MIDI full-window overlap | 366 / 637 | 251 / 637 |
| Rubato score stock | 498 / 628 | 130 / 628 |
| Rubato score full-window overlap | 507 / 636 | 129 / 636 |

The installed Transkun checkpoint matches the official GitHub model blob
`42183f2e0ce08017b74675a2ccf9f2e88732dfc9` (SHA256 is in its report).
The candidate [segment-merging correction](https://github.com/Yujia-Yan/Transkun/issues/42)
changed **none** of the 621 note predictions or pedal intervals on this recording.
The isolated environment was restored to the stock implementation afterward;
the patch, stock backup, and separate output are retained under `transkun-v2/`.

The embedded Transkun lesson contains the same 621 pitches and hold durations as
the raw predictions, apart from JSON rounding (largest duration difference under
one microsecond). The display uses note `end`, while audio playback uses
`soundEnd`. The large hold discrepancies already exist in the model output.

ByteDance produced more unmatched events and larger duration discrepancies, so
its output was not installed into a lesson. Raw pedal outputs are retained even
where the model predicts events beyond the input's end.

Rubato's stock MIDI output contains very long notes when a release is missing
after a window boundary. Decoding each entire 40-second window and selecting
notes by onset ownership reduces some of these extremes, but does not fix the
remaining model mistakes. The candidate uses model-predicted releases from the
same window, without clipping notes at the 20-second ownership boundary.

Rubato's score task is better on this recording's held durations, but it uses
notated durations/timestamp interpolation and a constant converter velocity 80,
with no pedal prediction. Its best candidate still misses four reference notes
and has 129 large duration errors. This does **not** satisfy the requirement for
a reliably generated lesson.

The candidates and reproducible runners are under `../rubato/`. The best duration
candidate is `peace-score-overlap/peace-rubato-overlap-source.mid`, on the original
audio timeline. It is experimental, not an accepted replacement. At the user's
request to open it for inspection, it was added as a separate Rubato lesson;
the original and Transkun lessons remain available. Only leading silence is
removed, with no duration correction or visual-reference input. User acceptance
and playback testing remain with the user; no piano connection was operated.

For the subsequent dynamics/pedal request, the embedded lesson was enriched from
the Rubato MIDI transcript's note-on velocities and CC64 events. All 636 score
notes match by pitch/onset within 150 ms. This changes expression and sounding
tails, not the score hold durations or the comparison results above. The raw
score candidate still has the converter's constant velocity; the application
lesson has the combined expression data. Sustain remains an unverified,
near-continuous model estimate and is labeled accordingly.
