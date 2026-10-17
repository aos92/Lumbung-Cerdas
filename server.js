#!/usr/bin/env node
'use strict';
/**
 * fruit-nvidia-api: backend kecil untuk ESP32-CAM pengenal buah.
 * Satu jalur saja: gambar -> NVIDIA Build (model vision) -> "Nama|Nutrisi".
 *
 *   GET  /health        publik, untuk health check Render
 *   POST /api/fruit     body JPEG/PNG mentah (atau JSON {"image":"<base64>","sensors":{...}}), header x-api-key
 *                       WAJIB enam sensor: co2, ammonia (amonia), alcohol, methane, temp, hum (query/JSON, atau dari
 *                       /api/sensors yang masih baru). Opsional ?batch=<id> untuk memisahkan pelacakan buah sejenis.
 *                       ?format=text -> "Nama|Nutrisi"; ?format=full -> "Nama|Nutrisi|Klasifikasi|Skor|Risiko" (default JSON)
 *   POST /api/sensors   JSON/query berisi nilai sensor (dari Central Unit / node sensor); opsional peltier=0|1&fan=0|1
 *   GET|POST /api/limits  rentang min/maks alkohol, co2, metana, amonia dari textbox App Inventor
 *                       (POST ?alkohol_min=5&alkohol_maks=50&co2_min=...; ?format=text)
 *   GET|POST /api/setpoints  5 setpoint kontrol (co2, metana, alkohol, suhu, kelembaban) dari App Inventor; diambil Central Unit
 *                       (POST ?co2=2500&metana=100&alkohol=50&suhu=25&kelembaban=85; ?format=text -> OK|co2|metana|alkohol|suhu|kelembaban|0/1)
 *   GET  /api/latest    hasil + sensor terakhir (untuk MIT App Inventor); ?format=text (25 kolom, lihat docs/APP_INVENTOR.md)
 *   GET  /api/history   riwayat; ?type=results|sensors&limit=20
 *   GET  /api/trend     analisis perubahan per jenis buah/batch; ?key=pisang&limit=50 ; ?format=text
 *   GET  /docs          dokumentasi Swagger UI (publik): struktur backend, model AI, semua endpoint + uji langsung
 *   GET  /openapi.json  spesifikasi OpenAPI 3 (publik)
 * Semua selain /health, /docs, /openapi.json butuh header x-api-key (atau Authorization: Bearer).
 */

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadDotEnv } = require('./lib/env');
const fruit = require('./lib/fruit');
const nvidia = require('./lib/nvidia');
const { parseSensors, assess, missingKeys, KEYS: SENSOR_KEYS } = require('./lib/assess');
const { classifySensors, combine, statusList } = require('./lib/classify');
const limitsLib = require('./lib/limits');
const setpointsLib = require('./lib/setpoints');
const trend = require('./lib/trend');
const store = require('./lib/store');
const docs = require('./lib/docs');

loadDotEnv(path.join(__dirname, '.env'));

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES) > 0 ? Number(process.env.MAX_IMAGE_BYTES) : 3 * 1024 * 1024;

function isLoopback(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(h);
}

function sharedSecret(env = process.env) {
    return String(env.SHARED_SECRET || '').trim();
}

function keyMatches(supplied, expected) {
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Kunci boleh lewat header `x-api-key: <kunci>` (sketch ESP32) atau `Authorization: Bearer <kunci>`.
function isAuthorized(headers, expected) {
    if (!expected) return true; // hanya terjadi di mode lokal (HOST loopback); startup menolak selain itu
    const auth = headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && keyMatches(auth.slice(7), expected)) return true;
    return keyMatches(headers['x-api-key'], expected);
}

