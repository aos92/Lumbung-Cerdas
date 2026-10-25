// Server penuh melawan mock NVIDIA Build. Tidak butuh key asli.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-bytes')]);
const KEY = 'nvapi-test-key';
const SECRET = 'rahasia-bersama';

let nvidia; let base; let app;
const seen = [];
let reply = () => ({ status: 200, body: { choices: [{ message: { content: '' } }] } });
const answer = (text) => { reply = () => ({ status: 200, body: { choices: [{ message: { content: text } }] } }); };

test.before(async () => {
  nvidia = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      const r = reply();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => nvidia.listen(0, '127.0.0.1', r));
  process.env.NVIDIA_API_KEY = KEY;
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${nvidia.address().port}/v1`;
  process.env.SHARED_SECRET = SECRET;
  delete process.env.NVIDIA_VISION_MODEL;
  app = require('../server.js').createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  app.closeAllConnections?.();
  await new Promise((r) => app.close(r));
  await new Promise((r) => nvidia.close(r));
});

const store = require('../lib/store');
const FULL = { co2: 450, ethylene: 1, methane: 3, temp: 25, hum: 60 };
test.beforeEach(() => { seen.length = 0; store.reset(); store.saveSensors(FULL); });

const post = (qs = '', body = JPEG, headers = {}) => fetch(`${base}/api/fruit${qs}`, {
  method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-api-key': SECRET, ...headers }, body,
});

test('/health publik, tanpa membocorkan key', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['model', 'provider', 'service', 'status']);
  assert.ok(!text.includes(KEY) && !text.includes(SECRET));
});

test('auth: tanpa/kunci salah -> 401 dan NVIDIA tidak dipanggil; Bearer juga diterima', async () => {
  assert.equal((await post('', JPEG, { 'x-api-key': '' })).status, 401);
  assert.equal((await post('', JPEG, { 'x-api-key': 'salah' })).status, 401);
  assert.equal(seen.length, 0);
  answer('{"is_fruit":true,"name_id":"apel","name_en":"apple","confidence":"tinggi","nutrition":"x"}');
  const bearer = await fetch(`${base}/api/fruit?format=text`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.equal(await bearer.text(), 'Apel|Serat & vitamin C');
});

test('GET /api/fruit -> 405; rute lain -> 404', async () => {
  assert.equal((await fetch(`${base}/api/fruit`, { headers: { 'x-api-key': SECRET } })).status, 405);
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST' })).status, 404);
});

test('mengirim gambar + prompt ke NVIDIA dengan Bearer key dan model bawaan', async () => {
  answer('{"is_fruit":true,"name_id":"jeruk","name_en":"orange","confidence":"tinggi","nutrition":"x"}');
  const res = await post('?format=text');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Jeruk|Tinggi vitamin C');
  const r = seen[0];
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.auth, `Bearer ${KEY}`);
  assert.equal(r.body.model, 'meta/llama-3.2-11b-vision-instruct');
  const parts = r.body.messages[0].content;
  assert.match(parts.find((p) => p.type === 'image_url').image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(parts.some((p) => p.type === 'text' && /JSON/.test(p.text)));
  assert.equal(r.body.stream, false);
});

test('NVIDIA_VISION_MODEL mengganti model', async () => {
  process.env.NVIDIA_VISION_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';
  answer('{"is_fruit":true,"name_id":"pisang","name_en":"banana","confidence":"tinggi","nutrition":"x"}');
  await (await post()).text();
  delete process.env.NVIDIA_VISION_MODEL;
  assert.equal(seen[0].body.model, 'nvidia/nemotron-nano-12b-v2-vl');
});

test('format JSON default, base64 dalam JSON, dan jawaban berbungkus markdown', async () => {
  answer('Tentu!\n```json\n{"is_fruit":"true","name_id":"stroberi segar","name_en":"strawberry","confidence":"sedang","nutrition":"manis"}\n```');
  const json = await (await post()).json();
  assert.equal(json.fruit, 'Stroberi Segar');
  assert.equal(json.nutrition, 'Tinggi vitamin C');
  const viaJson = await fetch(`${base}/api/fruit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': SECRET }, body: JSON.stringify({ image: JPEG.toString('base64') }) });
  assert.equal((await viaJson.json()).ok, true);
});

test('bukan buah', async () => {
  answer('{"is_fruit":false,"name_id":"","name_en":"","confidence":"rendah","nutrition":""}');
  assert.equal(await (await post('?format=text')).text(), 'Bukan buah|Coba arahkan ulang');
});

test('input salah: kosong 400, bukan gambar 400, JSON rusak 400, terlalu besar 413', async () => {
  assert.equal((await post('', Buffer.alloc(0))).status, 400);
  assert.equal((await post('', Buffer.from('halo'))).status, 400);
  assert.equal((await post('', '{rusak', { 'Content-Type': 'application/json' })).status, 400);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await post('?format=text', big)).status, 413);
  assert.equal(seen.length, 0);
});

