const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySensors, combine, statusList } = require('../lib/classify');
const { DEFAULT_LIMITS, parseLimits, mergeLimits, toText } = require('../lib/limits');

const L = { ethylene: { min: 10, max: 50 }, co2: { min: 500, max: 1500 }, methane: { min: 5, max: 25 } };

test('semua gas <= minimal -> segar, indeks 0', () => {
  const r = classifySensors({ ethylene: 5, co2: 400, methane: 1 }, L);
  assert.deepEqual([r.class, r.index], ['segar', 0]);
  assert.deepEqual(statusList(r), ['normal', 'normal', 'normal']);
});

test('di antara min dan maks -> waspada, kelas naik sesuai indeks', () => {
  const r = classifySensors({ ethylene: 30, co2: 1000, methane: 15 }, L); // semua di tengah (t=0.5)
  assert.equal(r.index, 50);
  assert.equal(r.class, 'mulai busuk');
  assert.ok(Object.values(r.gases).every((g) => g.status === 'waspada' && g.position === 0.5));
  assert.equal(classifySensors({ ethylene: 18, co2: 600, methane: 6 }, L).class, 'segar'); // indeks kecil
  assert.equal(classifySensors({ ethylene: 22, co2: 700, methane: 8 }, L).class, 'matang');
});

test('satu gas >= maks -> minimal mulai busuk; dua gas -> busuk', () => {
  const one = classifySensors({ ethylene: 80, co2: 400, methane: 1 }, L);
  assert.equal(one.gases.ethylene.status, 'tinggi');
  assert.equal(one.class, 'mulai busuk');
  const two = classifySensors({ ethylene: 80, co2: 2000, methane: 1 }, L);
  assert.equal(two.class, 'busuk');
});

test('sebagian gas / tanpa gas', () => {
  assert.equal(classifySensors({ ethylene: 5 }, L).class, 'segar');
  assert.deepEqual(statusList(classifySensors({ ethylene: 5 }, L)), ['normal', '-', '-']);
  const none = classifySensors({ temp: 25 }, L);
  assert.deepEqual([none.class, none.index], [null, null]);
});

test('combine: ambil yang lebih buruk, abaikan yang kosong', () => {
  assert.equal(combine('segar', 'busuk'), 'busuk');
  assert.equal(combine('busuk', 'segar'), 'busuk');
  assert.equal(combine(null, 'matang'), 'matang');
  assert.equal(combine('matang', null), 'matang');
  assert.equal(combine(null, null), null);
});

test('parseLimits: nama Indonesia/Inggris, koma desimal, bersarang, validasi', () => {
  const a = parseLimits({ etilen_min: '2,5', ETILEN_MAKS: '40', co2_min: 500 });
  assert.deepEqual(a.provided, { ethylene: { min: 2.5, max: 40 }, co2: { min: 500 } });
  assert.deepEqual(parseLimits({ limits: { metana: { min: 1, maks: 9 } } }).provided, { methane: { min: 1, max: 9 } });
  assert.deepEqual(parseLimits({ etilen_min: '' }).provided, {});
  assert.match(parseLimits({ co2_max: 99999 }).error, /CO2 maksimal/);
  assert.match(parseLimits({ metana_min: 'x' }).error, /Metana minimal/);
});

test('mergeLimits: min harus < maks, bawaan tidak berubah; toText urut 6 kolom', () => {
  const m = mergeLimits(DEFAULT_LIMITS, { ethylene: { min: 1, max: 9 } });
  assert.deepEqual(m.limits.ethylene, { min: 1, max: 9 });
  assert.deepEqual(DEFAULT_LIMITS.ethylene, { min: 5, max: 50 });
  assert.match(mergeLimits(DEFAULT_LIMITS, { co2: { min: 3000 } }).error, /CO2: minimal \(3000\)/);
  assert.equal(toText(m.limits), '1|9|800|2500|5|100');
});
