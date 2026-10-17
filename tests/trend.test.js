const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, applyChange } = require('../lib/trend');
const { assess } = require('../lib/assess');

const base = { co2: 450, ammonia: 1, alcohol: 1, methane: 3, temp: 25, hum: 60 };
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
const o = (minutes, sensors = {}, score = 100, condition = 'segar') => ({ ts: T0 + minutes * 60000, sensors: { ...base, ...sensors }, score, condition });

test('kurang dari 4 pengamatan atau rentang waktu pendek -> belum cukup data', () => {
  assert.equal(analyze([o(0)]).status, 'belum cukup data');
  assert.equal(analyze([o(0), o(30), o(60)]).status, 'belum cukup data');
  assert.equal(analyze([o(0), o(1), o(2), o(3)]).status, 'belum cukup data'); // rentang < 10 menit
});

test('stabil: tidak ada sinyal, penalti 0', () => {
  const r = analyze([o(0), o(30), o(60, { co2: 470 }), o(90)]);
  assert.equal(r.status, 'stabil');
  assert.equal(r.significant, false);
  assert.equal(r.penalty, 0);
});

test('sinyal gas naik dari baseline -> signifikan, ada penalti', () => {
  const r = analyze([o(0), o(30), o(60, { alcohol: 30, methane: 60 }, 80), o(90, { alcohol: 40, methane: 60 }, 70)]);
  assert.equal(r.significant, true);
  assert.equal(r.status, 'memburuk');
  assert.ok(r.signals.some((s) => /Alkohol/.test(s)));
  assert.ok(r.signals.some((s) => /Metana/.test(s)));
  assert.ok(r.penalty > 0 && r.penalty <= 20);
  assert.ok(r.score_per_hour < 0);
});

test('suhu/kelembaban berubah saja bukan tanda pembusukan', () => {
  const r = analyze([o(0), o(30), o(60, { temp: 35, hum: 90 }), o(90, { temp: 35, hum: 90 })]);
  assert.equal(r.significant, false);
});

test('penurunan skor dan kondisi visual memburuk menjadi sinyal', () => {
  const r = analyze([o(0), o(30, {}, 95), o(60, {}, 70, 'mulai busuk'), o(90, {}, 60, 'busuk')]);
  assert.ok(r.signals.some((s) => /Skor turun/.test(s)));
  assert.ok(r.signals.some((s) => /Kondisi visual memburuk/.test(s)));
});

test('matang alami (segar -> matang) bukan sinyal visual', () => {
  const r = analyze([o(0), o(30), o(60, {}, 100, 'matang'), o(90, {}, 100, 'matang')]);
  assert.ok(!r.signals.some((s) => /Kondisi visual/.test(s)));
});

test('applyChange: satu sinyal -> minimal sedang; dua sinyal -> tinggi; skor tidak negatif', () => {
  const v = assess({ condition: 'segar', sensors: base });
  const one = applyChange(v, { significant: true, signals: ['a'], penalty: 5 });
  assert.equal(one.risk_level, 'sedang');
  assert.equal(one.food_health_score, v.food_health_score - 5);
  assert.equal(one.food_health_score_static, v.food_health_score);
  const two = applyChange(v, { significant: true, signals: ['a', 'b'], penalty: 20 });
  assert.equal(two.risk_level, 'tinggi');
  assert.ok(two.risk_index >= 70);
  const low = applyChange({ ...v, food_health_score: 5 }, { significant: false, signals: [], penalty: 20 });
  assert.equal(low.food_health_score, 0);
  const none = applyChange(assess({}), { significant: true, signals: ['a'], penalty: 5 });
  assert.equal(none.food_health_score, null);
});