test('jawaban bukan JSON -> 502 dengan pesan jelas', async () => {
  answer('Maaf, saya tidak bisa membantu.');
  const res = await post('?format=text');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /^ERR\|Jawaban model tidak bisa dibaca/);
});

for (const [status, pattern] of [[401, /Key NVIDIA ditolak/], [403, /Key NVIDIA ditolak/], [402, /Kredit NVIDIA habis/], [404, /Model NVIDIA tidak ditemukan/], [413, /Gambar terlalu besar untuk NVIDIA/]]) {
  test(`NVIDIA ${status} -> 502 + pesan Indonesia, key tidak bocor`, async () => {
    reply = () => ({ status, body: { detail: 'upstream detail' } });
    const res = await post('?format=text');
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, pattern);
    assert.ok(!text.includes(KEY));
  });
}

test('NVIDIA 429 diteruskan sebagai 429 (tanpa ulang)', async () => {
  reply = () => ({ status: 429, body: { detail: 'Too Many Requests' } });
  const res = await post('?format=text');
  assert.equal(res.status, 429);
  assert.match(await res.text(), /Batas request NVIDIA/);
  assert.equal(seen.length, 1);
});

test('NVIDIA 5xx diulang sekali lalu berhasil', async () => {
  let n = 0;
  reply = () => (++n === 1
    ? { status: 503, body: { detail: 'busy' } }
    : { status: 200, body: { choices: [{ message: { content: '{"is_fruit":true,"name_id":"mangga","name_en":"mango","confidence":"tinggi","nutrition":"x"}' } }] } });
  assert.equal(await (await post('?format=text')).text(), 'Mangga|Vitamin A & C');
  assert.equal(seen.length, 2);
});

test('NVIDIA 5xx terus-menerus -> 502 setelah 2 percobaan', async () => {
  reply = () => ({ status: 500, body: { detail: 'rusak' } });
  assert.equal((await post('?format=text')).status, 502);
  assert.equal(seen.length, 2);
});

test('NVIDIA tidak terjangkau -> 502 pesan jelas', async () => {
  const saved = process.env.NVIDIA_BASE_URL;
  process.env.NVIDIA_BASE_URL = 'http://127.0.0.1:1/v1';
  const res = await post('?format=text');
  process.env.NVIDIA_BASE_URL = saved;
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Tidak bisa menghubungi NVIDIA/);
});

