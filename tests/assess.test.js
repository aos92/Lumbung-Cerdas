const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSensors, assess, normalizeCondition } = require('../lib/assess');
const { DEFAULT_LIMITS } = require('../lib/limits');

test('parseSensors: alias, string, koma desimal, hanya kunci yang dikirim', () => {
  const { values, error } = parseSensors({ CO2: '650', alkohol: '3,5', ch4: 2, suhu: '28.4', humidity: 70, Amonia: '4' });
  assert.equal(error, undefined);
  assert.deepEqual(values, { co2: 650, ammonia: 4, alcohol: 3.5, methane: 2, temp: 28.4, hum: 70 });
  assert.equal(parseSensors({ nh3: 7 }).values.ammonia, 7);
  assert.deepEqual(parseSensors({ co: 5 }).values, {}); // CO sudah diganti amonia
  assert.deepEqual(parseSensors({ foo: 1 }).values, {});
  assert.deepEqual(parseSensors({ co2: '' }).values, {});
});

test('parseSensors: menolak non-angka dan di luar rentang', () => {
  assert.match(parseSensors({ co2: 'abc' }).error, /co2/);
  assert.match(parseSensors({ hum: 130 }).error, /hum/);
  assert.match(parseSensors({ temp: -99 }).error, /temp/);
  assert.match(parseSensors({ ammonia: NaN }).error, /ammonia/);
});

test('normalizeCondition', () => {
  assert.equal(normalizeCondition('Segar'), 'segar');
  assert.equal(normalizeCondition('mulai busuk'), 'mulai busuk');
  assert.equal(normalizeCondition('sudah busuk'), 'busuk');
  assert.equal(normalizeCondition('berjamur'), 'busuk');
  assert.equal(normalizeCondition('matang sekali'), 'matang');
  assert.equal(normalizeCondition('fresh'), 'segar');
  assert.equal(normalizeCondition('ripe'), 'matang');
  assert.equal(normalizeCondition('starting to rot'), 'mulai busuk');
  assert.equal(normalizeCondition('rotten'), 'busuk');
  assert.equal(normalizeCondition('entah'), null);
  assert.equal(normalizeCondition(null), null);
});

test('assess: buah segar di udara bersih -> skor tinggi, risiko rendah', () => {
  const r = assess({ condition: 'segar', sensors: { co2: 450, ammonia: 1, alcohol: 1, methane: 2, temp: 24, hum: 60 } });
  assert.equal(r.food_health_score, 100);
  assert.equal(r.risk_level, 'rendah');
  assert.equal(r.risk_index, 0);
  assert.deepEqual(r.basis, ['visual', 'gas', 'lingkungan']);
});

test('assess: alkohol tinggi + metana + busuk -> risiko tinggi dan catatan', () => {
  const r = assess({ condition: 'busuk', sensors: { co2: 2600, alcohol: 120, methane: 150, temp: 33, hum: 90 } });
  assert.equal(r.risk_level, 'tinggi');
  assert.ok(r.food_health_score <= 10, String(r.food_health_score));
  assert.ok(r.risk_index >= 90);
  assert.ok(r.notes.some((n) => /Alkohol/.test(n)) && r.notes.some((n) => /Metana/.test(n)));
});

test('assess: satu indikator parah cukup untuk risiko tinggi walau skor masih tinggi', () => {
  const r = assess({ condition: 'segar', sensors: { alcohol: 60 } });
  assert.equal(r.risk_level, 'tinggi');
  assert.ok(r.risk_index >= 70);
});

test('assess: sebagian sensor / tanpa visual / tanpa apa pun', () => {
  assert.equal(assess({ sensors: { temp: 24 } }).risk_level, 'rendah');
  assert.deepEqual(assess({ condition: 'matang' }).basis, ['visual']);
  const none = assess({});
  assert.equal(none.food_health_score, null);
  assert.equal(none.risk_level, 'tidak diketahui');
});

test('assess: skor selalu 0..100 dan monoton terhadap alkohol', () => {
  let prev = 101;
  for (const a of [0, 5, 20, 50, 100, 500, 5000]) {
    const s = assess({ condition: 'matang', sensors: { alcohol: a, co2: 9000, methane: 9000, ammonia: 900, temp: 80, hum: 100 } }).food_health_score;
    assert.ok(s >= 0 && s <= 100 && s <= prev);
    prev = s;
  }
});

test('assess: batas min/maks dari aplikasi menggeser ambang', () => {
  const sensors = { alcohol: 40 };
  assert.equal(assess({ sensors }).risk_level, 'sedang'); // bawaan: maks 50
  const tight = { ...DEFAULT_LIMITS, alcohol: { min: 1, max: 30 } };
  assert.equal(assess({ sensors, limits: tight }).risk_level, 'tinggi');
  const loose = { ...DEFAULT_LIMITS, alcohol: { min: 1, max: 400 } };
  assert.equal(assess({ sensors, limits: loose }).risk_level, 'rendah');
});

test('assess: amonia tinggi tercatat', () => {
  const r = assess({ sensors: { ammonia: 60 } });
  assert.equal(r.risk_level, 'tinggi');
  assert.ok(r.notes.some((n) => /Amonia/.test(n)));
});
