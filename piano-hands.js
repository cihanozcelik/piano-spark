import { KeyboardLayout } from './keyboard-layout.js';
import { PianoHandRig } from './hand-rig.js';

// Optional teaching view. It consumes the player's lesson time and fingering
// plan, never starts a transport, and never infers the user's physical fingers.
export class PianoHands {
  constructor({container, onStatus = () => {}, onError = () => {}}) {
    this.container = container;
    this.onStatus = onStatus;
    this.onError = onError;
    this.visible = false;
    this.disposed = false;
    this.first = 21;
    this.last = 108;
    this.notes = [];
    this.bindings = [Array.from({length: 6}, () => []), Array.from({length: 6}, () => [])];
    this.missing = [];
    this.lastTime = -2;
    this.lastInput = {held: new Set(), practice: false, running: false};
    this.labels = [];
    this.keys = new Map();
    this.handScale = 1;
    this.handNotes = [[], []];
    this.contextAvailable = true;
    this.assetRoots = [];
    this.poseCorrections = [new Map(), new Map()];
    this.statusKey = '';
    this.restPoses = [null, null];
    this.animationFrame = null;
    this.previousFrameTime = null;
    this.renderFrame = timestamp => {
      this.animationFrame = null;
      if (!this.visible || this.disposed || !this.contextAvailable) return;
      const seconds = this.previousFrameTime === null ? 1 / 60 : Math.max(0, Math.min(.05, (timestamp - this.previousFrameTime) / 1000));
      this.previousFrameTime = timestamp;
      this.render(seconds);
      // Settle after a seek, release or practice input even when transport waits.
      // This loop never advances lesson time, sends MIDI or schedules audio.
      if (this.rigs?.some(rig => rig.moving)) this.requestRender();
      else this.previousFrameTime = null;
    };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  static smooth(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  static upperBound(notes, time) {
    let low = 0, high = notes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (notes[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  publish(status) {
    const key = JSON.stringify([status.code, status.hand, status.noteIds, status.reason]);
    if (key === this.statusKey || this.disposed) return;
    this.statusKey = key;
    this.onStatus(status);
  }

  prepare() {
    if (!this.preparation) this.preparation = this.prepareAssets();
    return this.preparation;
  }

  async prepareAssets() {
    this.publish({code: 'loading'});
    try {
      const {THREE, GLTFLoader} = window.PianoHandsRuntime;
      this.THREE = THREE;
      const loader = new GLTFLoader();
      const results = await Promise.allSettled(['left', 'right'].map(async hand => {
        let bytes;
        if (window.PianoHandAssets) {
          const binary = atob(window.PianoHandAssets[hand]);
          bytes = Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
        } else {
          const response = await fetch('/assets/hands/' + hand + '.glb');
          if (!response.ok) throw new Error('Hand asset could not be loaded: ' + hand);
          bytes = await response.arrayBuffer();
        }
        return loader.parseAsync(bytes, '');
      }));
      const assets = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      this.assetRoots = assets.map(asset => asset.scene);
      const failure = results.find(result => result.status === 'rejected');
      if (this.disposed) {
        PianoHands.disposeObject(this.assetRoots);
        this.assetRoots = [];
        return;
      }
      if (failure) throw failure.reason;
      this.createScene(assets);
      this.resize();
      this.publish({code: 'ready'});
      this.update(this.lastTime, this.lastInput);
    } catch (error) {
      if (!this.disposed) {
        this.publish({code: 'unavailable', reason: error.message});
        this.dispose();
        this.onError(error);
      }
      throw error;
    }
  }

  createScene(assets) {
    const T = this.THREE;
    this.renderer = new T.WebGLRenderer({antialias: true, alpha: false, powerPreference: 'low-power'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x191d22, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    canvas.setAttribute('aria-hidden', 'true');
    this.container.append(canvas);
    this.contextLost = event => {
      event.preventDefault();
      this.contextAvailable = false;
      const error = new Error('The 3D graphics context was lost.');
      this.publish({code: 'unavailable', reason: error.message});
      this.onError(error);
    };
    canvas.addEventListener('webglcontextlost', this.contextLost);
    this.contextRestored = () => { this.contextAvailable = true; this.resize(); this.update(this.lastTime, this.lastInput); };
    canvas.addEventListener('webglcontextrestored', this.contextRestored);

    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-1, 1, .3, -.3, .01, 5);
    this.scene.add(new T.HemisphereLight(0xf4f7ff, 0x344151, 1.7));
    this.keyLight = new T.DirectionalLight(0xfff4e8, 3.2);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -.00003;
    this.keyLight.shadow.normalBias = .0008;
    this.keyLight.shadow.camera.near = .05;
    this.keyLight.shadow.camera.far = 3;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight, this.keyLight.target);
    const fill = new T.DirectionalLight(0xc7dbff, .7);
    fill.position.set(.9, .35, -.2);
    this.scene.add(fill);

    this.deck = new T.Mesh(new T.BoxGeometry(1, .02, .235),
      new T.MeshStandardMaterial({color: 0x20262c, roughness: .8, metalness: .06}));
    this.deck.position.set(.611, -.028, -.06);
    this.deck.receiveShadow = true;
    this.scene.add(this.deck);
    const whiteGeometry = this.keyGeometry(KeyboardLayout.whiteWidth - .0006, KeyboardLayout.whiteDepth, .018, .00065);
    const blackGeometry = this.keyGeometry(KeyboardLayout.blackWidth - .0004, KeyboardLayout.blackDepth, .011, .00055);
    this.geometries = [whiteGeometry, blackGeometry];
    for (let midi = 21; midi <= 108; midi++) {
      const key = KeyboardLayout.key(midi);
      const material = new T.MeshStandardMaterial({color: key.black ? 0x191c21 : 0xf4f1e9,
        roughness: key.black ? .35 : .3, metalness: .02, emissive: 0x000000});
      const mesh = new T.Mesh(key.black ? blackGeometry : whiteGeometry, material);
      mesh.position.set(key.x, key.height, -KeyboardLayout.whiteDepth);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.key = key;
      this.keys.set(midi, mesh);
      this.scene.add(mesh);
    }
    this.rigs = assets.map((asset, hand) => {
      const rig = new PianoHandRig(T, asset, hand === 0 ? 'left' : 'right', {scale: this.handScale});
      this.scene.add(rig.group);
      return rig;
    });
    this.projected = new T.Vector3();
    for (const hand of [0, 1]) {
      const labels = [null];
      for (let finger = 1; finger <= 5; finger++) {
        const label = document.createElement('span');
        label.textContent = String(finger);
        label.setAttribute('aria-hidden', 'true');
        label.style.cssText = 'position:absolute;left:0;top:0;display:none;min-width:17px;height:17px;padding:0 3px;border-radius:50%;font:600 11px/17px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;color:#102034;pointer-events:none;box-shadow:0 1px 5px #0008;transform:translate(-50%,-50%)';
        label.style.background = hand === 0 ? '#a9c9ff' : '#ffd0b8';
        this.container.append(label);
        labels.push(label);
      }
      this.labels.push(labels);
    }
    this.applyLayout();
  }

  keyGeometry(width, depth, thickness, bevel) {
    const T = this.THREE, shape = new T.Shape();
    shape.moveTo(-width / 2 + bevel, -depth + bevel);
    shape.lineTo(width / 2 - bevel, -depth + bevel);
    shape.lineTo(width / 2 - bevel, -bevel);
    shape.lineTo(-width / 2 + bevel, -bevel);
    shape.closePath();
    const geometry = new T.ExtrudeGeometry(shape, {depth: thickness - 2 * bevel,
      bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1});
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -thickness + bevel, 0);
    geometry.computeVertexNormals();
    return geometry;
  }

  setLayout({first, last}) {
    this.first = first;
    this.last = last;
    if (this.renderer) { this.applyLayout(); this.resize(); }
  }

  applyLayout() {
    const bounds = KeyboardLayout.range(this.first, this.last);
    for (const [midi, mesh] of this.keys) mesh.visible = midi >= this.first && midi <= this.last;
    this.deck.position.x = bounds.center;
    this.deck.scale.x = bounds.width + .025;
    const light = this.keyLight;
    light.position.set(bounds.center - .3, .85, .3);
    light.target.position.set(bounds.center, 0, -.045);
    const radius = bounds.width / 2 + .23;
    light.shadow.camera.left = -radius;
    light.shadow.camera.right = radius;
    light.shadow.camera.top = .45;
    light.shadow.camera.bottom = -.45;
    light.shadow.camera.updateProjectionMatrix();
  }

  load(notes, plan) {
    this.handScale = plan?.handScale || 1;
    for (const rig of this.rigs || []) rig.setScale(this.handScale);
    for (const cache of this.poseCorrections) cache.clear();
    this.notes = notes.slice().sort((a, b) => a.time - b.time || a.midi - b.midi);
    this.bindings = [Array.from({length: 6}, () => []), Array.from({length: 6}, () => [])];
    this.missing = [];
    const assignments = new Map((plan?.assignments || []).map(item => [item.noteId, item]));
    for (const note of this.notes) {
      const assignment = assignments.get(note.sourceNoteId);
      const hand = assignment?.hand === 'left' ? 0 : assignment?.hand === 'right' ? 1 : assignment?.hand;
      const finger = assignment?.finger ?? assignment?.attackFinger;
      const key = KeyboardLayout.key(note.midi);
      if (!key || (hand !== 0 && hand !== 1) || !Number.isInteger(finger) || finger < 1 || finger > 5) {
        this.missing.push({...note, reason: !key ? 'outside-keyboard' : 'missing-fingering'});
        continue;
      }
      this.bindings[hand][finger].push({...note, hand, finger, key, noteIds: [note.sourceNoteId]});
    }
    for (const hand of [0, 1]) for (let finger = 1; finger <= 5; finger++) {
      const contacts = [];
      for (const note of this.bindings[hand][finger]) {
        const previous = contacts.at(-1);
        if (previous && previous.midi === note.midi && note.time < previous.end - .000001) {
          previous.end = Math.max(previous.end, note.end);
          previous.noteIds.push(...note.noteIds);
        } else contacts.push(note);
      }
      let maxEnd = -Infinity;
      for (let i = 0; i < contacts.length; i++) {
        const next = contacts[i];
        maxEnd = Math.max(maxEnd, next.end);next.prefixEnd = maxEnd;
        for (let earlier = i - 1; earlier >= 0 && contacts[earlier].prefixEnd > next.time; earlier--) {
          const prior = contacts[earlier];
          if (prior.end > next.time + .000001 && prior.midi !== next.midi) {
            this.missing.push({...next, end: Math.min(prior.end, next.end), reason: 'overlapping-finger-contacts'});
          }
        }
      }
      this.bindings[hand][finger] = contacts;
    }
    this.handNotes = this.bindings.map(fingers => fingers.slice(1).flat().sort((a, b) => a.time - b.time));
    this.update(this.lastTime, this.lastInput);
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (this.renderer) this.renderer.domElement.hidden = !this.visible;
    if (!visible) {
      cancelAnimationFrame(this.animationFrame);this.animationFrame = null;
      this.previousFrameTime = null;
      for (const rig of this.rigs || []) {rig.moving=false;rig.motionVelocity.fill(0);}
      for (const labels of this.labels) for (const label of labels.slice(1)) label.style.display = 'none';
    }
    if (visible) { this.resize(); this.update(this.lastTime, this.lastInput); }
  }

  resize() {
    if (!this.renderer || this.disposed) return;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    const bounds = KeyboardLayout.range(this.first, this.last), half = bounds.width / 2;
    // No sideways camera yaw: every key keeps the same horizontal projection as
    // the falling-note lane. Never stretch hand meshes to fit a resized panel.
    this.camera.left = -half;
    this.camera.right = half;
    this.camera.top = half * height / width;
    this.camera.bottom = -this.camera.top;
    this.camera.position.set(bounds.center, .39, .40);
    this.camera.lookAt(bounds.center, .022, -.025);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.update(this.lastTime, this.lastInput);
  }

  contact(note) {
    const mesh = this.keys.get(note.midi), key = note.key;
    const z = key.contact[2] + KeyboardLayout.whiteDepth;
    return [key.x, key.height - z * Math.sin(mesh.rotation.x),
      -KeyboardLayout.whiteDepth + z * Math.cos(mesh.rotation.x)];
  }

  fingerSample(notes, time, practice, held) {
    const after = PianoHands.upperBound(notes, time), next = notes[after];
    let prior = notes[after - 1];
    for (let index = after - 1; index >= 0 && notes[index].prefixEnd > time; index--) {
      if (notes[index].end <= time) continue;
      const active = notes[index], position = this.contact(active);
      if (practice && !held.has(active.midi)) position[1] += .009;
      return {note: active, position, weight: 1, active: true};
    }
    // The latest release can belong to an older, longer overlapping note.
    for (let index = after - 2; index >= 0 && notes[index].prefixEnd > (prior?.end ?? -Infinity); index--) {
      if (notes[index].end > prior.end) prior = notes[index];
    }
    const out = prior ? 1 - PianoHands.smooth((time - prior.end) / .18) : 0;
    const into = next ? PianoHands.smooth(1 - (next.time - time) / .48) : 0;
    if (out <= 0 && into <= 0) return null;
    const a = prior ? this.contact(prior) : null, b = next ? this.contact(next) : null;
    if (a) a[1] += .024 * (1 - out);
    if (b) b[1] += .024 * (1 - into);
    const ratio = into / (out + into);
    const position = a && b ? a.map((value, index) => value * (1 - ratio) + b[index] * ratio) : a || b;
    return {note: into >= out ? next : prior, position, weight: Math.max(out, into), active: false};
  }

  poseHand(hand, time, input, deltaSeconds) {
    const rig = this.rigs[hand], fingers = this.bindings[hand];
    const unresolved = this.missing.filter(note => note.hand === hand && note.time <= time && note.end > time);
    if (unresolved.length) {
      // Missing fingering is a guidance limitation, not a visibility switch.
      // Keep the hand at its preceding position and relax its fingers smoothly.
      const wrist = this.restPoses[hand]?.wrist || (this.handNotes[hand].length ? this.restWrist(hand,time) :
        [KeyboardLayout.key(hand === 0 ? 48 : 72).x,.055,.085]);
      rig.group.visible = true;
      rig.pose({wrist,targets:[],yaw:this.restPoses[hand]?.yaw || 0,deltaSeconds});
      for (const label of this.labels[hand].slice(1)) label.style.display = 'none';
      return {code: 'unresolved', hand, noteIds: unresolved.map(note => note.sourceNoteId), reason: unresolved[0].reason};
    }
    const all = this.handNotes[hand];
    if (!all.length) {
      rig.group.visible = false;rig.moving=false;rig.motionVelocity.fill(0);
      for (const label of this.labels[hand].slice(1)) label.style.display = 'none';
      return null;
    }
    const samples = [];
    const wrist = [0, 0, 0];
    for (let finger = 1; finger <= 5; finger++) {
      const sample = this.fingerSample(fingers[finger], time, input.practice, input.held);
      if (!sample) continue;
      samples.push({...sample, finger});
    }
    const active = samples.filter(sample => sample.active);
    const anchors = active.length ? active : samples;
    let weight = 0;
    for (const sample of anchors) {
      const importance = sample.weight;
      const rest = rig.restTips[sample.finger];
      for (let axis = 0; axis < 3; axis++) {
        const position = axis === 1 ? sample.note.key.height + .006 : sample.position[axis];
        wrist[axis] += (position - rest.getComponent(axis)) * importance;
      }
      weight += importance;
    }
    const resting = this.restWrist(hand, time);
    if (weight > 0) {
      const blend = Math.max(...samples.map(sample => sample.weight));
      for (let axis = 0; axis < 3; axis++) wrist[axis] = resting[axis] * (1 - blend) + wrist[axis] / weight * blend;
    } else {
      for (let axis = 0; axis < 3; axis++) wrist[axis] = resting[axis];
    }
    wrist[1] = Math.max(.028, Math.min(.085, wrist[1]));
    wrist[2] = Math.max(-.025, Math.min(.17, wrist[2]));
    const targets = samples.map(sample => ({finger: sample.finger, position: sample.position, weight: sample.weight}));
    rig.group.visible = true;
    this.fitPose(hand, rig, wrist, targets, anchors, deltaSeconds);
    const failed = samples.filter(sample => sample.active && rig.contactErrors[sample.finger] > .008);
    for (let finger = 1; finger <= 5; finger++) {
      const label = this.labels[hand][finger], sample = samples.find(item => item.finger === finger);
      if (!sample || (!sample.active && sample.weight < .35)) {label.style.display = 'none';continue;}
      this.projected.copy(rig.tip(finger));this.projected.y += .012;this.projected.project(this.camera);
      if (Math.abs(this.projected.x) > 1 || Math.abs(this.projected.y) > 1 || this.projected.z > 1) {
        label.style.display = 'none';continue;
      }
      label.style.display = 'block';
      label.style.left = ((this.projected.x + 1) * .5 * this.width) + 'px';
      label.style.top = ((1 - this.projected.y) * .5 * this.height) + 'px';
      label.style.opacity = sample.active ? '1' : '.65';
    }
    return failed.length && !rig.moving ? {code: 'unreachable', hand,
      noteIds: failed.flatMap(sample => sample.note.noteIds),
      errorMeters: Math.max(...failed.map(sample => rig.contactErrors[sample.finger]))} : null;
  }

  restWrist(hand, time) {
    const all = this.handNotes[hand], rig = this.rigs[hand];
    let latestEnd = -Infinity;
    for (const note of all) if (note.end <= time) latestEnd = Math.max(latestEnd, note.end);
    const notes = Number.isFinite(latestEnd) ? all.filter(note => Math.abs(note.end - latestEnd) < .000001) :
      all.filter(note => Math.abs(note.time - all[0].time) < .000001);
    const wrist = [0, 0, 0];
    for (const note of notes) {
      const rest = rig.restTips[note.finger];
      for (let axis = 0; axis < 3; axis++) {
        const position = axis === 1 ? note.key.height + .006 : note.key.contact[axis];
        wrist[axis] += (position - rest.getComponent(axis)) / notes.length;
      }
    }
    return wrist;
  }

  fitPose(hand, rig, preferred, targets, anchors, deltaSeconds) {
    if (!anchors.length) {
      this.restPoses[hand]={wrist:preferred.slice(),yaw:0};
      rig.pose({wrist: preferred, targets, yaw: 0, deltaSeconds});return;
    }
    const key = anchors.map(sample => sample.finger + ':' + sample.note.midi).join(',');
    const cache = this.poseCorrections[hand];
    let correction = cache.get(key);
    if (!correction) {
      correction = this.solveCorrection(rig, anchors);
      cache.set(key, correction);
    }
    const blend = Math.max(...anchors.map(sample => sample.weight));
    const wrist = preferred.map((value, axis) => value + correction.offset[axis] * blend);
    const yaw = correction.yaw * blend;
    this.restPoses[hand]={wrist:wrist.slice(),yaw};
    rig.pose({wrist, targets, yaw, deltaSeconds});
  }

  solveCorrection(rig, active) {
    // Canonical contacts make the cached solution independent of playback order,
    // seek history, held MIDI state and animation phase. Skin transforms are
    // written only for the final frame pose, never for search candidates.
    const targets = active.map(sample => ({finger: sample.finger,
      position: sample.note.key.contact.map((value, axis) => axis === 1 ? value - .003 : value), weight: 1}));
    const preferred = [0, 0, 0];
    for (const sample of active) for (let axis = 0; axis < 3; axis++) {
      const position = axis === 1 ? sample.note.key.height + .006 : sample.note.key.contact[axis];
      preferred[axis] += (position - rig.restTips[sample.finger].getComponent(axis)) / active.length;
    }
    preferred[1] = Math.max(.028, Math.min(.085, preferred[1]));
    preferred[2] = Math.max(-.025, Math.min(.17, preferred[2]));
    let wrist = preferred.slice(), yaw = 0;
    const cost = (position, rotation) => {
      const errors = rig.evaluatePose({wrist: position, targets, yaw: rotation});
      return active.reduce((sum, sample) => sum + errors[sample.finger] ** 2, 0) +
        position.reduce((sum, value, axis) => sum + (value - preferred[axis]) ** 2 * .012, 0) + rotation ** 2 * .000002;
    };
    let best = cost(wrist, yaw);
    // Bounded, deterministic coordinate descent adjusts the wrist before giving
    // up on a valid chord. Bone lengths and target contacts never change.
    for (const step of [.014, .007, .0035]) {
      const origin = wrist.slice(), rotation = yaw;
      for (let axis = 0; axis < 4; axis++) for (const sign of [-1, 1]) {
        const candidate = origin.slice();let candidateYaw = rotation;
        if (axis === 3) candidateYaw = Math.max(-.3, Math.min(.3, rotation + sign * step * 9));
        else candidate[axis] += sign * step * (axis === 1 ? .5 : 1);
        candidate[1] = Math.max(.025, Math.min(.09, candidate[1]));
        candidate[2] = Math.max(-.03, Math.min(.18, candidate[2]));
        const value = cost(candidate, candidateYaw);
        if (value < best) {best = value;wrist = candidate;yaw = candidateYaw;}
      }
    }
    return {offset: wrist.map((value, axis) => value - preferred[axis]), yaw};
  }

  update(time, {held = new Set(), practice = false, running = false} = {}) {
    this.lastTime = time;
    this.lastInput = {held, practice, running};
    this.requestRender();
  }

  requestRender() {
    if (!this.visible || !this.renderer || !this.width || !this.contextAvailable || this.disposed || this.animationFrame !== null) return;
    this.animationFrame=requestAnimationFrame(this.renderFrame);
  }

  render(deltaSeconds) {
    const time=this.lastTime,{held,practice}=this.lastInput;
    const pressed = new Map();
    if (practice) for (const midi of held) pressed.set(midi, 1);
    else for (const note of this.notes) {
      if (note.time > time) break;
      const amount = time < note.end ? PianoHands.smooth((time - note.time) / .045) :
        1 - PianoHands.smooth((time - note.end) / .09);
      if (amount > 0) pressed.set(note.midi, Math.max(pressed.get(note.midi) || 0, amount));
    }
    for (const [midi, mesh] of this.keys) {
      const key = mesh.userData.key, amount = pressed.get(midi) || 0;
      mesh.rotation.x = key.depression / key.depth * amount;
      mesh.material.emissive.setHex(amount ? (midi < 60 ? 0x153257 : 0x472518) : 0x000000);
      mesh.material.emissiveIntensity = amount * .6;
    }
    const problems = [this.poseHand(0, time, this.lastInput, deltaSeconds), this.poseHand(1, time, this.lastInput, deltaSeconds)].filter(Boolean);
    this.publish(problems[0] || {code: 'ready'});
    this.renderer.render(this.scene, this.camera);
  }

  static disposeObject(object) {
    const materials = new Set(), geometries = new Set(), textures = new Set(), skeletons = new Set();
    for (const root of Array.isArray(object) ? object : [object]) root.traverse(node => {
      if (node.skeleton) skeletons.add(node.skeleton);
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const texture of textures) {texture.source?.data?.close?.();texture.dispose();}
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);this.animationFrame=null;
    this.resizeObserver.disconnect();
    for (const labels of this.labels) for (const label of labels.slice(1)) label.remove();
    PianoHands.disposeObject(this.scene ? [this.scene, ...this.assetRoots] : this.assetRoots);
    this.assetRoots = [];
    this.keyLight?.shadow.dispose();
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('webglcontextlost', this.contextLost);
      canvas.removeEventListener('webglcontextrestored', this.contextRestored);
      this.renderer.dispose();canvas.remove();
    }
    this.keys.clear();
  }
}