test('NVIDIA lambat -> 504 (FRUIT_TIMEOUT_MS)', async () => {
  const slow = http.createServer(() => { /* tidak pernah menjawab */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const saved = { b: process.env.NVIDIA_BASE_URL, t: process.env.FRUIT_TIMEOUT_MS };
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${slow.address().port}/v1`;
  process.env.FRUIT_TIMEOUT_MS = '200';
  const res = await post('?format=text');
  process.env.NVIDIA_BASE_URL = saved.b;
  if (saved.t === undefined) delete process.env.FRUIT_TIMEOUT_MS; else process.env.FRUIT_TIMEOUT_MS = saved.t;
  slow.closeAllConnections?.();
  await new Promise((r) => slow.close(r));
  assert.equal(res.status, 504);
  assert.match(await res.text(), /Waktu habis menunggu NVIDIA/);
});

test('NVIDIA_API_KEY kosong saat berjalan -> 500, bukan crash', async () => {
  const saved = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = '';
  const res = await post('?format=text');
  process.env.NVIDIA_API_KEY = saved;
  assert.equal(res.status, 500);
  assert.match(await res.text(), /NVIDIA_API_KEY belum diisi/);
});

test('tiga foto bersamaan semuanya terlayani', async () => {
  answer('{"is_fruit":true,"name_id":"apel","name_en":"apple","confidence":"tinggi","nutrition":"x"}');
  const results = await Promise.all([post('?format=text'), post('?format=text'), post('?format=text')]);
  for (const r of results) assert.equal(await r.text(), 'Apel|Serat & vitamin C');
  assert.equal(seen.length, 3);
});

// --- Sensor + endpoint App Inventor ---
const H = { 'x-api-key': SECRET };
const FRESH = '{"is_fruit":true,"name_id":"pisang","name_en":"banana","condition":"segar","confidence":"tinggi","nutrition":"x"}';
const ROT = '{"is_fruit":true,"name_id":"pisang","name_en":"banana","condition":"busuk","confidence":"tinggi","nutrition":"x"}';
const Q = 'co2=500&ethylene=1&methane=3&temp=26&hum=65';

test('sensor lewat query bersama foto -> skor & risiko, format=text tetap "Nama|Nutrisi"', async () => {
  answer(FRESH);
  const json = await (await post(`?${Q}`)).json();
  assert.equal(json.sensors_source, 'inline');
  assert.deepEqual(json.sensors, { co2: 500, ethylene: 1, methane: 3, temp: 26, hum: 65 });
  assert.equal(json.risk_level, 'rendah');
  assert.ok(json.food_health_score >= 95);
  assert.equal(json.condition, 'segar');
  assert.equal(await (await post(`?format=text&${Q}`)).text(), 'Pisang|Kaya kalium & energi');
});

test('sensor di dalam JSON (top-level maupun objek sensors)', async () => {
  answer(ROT);
  const send = (extra) => fetch(`${base}/api/fruit`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ image: JPEG.toString('base64'), ...extra }) });
  const a = await (await send({ sensors: { co2: 2700, ethylene: 90, methane: 120, temp: 32, hum: 88 } })).json();
  assert.equal(a.risk_level, 'tinggi');
  assert.equal(a.sensors.ethylene, 90);
  const b = await (await send({ co2: 400, ethylene: 1, methane: 3, temp: 25, hum: 60 })).json();
  assert.equal(b.sensors_source, 'inline');
  assert.equal(b.sensors.co2, 400);
  const partial = await send({ co2: 400 });
  assert.equal(partial.status, 400);
  assert.match((await partial.json()).error, /kurang: ethylene, methane, temp, hum/);
});

test('nilai sensor tidak valid -> 400 dan NVIDIA tidak dipanggil', async () => {
  const res = await post('?co2=abc');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Nilai sensor tidak valid: co2/);
  assert.equal(seen.length, 0);
});

test('sensor WAJIB: tanpa data sensor -> 400 dan NVIDIA tidak dipanggil', async () => {
  store.reset();
  const res = await post('?format=text');
  assert.equal(res.status, 400);
  assert.match(await res.text(), /^ERR\|Data sensor wajib/);
  assert.equal(seen.length, 0);
});

test('sensor sebagian lewat query -> 400 dengan daftar yang kurang', async () => {
  const res = await post('?co2=500&temp=26');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /kurang: ethylene, methane, hum/);
  assert.equal(seen.length, 0);
});

test('/api/sensors lalu foto tanpa sensor -> memakai pembacaan tersimpan', async () => {
  const s = await fetch(`${base}/api/sensors`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ co2: 480, ethylene: 2, methane: 3, temp: 25, hum: 60 }) });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).ok, true);
  answer(FRESH);
  const json = await (await post()).json();
  assert.equal(json.sensors_source, 'stored');
  assert.equal(json.sensors.co2, 480);
});

test('pembacaan tersimpan yang basi tidak dipakai (SENSOR_MAX_AGE_S)', async () => {
  const saved = process.env.SENSOR_MAX_AGE_S;
  store.saveSensors(FULL, Date.now() - 5000);
  process.env.SENSOR_MAX_AGE_S = '2';
  answer(FRESH);
  const res = await post();
  const json = await res.json();
  assert.equal(res.status, 400);
  if (saved === undefined) delete process.env.SENSOR_MAX_AGE_S; else process.env.SENSOR_MAX_AGE_S = saved;
  assert.equal(json.error.startsWith('Data sensor wajib'), true);
});

test('/api/sensors: query, format=text, input salah, kosong, terlalu besar', async () => {
  const q = await fetch(`${base}/api/sensors?format=text&co2=500&ethylene=80&methane=3&temp=30&hum=65`, { method: 'POST', headers: H });
  assert.match(await q.text(), /^OK\|\d+\|tinggi\|(segar|matang|mulai busuk|busuk)$/);
  assert.equal((await fetch(`${base}/api/sensors`, { method: 'POST', headers: H })).status, 400);
  const part = await fetch(`${base}/api/sensors?ethylene=80&temp=30`, { method: 'POST', headers: H });
  assert.equal(part.status, 400);
  assert.match((await part.json()).error, /kurang: co2, methane, hum/);
  assert.equal((await fetch(`${base}/api/sensors?hum=500`, { method: 'POST', headers: H })).status, 400);
  assert.equal((await fetch(`${base}/api/sensors`, { method: 'POST', headers: H, body: '{rusak' })).status, 400);
  assert.equal((await fetch(`${base}/api/sensors`, { method: 'POST', headers: H, body: 'x'.repeat(20000) })).status, 413);
});

test('/api/latest JSON dan teks (untuk App Inventor)', async () => {
  store.reset();
  const empty = await (await fetch(`${base}/api/latest`, { headers: H })).json();
  assert.deepEqual([empty.ok, empty.result, empty.sensors], [true, null, null]);
  assert.equal(await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text(), Array(24).fill('-').join('|'));
  answer(ROT);
  await (await post(`?${Q}`)).text();
  const l = await (await fetch(`${base}/api/latest`, { headers: H })).json();
  assert.equal(l.result.fruit, 'Pisang');
  assert.equal(l.result.risk_level, 'tinggi');
  assert.equal(l.sensors.values.co2, 500);
  assert.equal(typeof l.result.age_s, 'number');
  assert.ok(l.sensors.assessment);
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.equal(t.length, 24);
  assert.ok(Number.isInteger(Number(t[18])) && Number.isInteger(Number(t[19]))); // umur sensor & umur hasil foto (detik)
  assert.deepEqual(t.slice(10, 12), ['belum cukup data', 'tidak']);
  assert.deepEqual(t.slice(12, 17), ['segar', '0', 'normal', 'normal', 'normal']);
  assert.equal(t[17], 'busuk'); // visual busuk menang atas sensor segar
  assert.equal(t[0], 'Pisang');
  assert.equal(t[3], 'tinggi');
  assert.deepEqual(t.slice(5, 10), ['500', '1', '3', '26', '65']);
});

test('/api/latest hanya sensor (tanpa foto) tetap terisi', async () => {
  await fetch(`${base}/api/sensors?co2=500&ethylene=10&methane=3&temp=27&hum=60`, { method: 'POST', headers: H });
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.equal(t[0], '-');
  assert.equal(t[6], '10');
});

test('/api/history: urutan terbaru dulu, limit, type=sensors', async () => {
  answer(FRESH); await (await post('?co2=400&ethylene=1&methane=3&temp=25&hum=60')).text();
  answer(ROT); await (await post('?co2=900&ethylene=1&methane=3&temp=25&hum=60')).text();
  const h = await (await fetch(`${base}/api/history?limit=1`, { headers: H })).json();
  assert.equal(h.count, 1);
  assert.equal(h.items[0].condition, 'busuk');
  const all = await (await fetch(`${base}/api/history`, { headers: H })).json();
  assert.deepEqual(all.items.map((i) => i.condition), ['busuk', 'segar']);
  const sens = await (await fetch(`${base}/api/history?type=sensors`, { headers: H })).json();
  assert.deepEqual(sens.items.slice(0, 2).map((i) => i.values.co2), [900, 400]);
});

test('endpoint baru butuh kunci dan metode yang benar', async () => {
  assert.equal((await fetch(`${base}/api/latest`)).status, 401);
  assert.equal((await fetch(`${base}/api/trend`)).status, 401);
  assert.equal((await fetch(`${base}/api/history`, { headers: { 'x-api-key': 'salah' } })).status, 401);
  assert.equal((await fetch(`${base}/api/sensors?co2=1`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/latest`, { method: 'POST', headers: H })).status, 405);
  assert.equal((await fetch(`${base}/api/sensors`, { headers: H })).status, 405);
});