/** Cek konfigurasi wajib. Kembalikan daftar masalah (kosong = siap). */
function configProblems(env = process.env) {
    const problems = [];
    if (!String(env.NVIDIA_API_KEY || '').trim()) problems.push('NVIDIA_API_KEY belum diisi (buat di https://build.nvidia.com/settings/api-keys)');
    if (!sharedSecret(env) && !isLoopback(env.HOST || '127.0.0.1')) problems.push('SHARED_SECRET wajib diisi bila HOST bukan loopback');
    return problems;
}

function send(res, status, result, asText) {
    const isText = asText;
    const body = isText ? (asText === 'full' ? fruit.toFullText(result) : fruit.toText(result)) : JSON.stringify(result);
    res.writeHead(status, {
        'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req, limit, label = 'Gambar') {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c) => {
            if (tooLarge) return; // jangan putus socket: balasan 413 harus tetap terkirim
            size += c.length;
            if (size > limit) { tooLarge = true; chunks.length = 0; return; }
            chunks.push(c);
        });
        req.on('end', () => (tooLarge
            ? reject(Object.assign(new Error(`${label} terlalu besar`), { status: 413 }))
            : resolve(Buffer.concat(chunks))));
        req.on('error', reject);
    });
}

async function handleFruit(req, res, url) {
    const fmt = url.searchParams.get('format');
    const asText = fmt === 'full' ? 'full' : fmt === 'text';
    try {
        const raw = await readBody(req, Math.ceil(MAX_IMAGE_BYTES * 1.4));
        let image = raw;
        const sensorSrc = Object.fromEntries(url.searchParams);
        if (String(req.headers['content-type'] || '').includes('application/json')) {
            let json;
            try { json = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'JSON tidak valid' }, asText); }
            image = Buffer.from(String(json?.image || '').replace(/^data:[^,]+,/, ''), 'base64');
            Object.assign(sensorSrc, json && typeof json === 'object' ? json : {}, json?.sensors && typeof json.sensors === 'object' ? json.sensors : {});
        }
        const parsedSensors = parseSensors(sensorSrc);
        if (parsedSensors.error) return send(res, 400, { ok: false, error: parsedSensors.error }, asText);
        if (image.length === 0) return send(res, 400, { ok: false, error: 'Gambar kosong' }, asText);
        if (image.length > MAX_IMAGE_BYTES) return send(res, 413, { ok: false, error: 'Gambar terlalu besar' }, asText);
        const mime = fruit.detectMime(image);
        if (!mime) return send(res, 400, { ok: false, error: 'Format harus JPEG/PNG' }, asText);

        let sensors = parsedSensors.values;
        let source = 'inline';
        if (Object.keys(sensors).length === 0) {
            const stored = store.freshSensors(sensorMaxAgeS());
            if (!stored) return send(res, 400, { ok: false, error: `Data sensor wajib (${SENSOR_KEYS.join(', ')}): kirim bersama foto atau POST /api/sensors lebih dulu` }, asText);
            sensors = stored.values;
            source = 'stored';
        }
        const lack = missingKeys(sensors);
        if (lack.length) return send(res, 400, { ok: false, error: `Data sensor tidak lengkap, kurang: ${lack.join(', ')}` }, asText);
        const batchRaw = sensorSrc.batch === undefined ? '' : String(sensorSrc.batch).trim();
        if (batchRaw && !/^[\w .-]{1,40}$/.test(batchRaw)) return send(res, 400, { ok: false, error: 'batch hanya huruf/angka/spasi/.-_ maksimal 40 karakter' }, asText);
        const batch = batchRaw.toLowerCase();
        if (source === 'inline') store.saveSensors(sensors, Date.now(), parseActuators(sensorSrc));

        const limits = store.getLimits();
        const sensorCls = classifySensors(sensors, limits);
        const startedAt = Date.now();
        const answer = await nvidia.ask(`data:${mime};base64,${image.toString('base64')}`, fruit.buildPrompt(sensors, limits, sensorCls.class));
        const parsed = fruit.extractJson(answer);
        if (!parsed) {
            console.error(`[fruit] jawaban tidak bisa dibaca: ${String(answer).slice(0, 120)}`);
            return send(res, 502, { ok: false, error: 'Jawaban model tidak bisa dibaca' }, asText);
        }
        const result = fruit.buildResult(parsed);

        const visual = result.is_fruit ? result.condition : null;
        let verdict = assess({ condition: visual, sensors, limits });
        let change = null;
        result.track_key = null;
        if (result.is_fruit) {
            const key = batch || fruit.canonicalName(result.fruit, result.fruit_en);
            const ts = Date.now();
            const obs = { ts, sensors, score: verdict.food_health_score, condition: result.condition };
            change = trend.analyze([...store.series(key, trackWindowMs(), ts), obs]);
            verdict = trend.applyChange(verdict, change);
            store.addObservation(key, { sensors, score: obs.score, condition: obs.condition }, ts);
            result.track_key = key;
        }
        const final = combine(visual, sensorCls.class);
        const classification = { final, sensor: sensorCls.class, visual, index: sensorCls.index, gases: sensorCls.gases };
        Object.assign(result, verdict, { sensors, sensors_source: source, change, klasifikasi: final, classification, limits });
        store.saveResult(result);
        console.log(`[fruit] ${nvidia.config().model} ${Date.now() - startedAt}ms ${image.length}B -> ${result.line1} klas=${final} skor=${verdict.food_health_score} risiko=${verdict.risk_level} tren=${change ? change.status : '-'} sensor=${source}`);
        return send(res, 200, result, asText);
    } catch (err) {
        const status = err.status >= 400 && err.status < 600 ? err.status : 502;
        console.error(`[fruit] gagal (${status}): ${err.message}`);
        if (!res.headersSent) send(res, status, { ok: false, error: err.message || 'Gagal memproses' }, asText);
    }
}

