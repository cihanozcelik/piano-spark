# Fingering guidance

Piano Spark computes suggested fingers offline, before playback, in a cancellable
browser worker. The hand animation consumes that plan; it does not choose fingers.
The source notes, their timing, hand assignment and pedal data remain unchanged.

## Published foundation

- [Parncutt, Sloboda, Clarke, Raekallio and Desain (1997), *An Ergonomic Model of Keyboard Fingering for Melodic Fragments*](https://static.uni-graz.at/fileadmin/_Persoenliche_Webseite/parncutt_richard/Pdfs/PaSlClRaDe97_FingeringModel.pdf):
  Table 1 supplies practical, comfortable and relaxed finger-pair spans. The
  twelve rules score stretch, cramped/wide spacing, position changes, finger
  agility, black-key placement and thumb passing. Their model treats right-hand
  melodic fragments and assumes legato; it is not a complete polyphonic model.
- [Balliauw, Herremans, Palhazi Cuervo and Sörensen, *A variable neighbourhood search algorithm to generate piano fingerings for polyphonic sheet music*](https://www.dorienherremans.com/sites/default/files/ITOR_VNS_APF_preprint.pdf):
  section 3.3 requires different simultaneous keys to use different fingers;
  rules 13–14 provide a cost for transitions beyond practical spans and increased
  stretch/cramping costs inside chords. We use those ideas, **not their VNS
  optimizer**, and retain a hard reach limit for held contacts.
- [MusicXML 4.0 `<fingering>`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/fingering/):
  fingers use 1 = thumb through 5 = little finger, separately for each hand.
  MusicXML also represents alternate and substitution fingerings. It standardizes
  notation, not a universally correct fingering for every passage.

This is an original implementation of **Parncutt-inspired constrained beam
search**, with the extensions below. It does not contain third-party model
weights, training datasets, copied library source, or an ML runtime. A suggested
fingering is not a claim of expert consensus or a prescribed medical hand span.

## Search and contact model

Notes are grouped by exact onset time. Each hand is planned independently in
time/pitch order, independent of source IDs. Each state retains its actual held
keys/fingers, the previous two onset slices, cumulative cost, and a backpointer.
The search keeps the 64 cheapest distinct states at each onset, then backtracks
the least-cost surviving complete path. Later notes can therefore change earlier
finger choices; this is not a pitch-to-finger lookup or greedy per-note choice.
Beam pruning makes this an approximate optimizer, not a proof of global optimality.
The ergonomic rules are soft costs: a thumb on a black key is allowed and may be
the best contextual choice. There is no blanket black-key ban or single fixed
finger for a pitch. Only the explicit simultaneous-contact constraints below
reject a candidate outright.

The following are application extensions and constraints:

- Every held key retains its finger until the supplied physical note end.
  Pedal-sustained sound never extends a finger lock. A finger cannot hold two
  distinct keys. More than five held pitches in one hand is unresolved.
- Simultaneously held fingers must remain in natural lateral order. Sequential
  thumb-under/finger-over motion is permitted after release. Crossed sustained
  contacts and finger substitution during a hold are outside this version's
  supported motion vocabulary.
- All held finger pairs must fit their maximum practical reach. For this hard
  constraint, keyboard positions use actual white/black-key lateral arrangement,
  in white-key widths. Parncutt's semitone spans are converted using seven white
  keys per octave. Their original semitone distances remain in the ergonomic
  costs. This conversion is an approximation, explicitly separate from the paper.
- Existing optional finger numbers are hard anchors. Contradictory anchors are
  reported, never silently replaced. Strictly overlapping copies of the same
  pitch in one hand share one contact and finger; their original IDs are retained.
  Such merging produces a warning because a separate repeated strike cannot be
  recovered from overlapping source events alone. Exactly adjacent repeated notes
  remain separate strikes.
- Simultaneous notes are not linearized into a fictional melody: chord costs use
  pairs, and transition costs average the pairs between successive onset slices.
  The three-note rules apply only to three successive single-note slices.
- After a rest of at least 350 ms following the preceding slice's last release,
  melodic cost history resets. This is an application phrase boundary, not a
  musical notation rule. Active contacts remain authoritative regardless of rest.

If no state survives, every note in that connected overlap passage is marked
unresolved, and planning restarts only once those contacts have ended. No held
note is secretly released, no source note is deleted, and no default finger is
invented. `no-feasible-plan-within-search` can reflect conservative constraints or
beam pruning; it does **not** mean that a human could never play the passage.

## Hand size

The published Table 1 is the medium profile. Small multiplies spans by 0.9,
consistent with the paper's example adjustment; large multiplies them by 1.1,
an application profile. The same profile changes the ergonomic thresholds and
physical reach bounds. These presets are not anatomical measurements, age groups,
or technique advice. Keyboard key spacing itself does not change.

## Integration and lifecycle

`fingering-planner.js` exports `FingeringPlanner`:

```js
const planner = new FingeringPlanner({ onProgress });
const plan = await planner.plan(notes, { handSize: 'medium' });
// Later, when the owning view is destroyed:
planner.dispose();
```

Input: `{sourceNoteId, midi, time, end, hand, finger?}`. IDs are unique nonempty
strings; time/end are seconds; `hand` is 0 for left, 1 for right; optional finger
is an integer 1–5. End means **physical key release**, not acoustic decay.

Output: `{version: 1, handSize, handScale, method, assignments, unresolved, warnings}`.
`handSize` records the selected profile name and `handScale` its numerical factor
(small 0.9, medium 1, large 1.1). The renderer uses this same factor for hand
geometry; it must not invent a separate size interpretation. Each assignment
is `{noteId, hand, finger}`. Unresolved passages carry original `noteIds`, `hand`,
`start`, `end` and a reason. Warnings are structured objects with a `code` and
human-readable `message`. The method contains its ID, revision and primary sources.

Progress reports `{phase: 'planning', completed, total, progress}` at most about
once per 60 ms, plus the first and completed updates. Work runs off the UI thread.
Starting another plan terminates the old worker and rejects that old promise with
`AbortError`. `cancel()` does the same explicitly. `dispose()` also prevents reuse.
Successful or failed jobs terminate their workers. No worker or computation stays
running during ordinary playback, and no network access or user installation is
needed to plan fingers.

## Limits

The supplied left/right split is trusted; the planner does not reassign notes
between hands, infer a player's actual finger from MIDI, or infer articulation
from audio. It does not model wrist rotation, arm biomechanics, two-hand collision,
pedal-assisted early release, crossed sustained fingers, glissandi, one finger
depressing two adjacent keys, or mid-note substitution. No confidence percentage
is fabricated from ergonomic costs. Imported expert fingerings take precedence
as anchors, but conflicting constraints remain visibly unresolved.

## Alternatives considered

[PianoPlayer](https://github.com/marcomusy/pianoplayer) is an MIT implementation of
minimum weighted finger-motion search. Its reviewed core does not retain all
held-note locks and includes a repeated-finger fallback when search fails, so it
cannot directly supply this animation's contact contract.
[Lumikey's Transformer inference](https://github.com/lumikey/piano-fingering-model)
uses unmasked per-note argmax; it likewise does not guarantee simultaneous finger
exclusivity. [Ramoneda's autoregressive models](https://github.com/PRamoneda/Automatic-Piano-Fingering)
are useful research alternatives. The
[PIG dataset's official terms](https://beam.kisarazu.ac.jp/research/PianoFingeringDataset/)
limit dataset use to nonprofit academic work; we do not bundle that data or assume
that an unrelated repository's software license grants rights to the dataset.
