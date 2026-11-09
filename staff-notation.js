// Pitch-only notation: timing stays in the falling bars, not invented note values.
// Bravura uses four staff spaces per em; SMuFL glyph origins sit on staff lines.
export class StaffNotation {
  constructor() {
    this.cards = new Map();
  }

  async prepare() {
    await document.fonts.load('20px Rach3Music');
    for (let midi = 21; midi <= 108; midi++) this.cards.set(midi, this.makeCard(midi));
  }

  makeCard(midi) {
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 144;
    const pen = canvas.getContext('2d');
    pen.scale(2, 2);
    const bass = midi < 60;
    // Keep extreme pitches readable, with an explicit octave displacement.
    const octaves = midi < 36 ? -1 : midi >= 96 ? 2 : midi >= 84 ? 1 : 0;
    const written = midi - octaves * 12;
    const pitchClass = written % 12;
    const diatonic = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
    const step = (Math.floor(written / 12) - 1) * 7 + diatonic[pitchClass];
    const bottomStep = bass ? 18 : 30; // G2 (bass), E4 (treble).
    const gap = 5, staffBottom = 49, x = 28;
    const offset = step - bottomStep;
    const y = staffBottom - offset * gap / 2;

    pen.fillStyle = '#191b20';
    pen.fillRect(0, 0, 40, 72);
    pen.strokeStyle = '#f3f5f8'; pen.lineWidth = .6;
    pen.beginPath();
    for (let line = 0; line < 5; line++) {
      const row = staffBottom - line * gap;
      pen.moveTo(2, row); pen.lineTo(38, row);
    }
    pen.stroke();
    pen.lineWidth = .8;
    pen.beginPath();
    for (let ledger = -2; ledger >= offset; ledger -= 2) {
      const row = staffBottom - ledger * gap / 2;
      pen.moveTo(x - 2, row); pen.lineTo(x + 8, row);
    }
    for (let ledger = 10; ledger <= offset; ledger += 2) {
      const row = staffBottom - ledger * gap / 2;
      pen.moveTo(x - 2, row); pen.lineTo(x + 8, row);
    }
    pen.stroke();
    pen.fillStyle = '#f3f5f8'; pen.font = '20px Rach3Music';
    // Clefs anchor on F3 / G4 respectively.
    pen.fillText(bass ? '\uE062' : '\uE050', 2, staffBottom - (bass ? 3 : 1) * gap);
    if ([1, 3, 6, 8, 10].includes(pitchClass)) pen.fillText('\uE262', 20, y);
    pen.fillText('\uE0A4', x, y);
    pen.font = '8px -apple-system, sans-serif'; pen.textAlign = 'center';
    if (octaves) pen.fillText(octaves === -1 ? '8vb' : octaves === 2 ? '15ma' : '8va', 20, 12);
    return canvas;
  }

  draw(ctx, midi, center, bottom, width, label) {
    const card = this.cards.get(midi);
    if (!card) return;
    const w = Math.min(40, width - 3), h = w * 1.8;
    ctx.drawImage(card, center - w / 2, bottom - h, w, h);
    if (label && w > 18) {
      ctx.save();
      ctx.fillStyle = '#f3f5f8'; ctx.font = '600 ' + Math.min(9, w / 3.8) + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(label, center, bottom - 2);
      ctx.restore();
    }
  }
}
