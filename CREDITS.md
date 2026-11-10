# Credits

rach3 stands on open research and open-source software. The models below do the
hard work of turning recordings and printed scores into lessons; this app connects
them into a practice tool. Thank you to everyone who built and shared them.

Lesson tools are downloaded from their original publishers on first use and verified
with SHA-256 checksums. Each component keeps its own license.

## Models

| What it does in rach3 | Model | Team | License |
| --- | --- | --- | --- |
| Turns a piano recording into notes, timing, pedal and beats | [Rubato](https://github.com/nctamer/rubato-transcription) — *Rubato: Transcribing Piano Music with Timestamps* (NeurIPS 2026) | Nazif Can Tamer, Victoria Ebert, Guang Yang, Noah A. Smith | AGPL-3.0 |
| Removes vocals from a song before transcription | Mel-Band RoFormer vocal model | Kimberley Jensen; architecture by Ju-Chiang Wang, Wei-Tsung Lu and Minz Won (*Mel-Band RoFormer for Music Source Separation*) | MIT |
| Runs the vocal separation model | [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | Nomad Karaoke and contributors | MIT |
| Reads printed sheet music from PDF | [homr](https://github.com/liebharc/homr) | Christian Liebhardt; builds on [oemer](https://github.com/BreezeWhite/oemer) segmentation and [Polyphonic-TrOMR](https://github.com/NetEase/Polyphonic-TrOMR) | AGPL-3.0 |
| Reads text on sheet music pages | [RapidOCR](https://github.com/RapidAI/RapidOCR) with PP-OCR models from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | RapidAI; PaddlePaddle | Apache-2.0 |

If you use Rubato in research, please cite it:

```bibtex
@inproceedings{tamer2026rubato,
  title={Rubato: Transcribing Piano Music with Timestamps},
  author={Tamer, Nazif Can and Ebert, Victoria and Yang, Guang and Smith, Noah A.},
  booktitle={Advances in Neural Information Processing Systems},
  year={2026}
}
```

homr asks that research using it also cite oemer and Polyphonic-TrOMR.

## Music software

| Used for | Project | License |
| --- | --- | --- |
| Engraving the score | [Verovio](https://github.com/rism-digital/verovio) (RISM Digital Center) with its Leipzig font | LGPL-3.0; font OFL-1.1 |
| Music font for keys and notes | [Bravura](https://github.com/steinbergmedia/bravura) (Steinberg) | OFL-1.1 |
| Score analysis, MusicXML and MIDI | [music21](https://github.com/cuthbertLab/music21) (Michael Scott Asato Cuthbert and contributors) | BSD-3-Clause |
| Running the models | [PyTorch](https://github.com/pytorch/pytorch), [ONNX Runtime](https://github.com/microsoft/onnxruntime), NumPy, SciPy, librosa, soundfile | BSD / MIT / ISC |
| Audio from YouTube links | [yt-dlp](https://github.com/yt-dlp/yt-dlp) and FFmpeg via [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) | Unlicense; LGPL/GPL |

## Desktop apps

| Used for | Project | License |
| --- | --- | --- |
| Portable Python runtime | [uv](https://github.com/astral-sh/uv) and python-build-standalone (Astral) | Apache-2.0 / MIT |
| Mac updates | [Sparkle](https://github.com/sparkle-project/Sparkle) | MIT |
| Finding pieces and changing the app with ChatGPT (Mac and Windows) | [Codex](https://github.com/openai/codex) (OpenAI), runs with the person's own ChatGPT account | Apache-2.0 |
| Windows installer and updates | [Velopack](https://github.com/velopack/velopack) | MIT |
| Windows page view | Microsoft Edge WebView2 | Microsoft license |

The example lessons and their sources are listed in
[`assets/example-lessons/README.md`](assets/example-lessons/README.md).

## rach3

rach3 itself is free software under the
[GNU Affero General Public License v3.0](LICENSE).
