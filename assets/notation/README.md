# Verovio engraving asset

Verovio 6.4.1, LGPL-3.0-only, distributed locally with embedded WebAssembly.
The original npm distribution is pinned by `package-lock.json` (including its
integrity hash). No CDN request is made during rendering.

Source: https://github.com/rism-digital/verovio/tree/version-6.4.1
Documentation: https://book.verovio.org/
License: `COPYING` and `COPYING.LESSER`, copied from that source revision.

To reproduce the checked-in asset, install the pinned npm package in a project
build directory using these package files and `npm ci`. Copy its
`node_modules/verovio/dist/verovio-toolkit-wasm.js` here, then append:

```js
globalThis.PianoNotationReady=new Promise((resolve,reject)=>{
  verovio.module.onRuntimeInitialized=()=>resolve(verovio);
  verovio.module.onAbort=reject;
});
```

The callback is registered in the same script execution as the runtime, before
WebAssembly initialization completes. The upstream toolkit is otherwise unchanged.
The desktop packager embeds this script as `window.PianoNotationRuntime` text
in its offline HTML and copies this
notice, both license texts and package metadata into Resources/Licenses/Verovio.
For development the Python server serves the same file. `sheet-music.js` loads
that source into a Blob Worker, renders all pages there, reports completed stages
and page counts, then terminates the worker. A lesson change cancels the old job.
The browser UI never initializes the engraving WASM on its main thread. Replace the asset and
rebuild the UI to use a modified toolkit.

MusicXML is produced by the bundled music21 9.9.1 engine
(`lesson-engine/score_writer.py`), not by the Rubato private engraver. music21
and its dependency licenses are retained in Engine/site-packages; the Python
versions are pinned in transcription/separation/requirements.lock.txt. Verovio
only lays out the resulting score and supplies the interactive note/time map.
