// Transport-independent MIDI input. Times are local monotonic seconds.
export class PianoInput extends EventTarget {
  constructor() {
    super();
    this.sources = new Map();
    this.serial = 0;
  }

  source(id) {
    if (!this.sources.has(id)) {
      this.sources.set(id, { connected: false, label: id, keys: new Map(), attacks: new Map() });
    }
    return this.sources.get(id);
  }

  snapshot(id) {
    const source = this.source(id);
    return {
      connected: source.connected,
      label: source.label,
      held: new Set([...source.keys.values()].map(key => key.note)),
      attacks: new Map(source.attacks),
    };
  }

  change(id, operation) {
    const at = performance.now() / 1000;
    this.dispatchEvent(new CustomEvent('beforechange', { detail: { source: id, at } }));
    operation(this.source(id), at);
    this.dispatchEvent(new CustomEvent('change', { detail: { source: id, at } }));
  }

  connect(id, label = id) {
    this.change(id, source => {
      source.keys.clear();
      source.attacks.clear();
      source.connected = true;
      source.label = label;
    });
  }

  disconnect(id) {
    this.change(id, source => {
      source.keys.clear();
      source.attacks.clear();
      source.connected = false;
    });
  }

  reset(id) {
    this.change(id, source => {
      source.keys.clear();
      source.attacks.clear();
    });
  }

  receive(event, id = 'bluetooth') {
    if (event.event === 'ready') { this.connect(id, event.name || 'Bluetooth piyano'); return; }
    if (['disconnected', 'stopped', 'error'].includes(event.event)) { this.disconnect(id); return; }
    if (event.event === 'all_notes_off') { this.reset(id); return; }
    if (event.event !== 'note_on' && event.event !== 'note_off') return;
    // This is the external message boundary, not inferred piano state.
    if (!Number.isInteger(event.note) || event.note < 0 || event.note > 127) return;
    const velocity = event.velocity ?? (event.event === 'note_on' ? 100 : 0);
    if (!Number.isFinite(velocity) || velocity < 0 || velocity > 127) return;
    if (!this.source(id).connected) return;
    const key = `${event.input_id ?? ''}:${event.group ?? 0}:${event.channel ?? 1}:${event.note}`;
    this.change(id, (source, at) => {
      if (event.event === 'note_on' && velocity > 0) {
        source.keys.set(key, { note: event.note, velocity });
        source.attacks.set(event.note, { serial: ++this.serial, at });
      } else {
        source.keys.delete(key);
      }
    });
  }
}