// Status aktuator opsional dari Central Unit: peltier=1&fan=0 (alias kipas). Nilai tak dikenal diabaikan, bukan error.
function parseActuators(src) {
    const flag = (v) => {
        const s = String(v).trim().toLowerCase();
        if (['1', 'true', 'on', 'ya'].includes(s)) return 1;
        if (['0', 'false', 'off', 'tidak'].includes(s)) return 0;
        return undefined;
    };
    const out = {};
    const peltier = flag(src && src.peltier !== undefined ? src.peltier : '');
    const fan = flag(src && src.fan !== undefined ? src.fan : (src && src.kipas !== undefined ? src.kipas : ''));
    if (peltier !== undefined) out.peltier = peltier;
    if (fan !== undefined) out.fan = fan;
    return Object.keys(out).length ? out : null;
}

function sensorMaxAgeS() {
    return Number(process.env.SENSOR_MAX_AGE_S) > 0 ? Number(process.env.SENSOR_MAX_AGE_S) : 600;
}

function trackWindowMs() {
    return (Number(process.env.TREND_WINDOW_H) > 0 ? Number(process.env.TREND_WINDOW_H) : 72) * 3600000;
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}
function sendPlain(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}
const dash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));

async function handleSensors(req, res, url) {
    const asText = url.searchParams.get('format') === 'text';
    const fail = (status, error) => (asText ? sendPlain(res, status, `ERR|${error}`) : sendJson(res, status, { ok: false, error }));
    try {
        const raw = await readBody(req, 8192, 'Data sensor');
        const src = Object.fromEntries(url.searchParams);
        if (raw.length) {
            let json;
            try { json = JSON.parse(raw.toString('utf8')); } catch { return fail(400, 'JSON tidak valid'); }
            Object.assign(src, json && typeof json === 'object' ? json : {}, json?.sensors && typeof json.sensors === 'object' ? json.sensors : {});
        }
        const { values, error } = parseSensors(src);
        if (error) return fail(400, error);
        const lack = missingKeys(values);
        if (lack.length) return fail(400, `Data sensor wajib lengkap, kurang: ${lack.join(', ')}`);
        const act = parseActuators(src);
        store.saveSensors(values, Date.now(), act);
        const limits = store.getLimits();
        const verdict = assess({ sensors: values, limits });
        const cls = classifySensors(values, limits);
        if (asText) return sendPlain(res, 200, `OK|${dash(verdict.food_health_score)}|${verdict.risk_level}|${dash(cls.class)}`);
        return sendJson(res, 200, { ok: true, sensors: values, ...(act ? { act } : {}), ...verdict, klasifikasi: cls.class, classification: cls });
    } catch (err) {
        fail(err.status >= 400 && err.status < 600 ? err.status : 500, err.message || 'Gagal memproses');
    }
}

