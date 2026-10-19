'use strict';

/**
 * A sale's voucher use must come back wherever a settlement is voided. Today that is three places (a Register void, a
 * full gateway refund, an online-sale void); this pins that EVERY statement in `src` that stamps a settlement as voided
 * sits next to a `restoreForSettlement` call, so a fourth way to void a sale cannot be added without giving the use back.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []));
}

/** Source lines that WRITE `voided_at` on a settlement: an update of pos_order_settlements setting voided_at. */
function settlementVoidWrites(file) {
  // A commented-out call must not count, so line comments are blanked (same length keeps offsets honest).
  const text = fs.readFileSync(file, 'utf8').replace(/^(\s*)\/\/.*$/gm, (line) => ' '.repeat(line.length));
  const hits = [];
  const re = /table\('pos_order_settlements'\)[^;]*?\.update\(\{[^}]*voided_at\s*:/gs;
  let match = re.exec(text);
  while (match) {
    hits.push({ index: match.index, window: text.slice(Math.max(0, match.index - 2500), match.index + 1200) });
    match = re.exec(text);
  }
  return hits;
}

describe('voucher restore sites', () => {
  const files = walk(SRC).filter((file) => settlementVoidWrites(file).length > 0);

  it('finds the known places a settlement is voided', () => {
    const names = files.map((file) => path.relative(SRC, file)).sort();
    expect(names).toEqual(['modules/cashiering/service.js', 'modules/pos/service.js', 'modules/supermarket/paystack-sale.js']);
  });

  it.each(files.map((file) => [path.relative(SRC, file), file]))('%s gives a voucher use back next to every settlement void', (_name, file) => {
    for (const hit of settlementVoidWrites(file)) {
      expect(hit.window).toMatch(/restoreForSettlement\(/);
    }
  });
});
