// One physical keyboard layout for the flat display, hand contacts and 3D keys.
// Meters; X increases with pitch, Y is up, Z points toward the seated player.
export class KeyboardLayout {
  static whiteWidth = .0235;
  static whiteDepth = .150;
  static blackWidth = .0145;
  static blackDepth = .095;
  static blackHeight = .012;
  static blackClasses = new Set([1, 3, 6, 8, 10]);

  static key(midi) {
    if (!Number.isInteger(midi) || midi < 21 || midi > 108) return null;
    let whites = 0;
    for (let pitch = 21; pitch < midi; pitch++) {
      if (!KeyboardLayout.blackClasses.has(pitch % 12)) whites++;
    }
    const black = KeyboardLayout.blackClasses.has(midi % 12);
    const width = black ? KeyboardLayout.blackWidth : KeyboardLayout.whiteWidth;
    const x = (whites + (black ? 0 : .5)) * KeyboardLayout.whiteWidth;
    const height = black ? KeyboardLayout.blackHeight : 0;
    return {midi, black, x, width, height,
      depth: black ? KeyboardLayout.blackDepth : KeyboardLayout.whiteDepth,
      depression: black ? .005 : .008,
      contact: [x, height, black ? -.095 : -.035]};
  }

  static range(first, last) {
    const a = KeyboardLayout.key(first), b = KeyboardLayout.key(last);
    const left = a.x - a.width / 2, right = b.x + b.width / 2;
    return {left, right, width: right - left, center: (left + right) / 2};
  }

  static project(first, last, width) {
    const bounds = KeyboardLayout.range(first, last), scale = width / bounds.width;
    const keys = [];
    for (let midi = first; midi <= last; midi++) {
      const physical = KeyboardLayout.key(midi);
      keys.push({midi, black: physical.black,
        x: (physical.x - physical.width / 2 - bounds.left) * scale,
        centerX: (physical.x - bounds.left) * scale,
        width: physical.width * scale, physical});
    }
    return keys;
  }
}