const onOff = (v) => (v === undefined || v === null ? undefined : (v ? 'ON' : 'OFF'));

function latestText(l, limits) {
    const act = l.sensors && l.sensors.act;
    // Nilai di dashboard = pembacaan sensor TERBARU (tiap 10 dtk); cuplikan saat foto hanya cadangan bila belum ada pembacaan.
    const r = l.result; const s = (l.sensors && l.sensors.values) || (r && r.sensors) || {};
    const verdict = r || (l.sensors ? assess({ sensors: l.sensors.values, limits }) : {});
    // Klasifikasi sensor selalu dari pembacaan sensor TERBARU terhadap rentang min/maks saat ini.
    const cls = classifySensors((l.sensors && l.sensors.values) || s, limits);
    return [r ? r.fruit || 'Bukan buah' : '-', r ? r.nutrition : '-', verdict.food_health_score, verdict.risk_level, verdict.risk_index,
        s.co2, s.ammonia, s.alcohol, s.methane, s.temp, s.hum,
        r && r.change ? r.change.status : undefined,
        r && r.change ? (r.change.significant ? 'ya' : 'tidak') : undefined,
        cls.class, cls.index, ...statusList(cls), r ? r.klasifikasi : undefined,
        l.sensors ? l.sensors.age_s : undefined, r ? r.age_s : undefined,
        // 23 kondisi buah (terburuk antara foto terakhir dan sensor terkini), 24 Peltier, 25 kipas
        combine(r ? r.klasifikasi : null, cls.class), onOff(act && act.peltier), onOff(act && act.fan)].map(dash).join('|');
}

function handleLatest(res, url) {
    const l = store.latest();
    const limits = store.getLimits();
    if (url.searchParams.get('format') === 'text') return sendPlain(res, 200, latestText(l, limits));
    if (l.sensors) {
        l.sensors.assessment = assess({ sensors: l.sensors.values, limits });
        l.sensors.classification = classifySensors(l.sensors.values, limits);
    }
    return sendJson(res, 200, { ok: true, server_time: new Date().toISOString(), limits, setpoints: store.getSetpoints().values, ...l });
}

async function handleLimits(req, res, url) {
    const asText = url.searchParams.get('format') === 'text';
    const fail = (status, error) => (asText ? sendPlain(res, status, `ERR|${error}`) : sendJson(res, status, { ok: false, error }));
    const reply = (limits) => (asText ? sendPlain(res, 200, `OK|${limitsLib.toText(limits)}`) : sendJson(res, 200, { ok: true, limits }));
    try {
        if (req.method === 'GET') return reply(store.getLimits());
        const raw = await readBody(req, 8192, 'Data batas');
        const src = Object.fromEntries(url.searchParams);
        if (raw.length) {
            let json;
            try { json = JSON.parse(raw.toString('utf8')); } catch { return fail(400, 'JSON tidak valid'); }
            Object.assign(src, json && typeof json === 'object' ? json : {});
        }
        const { provided, error } = limitsLib.parseLimits(src);
        if (error) return fail(400, error);
        if (!Object.keys(provided).length) return fail(400, 'Tidak ada nilai batas (alkohol_min, alkohol_maks, co2_min, co2_maks, metana_min, metana_maks, amonia_min, amonia_maks)');
        const merged = limitsLib.mergeLimits(store.getLimits(), provided);
        if (merged.error) return fail(400, merged.error);
        return reply(store.saveLimits(merged.limits));
    } catch (err) {
        fail(err.status >= 400 && err.status < 600 ? err.status : 500, err.message || 'Gagal memproses');
    }
}