// --- Analisis perubahan per jenis buah ---
const seed = (key, rows) => rows.forEach(([minAgo, sensors, score, condition]) =>
  store.addObservation(key, { sensors: { ...FULL, ...sensors }, score, condition }, Date.now() - minAgo * 60000));

test('pembusukan dari waktu ke waktu: perubahan signifikan menurunkan skor dan menaikkan risiko', async () => {
  seed('pisang', [
    [120, {}, 100, 'segar'], [110, { ethylene: 2 }, 98, 'segar'], [100, {}, 100, 'segar'], [30, { ethylene: 25, methane: 40, co2: 900 }, 80, 'matang'],
  ]);
  answer('{"is_fruit":true,"name_id":"pisang ambon","name_en":"banana","condition":"mulai busuk","confidence":"tinggi","nutrition":"x"}');
  const json = await (await post('?co2=1000&ethylene=40&methane=60&temp=28&hum=70')).json();
  assert.equal(json.track_key, 'pisang');
  assert.equal(json.change.significant, true);
  assert.ok(json.change.signals.length >= 2, JSON.stringify(json.change));
  assert.equal(json.change.status, 'memburuk');
  assert.ok(json.change.penalty > 0);
  assert.ok(json.food_health_score < json.food_health_score_static);
  assert.equal(json.risk_level, 'tinggi');
  assert.ok(json.risk_index >= 70);
  assert.ok(json.notes.some((n) => /dari baseline/.test(n)));
});

test('buah stabil dari waktu ke waktu: tidak signifikan', async () => {
  seed('apel', [[120, {}, 100, 'segar'], [90, {}, 100, 'segar'], [60, { co2: 460 }, 100, 'segar']]);
  answer('{"is_fruit":true,"name_id":"apel","name_en":"apple","condition":"segar","confidence":"tinggi","nutrition":"x"}');
  const json = await (await post(`?${Q}`)).json();
  assert.equal(json.change.significant, false);
  assert.equal(json.change.status, 'stabil');
  assert.equal(json.change.penalty, 0);
  assert.equal(json.risk_level, 'rendah');
});

test('data awal kurang: status belum cukup data, tidak menghukum skor', async () => {
  answer(FRESH);
  const json = await (await post(`?${Q}`)).json();
  assert.equal(json.change.status, 'belum cukup data');
  assert.equal(json.change.samples, 1);
  assert.equal(json.food_health_score, json.food_health_score_static);
});

test('bukan buah tidak masuk pelacakan', async () => {
  answer('{"is_fruit":false,"name_id":"","name_en":"","condition":"","confidence":"rendah","nutrition":""}');
  const json = await (await post(`?${Q}`)).json();
  assert.equal(json.track_key, null);
  assert.equal(json.change, null);
  assert.deepEqual(store.tracks(1e12), []);
});

