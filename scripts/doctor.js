#!/usr/bin/env node
'use strict';
/**
 * Cek konfigurasi tanpa menjalankan server.
 *   node scripts/doctor.js                 cek env saja (offline)
 *   node scripts/doctor.js --live          + validasi key NVIDIA dan keberadaan model
 *   node scripts/doctor.js --image a.jpg   + kenali satu foto lewat NVIDIA (jalur sama dengan server)
 *   node scripts/doctor.js --local         + uji server yang SEDANG berjalan (/health dan /api/latest dengan SHARED_SECRET)
 */
const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('../lib/env');
loadDotEnv(path.join(__dirname, '..', '.env'));

const nvidia = require('../lib/nvidia');
const fruit = require('../lib/fruit');
const { configProblems, lanAddresses } = require('../server');

const args = process.argv.slice(2);
const imageIdx = args.indexOf('--image');
const imagePath = imageIdx >= 0 ? args[imageIdx + 1] : null;
const live = args.includes('--live') || Boolean(imagePath);

const mask = (s) => (s ? `${s.slice(0, 6)}…(${s.length} karakter)` : '(kosong)');
let failed = false;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => { failed = true; console.log(`  GAGAL ${m}`); };

(async () => {
  const cfg = nvidia.config();
  console.log('Konfigurasi');
  console.log(`  penyedia       : nvidia`);
  console.log(`  NVIDIA_API_KEY : ${mask(cfg.key)}`);
  console.log(`  model          : ${cfg.model}`);
  console.log(`  base URL       : ${cfg.base}`);
  console.log(`  SHARED_SECRET  : ${process.env.SHARED_SECRET ? 'terisi' : '(kosong)'}`);
  console.log('Pemeriksaan');
  const problems = configProblems();
  if (problems.length) problems.forEach(bad); else ok('env wajib lengkap');
  if (cfg.key && cfg.key.length < 20) bad('NVIDIA_API_KEY terlalu pendek: kemungkinan hanya \"nvapi-\" tanpa isi. Salin key lengkap dari build.nvidia.com');
  if (cfg.key && !cfg.key.startsWith('nvapi-')) bad('NVIDIA_API_KEY biasanya berawalan "nvapi-"; cek lagi salinannya');

  if (args.includes('--local')) {
    const port = process.env.PORT || 9655;
    const base = `http://127.0.0.1:${port}`;
    try {
      const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      h.ok ? ok(`${base}/health -> ${h.status}`) : bad(`${base}/health -> ${h.status}`);
      const l = await fetch(`${base}/api/latest?format=text`, { headers: { 'x-api-key': process.env.SHARED_SECRET || '' }, signal: AbortSignal.timeout(5000) });
      l.ok ? ok(`/api/latest dengan SHARED_SECRET -> ${l.status}`) : bad(`/api/latest -> ${l.status} (401 = SHARED_SECRET tidak cocok)`);
    } catch (e) { bad(`server tidak menjawab di ${base}: ${e.cause?.code || e.message} (jalankan npm run termux di sesi lain)`); }
    const ips = lanAddresses();
    console.log(`  info  alamat jaringan: ${ips.length ? ips.join(', ') : '(tidak terbaca di proot; lihat gateway di Serial Monitor ESP32)'}`);
  }

  if (live && cfg.key) {
    try {
      const res = await fetch(`${cfg.base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(20000) });
      if (res.status === 401 || res.status === 403) bad('key NVIDIA ditolak');
      else if (!res.ok) bad(`GET /models -> HTTP ${res.status}`);
      else {
        ok('key NVIDIA diterima');
        const ids = ((await res.json().catch(() => ({}))).data || []).map((m) => m.id);
        if (ids.length && !ids.includes(cfg.model)) bad(`model ${cfg.model} tidak ada di daftar akun ini; ganti NVIDIA_VISION_MODEL`);
        else if (ids.length) ok(`model ${cfg.model} tersedia`);
      }
    } catch (e) { bad(`tidak bisa menghubungi NVIDIA: ${e.cause?.code || e.message}`); }
  }

  if (imagePath && cfg.key) {
    try {
      const buf = fs.readFileSync(imagePath);
      const mime = fruit.detectMime(buf);
      if (!mime) throw new Error('berkas bukan JPEG/PNG');
      const t = Date.now();
      const answer = await nvidia.ask(`data:${mime};base64,${buf.toString('base64')}`, fruit.PROMPT);
      const parsed = fruit.extractJson(answer);
      if (!parsed) throw new Error(`jawaban tidak bisa dibaca: ${String(answer).slice(0, 100)}`);
      const r = fruit.buildResult(parsed);
      ok(`${fruit.toText(r)}  (${Date.now() - t} ms, ${buf.length} byte)`);
    } catch (e) { bad(`uji foto: ${e.message}`); }
  }
  process.exit(failed ? 1 : 0);
})();