async function handleSetpoints(req, res, url) {
    const asText = url.searchParams.get('format') === 'text';
    const fail = (status, error) => (asText ? sendPlain(res, status, `ERR|${error}`) : sendJson(res, status, { ok: false, error }));
    // Kolom terakhir teks: 1 = setpoint diisi dari aplikasi, 0 = masih bawaan (Central Unit tidak menimpa nilai tersimpannya dengan bawaan).
    const reply = (sp) => (asText ? sendPlain(res, 200, `OK|${setpointsLib.toText(sp.values)}|${sp.custom ? 1 : 0}`)
        : sendJson(res, 200, { ok: true, setpoints: sp.values, custom: sp.custom }));
    try {
        if (req.method === 'GET') return reply(store.getSetpoints());
        const raw = await readBody(req, 8192, 'Data setpoint');
        const src = Object.fromEntries(url.searchParams);
        if (raw.length) {
            let json;
            try { json = JSON.parse(raw.toString('utf8')); } catch { return fail(400, 'JSON tidak valid'); }
            Object.assign(src, json && typeof json === 'object' ? json : {});
        }
        const { provided, error } = setpointsLib.parseSetpoints(src);
        if (error) return fail(400, error);
        if (!Object.keys(provided).length) return fail(400, 'Tidak ada setpoint (co2, metana, alkohol, suhu, kelembaban)');
        return reply(store.saveSetpoints(provided));
    } catch (err) {
        fail(err.status >= 400 && err.status < 600 ? err.status : 500, err.message || 'Gagal memproses');
    }
}

function handleHistory(res, url) {
    const kind = url.searchParams.get('type') === 'sensors' ? 'sensors' : 'results';
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 20));
    const items = store.history(kind, limit);
    return sendJson(res, 200, { ok: true, type: kind, count: items.length, items });
}

function handleTrend(res, url) {
    const text = url.searchParams.get('format') === 'text';
    const key = (url.searchParams.get('key') || '').trim().toLowerCase();
    const win = trackWindowMs();
    const toObs = (o) => ({ at: new Date(o.ts).toISOString(), condition: o.condition, score: o.score, sensors: o.sensors });
    if (!key) {
        const items = store.tracks(win).map(({ key: k, items: it }) => {
            const last = it[it.length - 1];
            const change = trend.analyze(it);
            return { key: k, samples: it.length, first_at: new Date(it[0].ts).toISOString(), last_at: new Date(last.ts).toISOString(), last_score: last.score, status: change.status, significant: change.significant };
        });
        if (text) return sendPlain(res, 200, items.map((i) => [i.key, i.samples, i.status, i.significant ? 'ya' : 'tidak', i.last_score].map(dash).join('|')).join('\n'));
        return sendJson(res, 200, { ok: true, count: items.length, items });
    }
    const it = store.series(key, win);
    if (!it.length) return text ? sendPlain(res, 404, 'ERR|Belum ada data untuk pelacak ini') : sendJson(res, 404, { ok: false, error: `Belum ada data untuk "${key}"` });
    const change = trend.analyze(it);
    if (text) return sendPlain(res, 200, [key, it.length, change.status, change.significant ? 'ya' : 'tidak', it[0].score, it[it.length - 1].score, change.score_per_hour].map(dash).join('|'));
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 50));
    return sendJson(res, 200, { ok: true, key, samples: it.length, change, observations: it.slice(-limit).reverse().map(toObs) });
}

// Alamat IPv4 perangkat ini. Di proot Debian/Android 11+ os.networkInterfaces() bisa melempar error (EACCES): jangan sampai server gagal start.
function lanAddresses() {
    try {
        const out = [];
        for (const list of Object.values(os.networkInterfaces())) {
            for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
        }
        return out;
    } catch { return []; }
}