test('?batch memisahkan pelacakan buah sejenis; nama tidak valid ditolak', async () => {
  answer(FRESH);
  assert.equal((await (await post(`?${Q}&batch=Pisang-Rak1`)).json()).track_key, 'pisang-rak1');
  assert.equal((await (await post(`?${Q}`)).json()).track_key, 'pisang');
  const bad = await post(`?${Q}&batch=${encodeURIComponent('a/b<script>')}`);
  assert.equal(bad.status, 400);
});

test('nama model berbeda-beda tetap satu pelacak (kanonik)', async () => {
  for (const nm of ['Pisang Ambon', 'pisang kepok', 'banana']) {
    answer(`{"is_fruit":true,"name_id":"${nm}","name_en":"","condition":"segar","confidence":"tinggi","nutrition":"x"}`);
    await (await post(`?${Q}`)).text();
  }
  assert.equal(store.tracks(1e12).length, 1);
  assert.equal(store.tracks(1e12)[0].items.length, 3);
});

test('/api/trend: daftar, detail, teks, tidak ada', async () => {
  seed('mangga', [[120, {}, 100, 'segar'], [100, {}, 100, 'segar'], [20, { ethylene: 30, methane: 50 }, 70, 'matang'], [10, { ethylene: 35, methane: 55 }, 65, 'matang']]);
  const list = await (await fetch(`${base}/api/trend`, { headers: H })).json();
  assert.equal(list.count, 1);
  assert.equal(list.items[0].key, 'mangga');
  assert.equal(list.items[0].significant, true);
  const d = await (await fetch(`${base}/api/trend?key=Mangga&limit=2`, { headers: H })).json();
  assert.equal(d.samples, 4);
  assert.equal(d.observations.length, 2);
  assert.ok(d.observations[0].at > d.observations[1].at);
  assert.equal(d.change.status, 'memburuk');
  const t = (await (await fetch(`${base}/api/trend?key=mangga&format=text`, { headers: H })).text()).split('|');
  assert.deepEqual(t.slice(0, 4), ['mangga', '4', 'memburuk', 'ya']);
  assert.equal((await fetch(`${base}/api/trend?key=durian`, { headers: H })).status, 404);
});

// --- Batas min/maks dari aplikasi + klasifikasi ---
test('/api/limits: bawaan, simpan sebagian (Indonesia/Inggris), teks, validasi', async () => {
  const get = await (await fetch(`${base}/api/limits`, { headers: H })).json();
  assert.deepEqual(get.limits.ethylene, { min: 5, max: 50 });
  const set = await fetch(`${base}/api/limits?etilen_min=2&etilen_maks=30&metana_min=1&metana_maks=20`, { method: 'POST', headers: H });
  const j = await set.json();
  assert.equal(set.status, 200);
  assert.deepEqual([j.limits.ethylene, j.limits.methane, j.limits.co2], [{ min: 2, max: 30 }, { min: 1, max: 20 }, { min: 800, max: 2500 }]);
  const body = await fetch(`${base}/api/limits?format=text`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ co2_min: 600, co2_max: 2000, metana: { min: 3, max: 80 } }) });
  assert.equal(await body.text(), 'OK|2|30|600|2000|3|80');
  assert.equal(await (await fetch(`${base}/api/limits?format=text`, { headers: H })).text(), 'OK|2|30|600|2000|3|80');
  for (const [qs, re] of [['etilen_min=abc', /Batas tidak valid: Etilen minimal/], ['co2_min=3000&co2_maks=100', /CO2: minimal/], ['foo=1', /Tidak ada nilai batas/], ['metana_maks=-5', /Metana maksimal/]]) {
    const r = await fetch(`${base}/api/limits?${qs}`, { method: 'POST', headers: H });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, re);
  }
  // gagal tidak mengubah nilai tersimpan
  assert.equal(await (await fetch(`${base}/api/limits?format=text`, { headers: H })).text(), 'OK|2|30|600|2000|3|80');
  assert.equal((await fetch(`${base}/api/limits`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/limits`, { method: 'DELETE', headers: H })).status, 405);
});

test('/api/setpoints: bawaan, simpan sebagian, teks dengan penanda custom, validasi, auth', async () => {
  const def = await (await fetch(`${base}/api/setpoints`, { headers: H })).json();
  assert.deepEqual(def.setpoints, { co2: 2500, methane: 100, ethylene: 50, temp: 25, hum: 85 });
  assert.equal(def.custom, false);
  assert.equal(await (await fetch(`${base}/api/setpoints?format=text`, { headers: H })).text(), 'OK|2500|100|50|25|85|0');
  const set = await fetch(`${base}/api/setpoints?co2=2000&suhu=22.5&kelembaban=80`, { method: 'POST', headers: H });
  assert.equal(set.status, 200);
  assert.equal(await (await fetch(`${base}/api/setpoints?format=text`, { headers: H })).text(), 'OK|2000|100|50|22.5|80|1');
  const body = await fetch(`${base}/api/setpoints?format=text`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ metana: 60, etilen: 20 }) });
  assert.equal(await body.text(), 'OK|2000|60|20|22.5|80|1');
  for (const qs of ['co2=abc', 'suhu=500', 'kelembaban=0', '']) {
    const r = await fetch(`${base}/api/setpoints?${qs}`, { method: 'POST', headers: H });
    assert.equal(r.status, 400, qs);
  }
  // gagal tidak mengubah nilai tersimpan
  assert.equal(await (await fetch(`${base}/api/setpoints?format=text`, { headers: H })).text(), 'OK|2000|60|20|22.5|80|1');
  const latest = await (await fetch(`${base}/api/latest`, { headers: H })).json();
  assert.equal(latest.setpoints.temp, 22.5);
  assert.equal((await fetch(`${base}/api/setpoints`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/setpoints`, { method: 'DELETE', headers: H })).status, 405);
});

