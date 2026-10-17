// Unit test lib/fruit.js (tanpa jaringan).
const test = require('node:test');
const assert = require('node:assert/strict');
const fruit = require('../lib/fruit');

test('detectMime mengenali JPEG dan PNG, menolak lainnya', () => {
  assert.equal(fruit.detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(fruit.detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(fruit.detectMime(Buffer.from('halo dunia')), null);
  assert.equal(fruit.detectMime(Buffer.alloc(0)), null);
});

test('extractJson: markdown, teks tambahan, dan sampah', () => {
  assert.deepEqual(fruit.extractJson('Ini:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(fruit.extractJson('tidak ada json'), null);
  assert.equal(fruit.extractJson('{rusak'), null);
  assert.equal(fruit.extractJson(null), null);
});

test('buildResult: nutrisi kurasi menang atas teks model, nama Inggris dikenali', () => {
  const r = fruit.buildResult({ is_fruit: true, name_id: 'jeruk', name_en: 'orange', confidence: 'tinggi', nutrition: 'manis' });
  assert.equal(r.line1, 'Jeruk');
  assert.equal(r.line2, 'Tinggi vitamin C');
  const en = fruit.buildResult({ is_fruit: true, name_id: 'buah kuning', name_en: 'banana', confidence: 'x', nutrition: 'x' });
  assert.equal(en.nutrition, 'Kaya kalium & energi');
  assert.equal(en.confidence, 'sedang');
});

test('buildResult: buah di luar tabel memakai nutrisi dari model; kosong -> teks bawaan', () => {
  assert.equal(fruit.buildResult({ is_fruit: 'true', name_id: 'rambutan', nutrition: 'Vitamin C & zat besi' }).nutrition, 'Vitamin C & zat besi');
  assert.equal(fruit.buildResult({ is_fruit: true, name_id: 'rambutan' }).nutrition, 'Data nutrisi tidak tersedia');
});

test('buildResult: bukan buah / nama kosong', () => {
  assert.equal(fruit.buildResult({ is_fruit: false, name_id: '' }).line1, 'Bukan buah');
  assert.equal(fruit.buildResult({ is_fruit: true, name_id: '  ' }).is_fruit, false);
  assert.equal(fruit.buildResult(null).line1, 'Bukan buah');
});

test('buildResult memotong nama dan nutrisi panjang (layar kecil)', () => {
  const r = fruit.buildResult({ is_fruit: true, name_id: 'a'.repeat(60), nutrition: 'b'.repeat(80) });
  assert.ok(r.fruit.length <= 24);
  assert.ok(r.nutrition.length <= 32);
});

test('toText', () => {
  assert.equal(fruit.toText({ ok: true, line1: 'Apel', line2: 'Serat & vitamin C' }), 'Apel|Serat & vitamin C');
  assert.equal(fruit.toText({ ok: false, error: 'x'.repeat(100) }).length, 'ERR|'.length + 60);
});