// Log satu baris per request (kecuali LOG_REQUESTS=0), agar terlihat kapan ESP32 menghubungi server.
function logRequest(req, res, url) {
    if (String(process.env.LOG_REQUESTS || '1') === '0') return;
    const t0 = Date.now();
    res.on('finish', () => {
        const ip = String(req.socket.remoteAddress || '-').replace(/^::ffff:/, '');
        console.log(`[req] ${ip} ${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - t0}ms`);
    });
}

function createServer() {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        logRequest(req, res, url);

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
            const body = JSON.stringify({ status: 'ok', service: 'fruit-nvidia-api', provider: 'nvidia', model: nvidia.config().model });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            return res.end(body);
        }

        if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) {
            const body = docs.swaggerPage();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
            return res.end(body);
        }
        if (req.method === 'GET' && url.pathname === '/openapi.json') {
            const body = JSON.stringify(docs.buildSpec());
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
            return res.end(body);
        }

        const ROUTES = {
            '/api/fruit': ['POST', (r, s) => handleFruit(r, s, url)],
            '/api/sensors': ['POST', (r, s) => handleSensors(r, s, url)],
            '/api/limits': [['GET', 'POST'], (r, s) => handleLimits(r, s, url)],
            '/api/setpoints': [['GET', 'POST'], (r, s) => handleSetpoints(r, s, url)],
            '/api/latest': ['GET', (r, s) => handleLatest(s, url)],
            '/api/history': ['GET', (r, s) => handleHistory(s, url)],
            '/api/trend': ['GET', (r, s) => handleTrend(s, url)],
        };
        const route = ROUTES[url.pathname];
        if (route) {
            const asText = url.searchParams.get('format') === 'text';
            const allowed = [].concat(route[0]);
            if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); return send(res, 405, { ok: false, error: `Gunakan ${allowed.join(' atau ')}` }, asText); }
            if (!isAuthorized(req.headers, sharedSecret())) {
                res.setHeader('WWW-Authenticate', 'Bearer');
                req.resume();
                return send(res, 401, { ok: false, error: 'x-api-key salah atau kosong' }, asText);
            }
            return route[1](req, res);
        }

        send(res, 404, { ok: false, error: 'Tidak ditemukan' }, false);
    });
}

function main() {
    const problems = configProblems();
    if (problems.length) {
        for (const p of problems) console.error(`[fruit] FATAL: ${p}`);
        process.exit(1);
    }
    const HOST = process.env.HOST || '127.0.0.1';
    const PORT = Number(process.env.PORT || 9655);
    if (!sharedSecret()) console.warn('[fruit] PERINGATAN: SHARED_SECRET kosong; hanya aman untuk uji lokal (HOST loopback).');
    process.on('unhandledRejection', (e) => console.error('[fruit] unhandledRejection:', e));
    createServer().listen(PORT, HOST, () => {
        const cfg = nvidia.config();
        console.log(`[fruit] siap di http://${HOST}:${PORT}  penyedia=nvidia  model=${cfg.model}`);
        if (cfg.key.length < 20) console.warn('[fruit] PERINGATAN: NVIDIA_API_KEY terlalu pendek (isi lengkap nvapi-...). Sensor tetap jalan, tetapi foto akan ditolak NVIDIA.');
        if (!isLoopback(HOST)) {
            const ips = lanAddresses();
            if (ips.length) console.log(`[fruit] alamat di jaringan ini: ${ips.map((i) => `http://${i}:${PORT}`).join('  ')}`);
            else console.log('[fruit] IP tidak bisa dibaca dari dalam proot; pakai baris "Gateway (= HP)" di Serial Monitor ESP32, atau alamat hotspot dari pengaturan Android.');
        }
    });
}

if (require.main === module) main();

module.exports = { createServer, configProblems, isAuthorized, sharedSecret, isLoopback, lanAddresses };
