# Piano teaching hand assets

These are the original left and right `generic-hand` meshes from the WebXR Input
Profiles assets package, pinned by commit and SHA-256 in `provenance.json`.
The asset package is MIT licensed; its complete notice is in `LICENSE.md`.
Meta documents its contribution of these standard models in
[WebXR Hands](https://developers.meta.com/vr/documentation/web/webxr-hands/).

Each mesh has 1,360 vertices, 2,314 triangles, and a 25-joint skin using
[WebXR joint names](https://www.w3.org/TR/webxr-hand-input-1/). Its joints are
siblings under the armature, rather than a parented finger chain. `hand-rig.js`
keeps this layout and the original glTF inverse bind matrices, solves logical
finger chains, and writes the resulting joint poses back into the skin.
No WebXR session, headset, or hand-tracking permission is required.

The runtime uses constrained cyclic coordinate descent on planar finger chains,
with base abduction and fixed segment lengths. The underlying iterative method is
cyclic coordinate descent, described in
[Welman's articulated-figure IK thesis](https://viterbi-web.usc.edu/~jbarbic/cs520-s19/ik/welman.pdf)
and also used by [Three.js CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html);
rotation bounds and resting curls are authored teaching-rig settings, not medical
limits or a guarantee of piano technique. The thumb has its own chain and limits.
Unreachable contacts remain bounded and are reported to the owning renderer.

`PianoHandRig.evaluatePose()` runs the same contact solver without updating scene
transforms, skin joints, nails, or the displayed tip positions. It returns a reused
six-element error buffer (finger indices 1–5, in meters), so wrist placement can
score candidates before `pose()` applies one final solution. The renderer owns
motion timing and caches placement by chord; the rig contains no animation clock.
Targets use keyboard-world meters, with X across the keys, Y up, and Z toward the
player. `setScale()` updates wrist-relative reach metadata and the displayed mesh
together. Scene parents are expected to have identity transforms.

Geometry and skinning follow
[glTF 2.0 skins](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#skins).
Meshes remain unchanged on disk. Warm skin materials, subtle surface detail,
and distal nail surfaces are prepared locally at runtime. Motion and fingering
are application-generated guidance, not capture of the player's actual fingers.