test('klasifikasi sensor mengikuti batas dari aplikasi (/api/sensors dan /api/latest)', async () => {
  const send = () => fetch(`${base}/api/sensors?ethylene=40&co2=900&methane=20&temp=26&hum=60`, { method: 'POST', headers: H }).then((r) => r.json());
  assert.equal((await send()).klasifikasi, 'matang'); // batas bawaan
  await fetch(`${base}/api/limits?ethylene_min=1&ethylene_maks=30&co2_min=100&co2_maks=800`, { method: 'POST', headers: H });
  const j = await send();
  assert.equal(j.classification.gases.ethylene.status, 'tinggi');
  assert.equal(j.classification.gases.co2.status, 'tinggi');
  assert.equal(j.klasifikasi, 'busuk'); // dua gas >= maksimal
  const l = await (await fetch(`${base}/api/latest`, { headers: H })).json();
  assert.equal(l.sensors.classification.class, 'busuk');
  assert.equal(l.limits.ethylene.max, 30);
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.deepEqual(t.slice(12, 17).filter((x, i) => i !== 1), ['busuk', 'tinggi', 'tinggi', 'waspada']);
});

test('foto: model AI menerima data sensor + batas; klasifikasi akhir = lebih buruk antara visual dan sensor', async () => {
  await fetch(`${base}/api/limits?etilen_min=1&etilen_maks=30&co2_min=500&co2_maks=1000`, { method: 'POST', headers: H });
  answer(FRESH);
  const json = await (await post('?co2=1200&ethylene=35&methane=3&temp=26&hum=65')).json();
  const prompt = seen[0].body.messages[0].content.find((p) => p.type === 'text').text;
  assert.match(prompt, /Ethylene=35 \[1-30\]/);
  assert.match(prompt, /CO2=1200 \[500-1000\]/);
  assert.match(prompt, /alone: rotten/);
  assert.doesNotMatch(prompt, /Alcohol|Ethanol/i);
  assert.equal(json.condition, 'segar');
  assert.equal(json.classification.sensor, 'busuk');
  assert.equal(json.klasifikasi, 'busuk');
  assert.equal(json.risk_level, 'tinggi');
  assert.equal(await (await post('?format=full&co2=1200&ethylene=35&methane=3&temp=26&hum=65')).text().then((x) => x.split('|').length), 5);
});

test('format=full: Nama|Nutrisi|Klasifikasi|Skor|Risiko dan galat tetap ERR|', async () => {
  answer(FRESH);
  const t = (await (await post(`?format=full&${Q}`)).text()).split('|');
  assert.deepEqual([t[0], t[1], t[2], t[4]], ['Pisang', 'Kaya kalium & energi', 'segar', 'rendah']);
  assert.match(t[3], /^\d+$/);
  const bad = await post('?format=full&co2=abc');
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /^ERR\|/);
});

