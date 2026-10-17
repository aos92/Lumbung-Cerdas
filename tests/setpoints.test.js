const test = require('node:test');
const assert = require('node:assert/strict');
const sp = require('../lib/setpoints');

test('parseSetpoints: nama Indonesia/Inggris, awalan setpoint_, koma desimal, bersarang', () => {
  const a = sp.parseSetpoints({ co2: '2000', metana: '80', alkohol: '30', suhu: '24,5', kelembaban: '80' });
  assert.deepEqual(a.provided, { co2: 2000, methane: 80, alcohol: 30, temp: 24.5, hum: 80 });
  const b = sp.parseSetpoints({ setpoint_co2: 1500, SP_TEMP: 22 });
  assert.deepEqual(b.provided, { co2: 1500, temp: 22 });
  const c = sp.parseSetpoints({ setpoints: { methane: 60, humidity: 70 } });
  assert.deepEqual(c.provided, { methane: 60, hum: 70 });
  assert.deepEqual(sp.parseSetpoints({ co2: '', suhu: ' ' }).provided, {});
});

test('parseSetpoints: tolak non-angka dan di luar rentang', () => {
  for (const bad of [{ co2: 'abc' }, { co2: 0 }, { co2: 20000 }, { suhu: 100 }, { suhu: -50 }, { kelembaban: 101 }, { alkohol: 6000 }]) {
    const r = sp.parseSetpoints(bad);
    assert.ok(r.error, JSON.stringify(bad));
    assert.deepEqual(r.provided, {});
  }
});

test('toText: urutan co2|metana|alkohol|suhu|kelembaban', () => {
  assert.equal(sp.toText(sp.DEFAULT_SETPOINTS), '2500|100|50|25|85');
});
