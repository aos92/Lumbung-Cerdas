'use strict';
/**
 * Penilaian deterministik (tanpa AI): skor kesehatan makanan + indeks risiko dari
 *  - kondisi visual (dari model vision): segar | matang | mulai busuk | busuk
 *  - gas: CO2, etilen (rumus etanol), metana (ppm), dibandingkan dengan rentang min/maks (lib/limits.js)
 *  - lingkungan: suhu (°C), kelembaban (%)
 * Ambang di bawah adalah HEURISTIK untuk demo/penelitian, bukan standar keamanan pangan.
 */

const { DEFAULT_LIMITS } = require('./limits');

const RANGES = { co2: [0, 10000], ethylene: [0, 5000], methane: [0, 10000], temp: [-40, 80], hum: [0, 100] };
const KEYS = Object.keys(RANGES);
const ALIASES = {
    co2: ['co2'],
    ethylene: ['ethylene', 'etilen'],
    methane: ['methane', 'metana', 'ch4'],
    temp: ['temp', 'temperature', 'suhu'],
    hum: ['hum', 'humidity', 'kelembaban'],
};

/** Ambil nilai sensor dari objek (query/JSON). Hanya kunci yang dikirim yang dikembalikan. */
function parseSensors(src) {
    const values = {};
    if (!src || typeof src !== 'object') return { values };
    const lower = {};
    for (const [k, v] of Object.entries(src)) lower[String(k).toLowerCase()] = v;
    for (const key of KEYS) {
        const name = ALIASES[key].find((a) => lower[a] !== undefined && lower[a] !== null && String(lower[a]).trim() !== '');
        if (!name) continue;
        const n = typeof lower[name] === 'number' ? lower[name] : Number(String(lower[name]).trim().replace(',', '.'));
        const [lo, hi] = RANGES[key];
        if (!Number.isFinite(n) || n < lo || n > hi) return { values: {}, error: `Nilai sensor tidak valid: ${key} (harus ${lo}..${hi})` };
        values[key] = Math.round(n * 100) / 100;
    }
    return { values };
}

const ramp = (v, lo, hi, max) => (v === undefined ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * max);

const VISUAL_PENALTY = { segar: 0, matang: 10, 'mulai busuk': 40, busuk: 70 };

function normalizeCondition(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    if (t.includes('mulai') || /(start|begin|early|slight)\w*\s+(to\s+)?(rot|spoil|decay)/.test(t)) return 'mulai busuk';
    if (/busuk|rusak|jamur|membusuk|\brotten|\brot\b|spoil|mou?ld|decay/.test(t)) return 'busuk';
    if (t.includes('matang') || /\b(over)?ripe/.test(t)) return 'matang';
    if (t.includes('segar') || /\bfresh|unripe/.test(t)) return 'segar';
    return null;
}

function assess({ condition = null, sensors = {}, limits = null } = {}) {
    const L = limits || DEFAULT_LIMITS;
    const s = sensors || {};
    const hasSensors = KEYS.some((k) => s[k] !== undefined && s[k] !== null);
    const cond = normalizeCondition(condition);
    if (!hasSensors && !cond) {
        return { food_health_score: null, risk_index: null, risk_level: 'tidak diketahui', notes: ['Tidak ada data kondisi visual maupun sensor'], basis: [] };
    }
    const v = (k) => (s[k] === null ? undefined : s[k]);
    const notes = [];
    const basis = [];
    let penalty = 0;
    let severe = false;
    let elevated = false;

    if (cond) {
        basis.push('visual');
        penalty += VISUAL_PENALTY[cond];
        if (cond === 'busuk') { severe = true; notes.push('Tampilan visual menunjukkan pembusukan'); }
        else if (cond === 'mulai busuk') { elevated = true; notes.push('Tampilan visual mulai membusuk'); }
    }
    // [kunci, bobot penalti maks, label]. Penalti naik linear dari min ke maks; >= maks = parah, >= 40% rentang = waspada.
    const gas = [
        ['co2', 25, 'CO2 tinggi'],
        ['ethylene', 30, 'Etilen tinggi (indikasi fermentasi)'],
        ['methane', 15, 'Metana tinggi (indikasi pembusukan)'],
    ];
    let gasUsed = false;
    for (const [key, weight, label] of gas) {
        if (v(key) === undefined) continue;
        const { min, max } = L[key];
        const severeAt = max;
        const elevAt = min + 0.4 * (max - min);
        gasUsed = true;
        penalty += ramp(v(key), min, max, weight);
        if (v(key) >= severeAt) { severe = true; notes.push(`${label}: ${v(key)} ppm`); }
        else if (v(key) >= elevAt) { elevated = true; notes.push(`${label}: ${v(key)} ppm`); }
    }
    if (gasUsed) basis.push('gas');
    if (v('temp') !== undefined || v('hum') !== undefined) {
        basis.push('lingkungan');
        penalty += ramp(v('temp'), 25, 40, 8) + ramp(v('hum'), 75, 95, 7);
        if (v('temp') >= 30) { elevated = true; notes.push(`Suhu hangat mempercepat pembusukan: ${v('temp')} °C`); }
        if (v('hum') >= 85) { elevated = true; notes.push(`Kelembaban tinggi: ${v('hum')} %`); }
    }

    const score = Math.round(Math.min(100, Math.max(0, 100 - penalty)));
    const riskIndex = Math.round(Math.max(100 - score, severe ? 70 : 0));
    let level = 'rendah';
    if (severe || score < 40) level = 'tinggi';
    else if (elevated || score < 70) level = 'sedang';
    if (!notes.length) notes.push('Tidak ada indikator pembusukan');
    return { food_health_score: score, risk_index: riskIndex, risk_level: level, notes, basis };
}

/** Kunci sensor wajib yang belum ada di values. */
function missingKeys(values) {
    return KEYS.filter((k) => !values || values[k] === undefined || values[k] === null);
}

module.exports = { missingKeys, KEYS, RANGES, parseSensors, normalizeCondition, assess };