// --- Proses nyata, seperti di Render ---
const root = path.join(__dirname, '..');
function run(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env: { PATH: process.env.PATH, PORT: String(port), NVIDIA_API_KEY: '', SHARED_SECRET: '', NVIDIA_VISION_MODEL: '', ...env }  // '' menang atas .env lokal, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let exited = null;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => { exited = code; });
  return { child, port, output: () => out, exited: () => exited };
}
async function waitHealth(p) {
  for (let i = 0; i < 40 && p.exited() === null; i++) {
    try { return (await fetch(`http://127.0.0.1:${p.port}/health`)).status; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  return 0;
}

test('proses nyata: hidup dengan NVIDIA_API_KEY + SHARED_SECRET saja (seperti Render)', async () => {
  const p = run({ HOST: '0.0.0.0', SHARED_SECRET: 's3cret', NVIDIA_API_KEY: 'nvapi-x' });
  try {
    assert.equal(await waitHealth(p), 200, p.output());
    assert.equal((await fetch(`http://127.0.0.1:${p.port}/api/fruit`, { method: 'POST', body: JPEG })).status, 401);
    assert.match(p.output(), /penyedia=nvidia/);
  } finally { p.child.kill(); }
});

test('proses nyata: berhenti dengan pesan jelas bila NVIDIA_API_KEY kosong', async () => {
  const p = run({ HOST: '0.0.0.0', SHARED_SECRET: 's3cret' });
  await new Promise((r) => p.child.on('exit', r));
  assert.equal(p.exited(), 1);
  assert.match(p.output(), /FATAL: NVIDIA_API_KEY belum diisi/);
});

test('proses nyata: HOST publik tanpa SHARED_SECRET ditolak; loopback boleh', async () => {
  const bad = run({ HOST: '0.0.0.0', NVIDIA_API_KEY: 'nvapi-x' });
  await new Promise((r) => bad.child.on('exit', r));
  assert.equal(bad.exited(), 1);
  assert.match(bad.output(), /SHARED_SECRET wajib/);
  const ok = run({ HOST: '127.0.0.1', NVIDIA_API_KEY: 'nvapi-x' });
  try { assert.equal(await waitHealth(ok), 200, ok.output()); } finally { ok.child.kill(); }
});

test('/api/latest teks: foto bukan buah -> kolom nutrisi kosong tetap "-" (jumlah kolom tetap 25)', async () => {
  store.reset();
  answer('{"is_fruit":false,"name_id":"","name_en":"","condition":"","confidence":"low","nutrition":""}');
  await (await post(`?${Q}`)).text();
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.equal(t.length, 24);
  assert.equal(t[0], 'Bukan buah');
  assert.ok(t.every((x) => x !== ''), 'tidak boleh ada kolom kosong');
});

test('/api/latest teks: kolom 23-25 = kondisi terburuk, status Peltier dan kipas dari Central Unit', async () => {
  store.reset();
  // hanya sensor (segar menurut gas) + Peltier ON, kipas OFF
  await (await fetch(`${base}/api/sensors?${Q}&peltier=1&fan=0`, { method: 'POST', headers: H })).text();
  let t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.equal(t.length, 24);
  assert.deepEqual(t.slice(20, 23), ['segar', 'ON', 'OFF']);
  // foto busuk -> kondisi menjadi busuk walau sensor segar; aktuator terbaru dibawa foto (sensor inline)
  answer(ROT);
  await (await post(`?${Q}&peltier=0&fan=1`)).text();
  t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.deepEqual(t.slice(20, 23), ['busuk', 'OFF', 'ON']);
  // sensor baru tanpa parameter aktuator -> status aktuator tidak diketahui ('-'), bukan nilai lama
  await (await fetch(`${base}/api/sensors?${Q}`, { method: 'POST', headers: H })).text();
  t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.deepEqual(t.slice(21, 23), ['-', '-']);
  // nilai aktuator tak dikenal diabaikan (tidak membuat permintaan gagal)
  const r = await fetch(`${base}/api/sensors?format=text&${Q}&peltier=mungkin`, { method: 'POST', headers: H });
  assert.equal(r.status, 200);
});

test('/api/latest teks: nilai sensor di dashboard mengikuti pembacaan TERBARU, bukan cuplikan saat foto', async () => {
  store.reset();
  answer('{"is_fruit":true,"name_id":"apel","name_en":"apple","condition":"segar","confidence":"tinggi","nutrition":"x"}');
  await (await post(`?${Q}`)).text();                       // foto dengan sensor Q
  const baru = 'co2=1234&ethylene=22&methane=33&temp=28.5&hum=71';
  await (await fetch(`${base}/api/sensors?format=text&${baru}`, { method: 'POST', headers: H })).text();
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.deepEqual(t.slice(5, 10), ['1234', '22', '33', '28.5', '71']);   // co2, etilen, metana, suhu, kelembapan
});

test('/docs dan /openapi.json publik (tanpa kunci), tanpa membocorkan rahasia', async () => {
  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.ok(html.includes('swagger-ui') && html.includes('/openapi.json'));
  assert.equal((await fetch(`${base}/docs/`)).status, 200);

  const res = await fetch(`${base}/openapi.json`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(KEY) && !text.includes(SECRET));
  const spec = JSON.parse(text);
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.info.description.includes('meta/llama-3.2-11b-vision-instruct'));
  assert.ok(spec.info.description.includes('lib/store.js'));
  for (const p of ['/health', '/api/fruit', '/api/sensors', '/api/limits', '/api/setpoints', '/api/latest', '/api/history', '/api/trend']) {
    assert.ok(spec.paths[p], `path ${p} ada di spesifikasi`);
  }
  assert.deepEqual(spec.paths['/health'].get.security, []);
  assert.ok(spec.components.securitySchemes.ApiKeyAuth);
  assert.equal((await fetch(`${base}/docs`, { method: 'POST' })).status, 404);
});

test('spesifikasi mengikuti NVIDIA_VISION_MODEL dan setiap rute server terdaftar', async () => {
  const { buildSpec } = require('../lib/docs');
  assert.ok(buildSpec({ NVIDIA_VISION_MODEL: 'foo/bar-vision' }).info.description.includes('foo/bar-vision'));
  const spec = buildSpec();
  for (const [p, item] of Object.entries(spec.paths)) {
    if (p === '/health') continue;
    for (const op of Object.values(item)) assert.ok(op.security.length > 0, `${p} wajib kunci`);
  }
});

test('konsistensi: setiap path /api yang dipakai ESP32, README, dokumen, dan skrip ada di spesifikasi, dan sebaliknya', async () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const { buildSpec } = require('../lib/docs');
  const specPaths = new Set(Object.keys(buildSpec().paths));
  const files = ['esp32/central_unit/central_unit.ino', 'esp32/README.md', 'README.md', 'DEPLOY_RENDER.md', 'docs/APP_INVENTOR.md', 'docs/TERMUX.md', 'scripts/doctor.js'];
  const used = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/(\/api\/[a-z]+|\/health)\b/g)) {
      used.add(m[1]);
      assert.ok(specPaths.has(m[1]), `${f} memakai ${m[1]} yang tidak ada di spesifikasi`);
    }
  }
  // rute di server.js (objek ROUTES) harus persis sama dengan path /api di spesifikasi
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routes = new Set([...src.matchAll(/^\s+'(\/api\/[a-z]+)':/gm)].map((m) => m[1]));
  assert.deepEqual([...routes].sort(), [...specPaths].filter((p) => p.startsWith('/api/')).sort());
  // metode di spesifikasi = metode yang diterima server (bukan 404/405)
  const spec = buildSpec();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (p === '/health') continue;
      const r = await fetch(`${base}${p}`, { method: method.toUpperCase(), headers: { 'x-api-key': SECRET } });
      assert.notEqual(r.status, 405, `${method} ${p} ditolak server (405)`);
      if (p !== '/api/trend' && p !== '/api/image') assert.notEqual(r.status, 404, `${method} ${p} tidak ada (404)`); // /api/trend?key= dan /api/image memang 404 bila belum ada data/foto
    }
  }
  // nama parameter sensor di ESP32 = nama di spesifikasi
  const ino = fs.readFileSync(path.join(root, 'esp32/central_unit/central_unit.ino'), 'utf8');
  const q = ino.match(/"(co2=%[^"]+)"/)[1].split('&').map((x) => x.split('=')[0]);
  const names = spec.paths['/api/sensors'].post.parameters.map((p) => p.name);
  for (const k of q) assert.ok(names.includes(k), `parameter ESP32 ${k} tidak ada di spesifikasi /api/sensors`);
  // contoh balasan di dokumen App Inventor = balasan server sungguhan
  const r = await fetch(`${base}/api/sensors?format=text&co2=1500&ethylene=30&methane=40&temp=27.5&hum=66`, { method: 'POST', headers: { 'x-api-key': SECRET } });
  const doc = fs.readFileSync(path.join(root, 'docs/APP_INVENTOR.md'), 'utf8');
  assert.ok(doc.includes(await r.text()), 'contoh OK|skor|risiko|kelas di APP_INVENTOR.md tidak sama dengan balasan server');
});

test('/api/image: 404 sebelum ada foto; sesudah POST /api/fruit mengembalikan JPEG yang sama', async () => {
  store.reset();
  const none = await fetch(`${base}/api/image`, { headers: H });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).ok, false);
  answer(ROT);
  assert.equal((await post(`?${Q}`)).status, 200);
  const r = await fetch(`${base}/api/image`, { headers: H });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(Number(r.headers.get('x-image-id')) > 0);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
});

test('/api/image: kunci lewat ?key= diterima (komponen Image App Inventor), kunci salah/kosong 401', async () => {
  answer(ROT);
  await (await post(`?${Q}`)).text();
  assert.equal((await fetch(`${base}/api/image?key=${SECRET}&v=1`)).status, 200);
  assert.equal((await fetch(`${base}/api/image?key=salah`)).status, 401);
  assert.equal((await fetch(`${base}/api/image`)).status, 401);
  // ?key= HANYA berlaku untuk /api/image, bukan endpoint lain
  assert.equal((await fetch(`${base}/api/latest?key=${SECRET}`)).status, 401);
});

test('foto tetap tersimpan walau analisis AI gagal; id foto muncul di /api/latest (JSON dan kolom 24)', async () => {
  store.reset();
  reply = () => ({ status: 500, body: { error: 'x' } });
  const bad = await post(`?${Q}`);
  assert.ok(bad.status >= 400);
  assert.equal((await fetch(`${base}/api/image`, { headers: H })).status, 200);
  const l = await (await fetch(`${base}/api/latest`, { headers: H })).json();
  assert.equal(l.image.mime, 'image/jpeg');
  assert.equal(l.image.bytes, JPEG.length);
  const t = (await (await fetch(`${base}/api/latest?format=text`, { headers: H })).text()).split('|');
  assert.equal(t.length, 24);
  assert.equal(t[23], String(l.image.id));
});
