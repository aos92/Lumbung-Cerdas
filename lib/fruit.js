'use strict';
const { normalizeCondition } = require('./assess');
const { GASES } = require('./limits');
/**
 * Logika pengenal buah: prompt, penguraian jawaban model, tabel nutrisi kurasi.
 * Tidak ada panggilan jaringan di sini (lihat lib/nvidia.js).
 */

// Nutrisi singkat yang sudah dikurasi. Dipakai lebih dulu agar jawaban konsisten
// dan tidak bergantung pada kalimat bebas dari model. Urutan penting (yang spesifik dulu).
const NUTRITION = [
    [['buah naga', 'dragon fruit', 'pitaya'], 'Serat & vitamin C'],
    [['jambu biji', 'guava'], 'Vitamin C sangat tinggi'],
    [['jeruk', 'orange', 'mandarin', 'tangerine'], 'Tinggi vitamin C'],
    [['lemon', 'lime'], 'Tinggi vitamin C'],
    [['stroberi', 'strawberry'], 'Tinggi vitamin C'],
    [['kiwi'], 'Tinggi vitamin C'],
    [['nanas', 'pineapple'], 'Vitamin C & bromelain'],
    [['mangga', 'mango'], 'Vitamin A & C'],
    [['pepaya', 'papaya'], 'Vitamin A, C & serat'],
    [['pisang', 'banana'], 'Kaya kalium & energi'],
    [['apel', 'apple'], 'Serat & vitamin C'],
    [['pir', 'pear'], 'Tinggi serat'],
    [['semangka', 'watermelon'], 'Banyak air & likopen'],
    [['melon', 'cantaloupe'], 'Air, vitamin A & C'],
    [['anggur', 'grape'], 'Antioksidan & vitamin K'],
    [['alpukat', 'avocado'], 'Lemak sehat & serat'],
    [['delima', 'pomegranate'], 'Antioksidan & vitamin C'],
    [['blueberry'], 'Antioksidan tinggi'],
];

// Llama 3.2 Vision: untuk gambar + teks hanya bahasa Inggris yang didukung resmi, jadi prompt berbahasa Inggris.
// Hasil tetap diterjemahkan ke label Indonesia (normalizeCondition, tabel nutrisi, buildResult).
const PROMPT = [
    'You are a fruit recognizer. Look at this image.',
    'Reply with ONLY one line of JSON, no markdown, no explanation:',
    '{"is_fruit":true,"name_id":"fruit name in Indonesian","name_en":"english name",',
    '"condition":"fresh|ripe|starting to rot|rotten","confidence":"high|medium|low",',
    '"nutrition":"max 6 words in Indonesian, e.g. Tinggi vitamin C"}',
    'If the image is not a fruit or is unclear: is_fruit=false and name_id="".',
].join(' ');
const GAS_EN = { alcohol: 'Alcohol', co2: 'CO2', methane: 'Methane', ammonia: 'Ammonia' };
const CLASS_EN = { segar: 'fresh', matang: 'ripe', 'mulai busuk': 'starting to rot', busuk: 'rotten' };

/**
 * Prompt untuk model vision. Bila ada data sensor + rentang min/maks, keduanya disertakan agar model
 * mengklasifikasi kesegaran dari gambar DAN data gas (bukan gambar saja).
 */
function buildPrompt(sensors, limits, sensorClass) {
    const lines = [PROMPT];
    const have = sensors && limits ? GASES.filter((g) => Number.isFinite(sensors[g])) : [];
    if (have.length) {
        lines.push('Gas sensor data from the fruit chamber (ppm) with reference ranges [min-max]:');
        lines.push(have.map((g) => `${GAS_EN[g]}=${sensors[g]} [${limits[g].min}-${limits[g].max}]`).join('; ') + '.');
        if (Number.isFinite(sensors.temp) && Number.isFinite(sensors.hum)) lines.push(`Temperature ${sensors.temp} C, humidity ${sensors.hum} %.`);
        lines.push('Rule: gas <= min = normal/fresh; between min and max = warning; >= max = indication of spoilage.');
        if (sensorClass) lines.push(`Classification from the gas sensors alone: ${CLASS_EN[sensorClass] || sensorClass}. Decide "condition" by combining the visual appearance with this gas data.`);
    }
    return lines.join(' ');
}

function detectMime(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    return null;
}

function extractJson(text) {
    const s = String(text || '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(s.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
}

function titleCase(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
}

function lookupNutrition(...names) {
    const hay = names.map((n) => String(n || '').toLowerCase()).filter(Boolean);
    for (const [keys, value] of NUTRITION) {
        if (hay.some((h) => keys.some((k) => h.includes(k)))) return value;
    }
    return null;
}

// Nama baku untuk pelacakan: baris tabel nutrisi yang cocok (nama Indonesia), selain itu huruf kecil.
function canonicalName(nameId, nameEn) {
    const hay = [nameId, nameEn].map((n) => String(n || '').toLowerCase()).filter(Boolean);
    for (const [keys] of NUTRITION) {
        if (hay.some((h) => keys.some((k) => h.includes(k)))) return keys[0];
    }
    return (hay[0] || '').trim().replace(/\s+/g, ' ');
}

function clip(s, max) {
    s = String(s || '').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const CONFIDENCE = { high: 'tinggi', medium: 'sedang', low: 'rendah', tinggi: 'tinggi', sedang: 'sedang', rendah: 'rendah' };
function normalizeConfidence(c) { return CONFIDENCE[String(c || '').trim().toLowerCase()] || 'sedang'; }

function buildResult(parsed) {
    const isFruit = parsed && (parsed.is_fruit === true || String(parsed.is_fruit).toLowerCase() === 'true');
    if (!isFruit || !String(parsed.name_id || '').trim()) {
        return { ok: true, is_fruit: false, fruit: '', nutrition: '', confidence: 'rendah', condition: null, line1: 'Bukan buah', line2: 'Coba arahkan ulang' };
    }
    const fruit = clip(titleCase(parsed.name_id), 24);
    const nutrition = clip(lookupNutrition(parsed.name_id, parsed.name_en) || parsed.nutrition || 'Data nutrisi tidak tersedia', 32);
    return {
        ok: true,
        is_fruit: true,
        fruit,
        fruit_en: clip(parsed.name_en, 24),
        confidence: normalizeConfidence(parsed.confidence),
        condition: normalizeCondition(parsed.condition),
        nutrition,
        line1: fruit,
        line2: nutrition,
    };
}

// Satu baris "Nama|Nutrisi" (untuk ESP32) atau "ERR|pesan".
function toText(result) {
    return result.ok ? `${result.line1}|${result.line2}` : `ERR|${clip(result.error, 60)}`;
}

// "Nama|Nutrisi|Klasifikasi|Skor|Risiko" (untuk Central Unit ESP32 yang perlu klasifikasi juga).
function toFullText(result) {
    if (!result.ok) return `ERR|${clip(result.error, 60)}`;
    // '|' dan baris baru dibuang dari teks bebas agar penguraian di Central Unit tidak bergeser kolom
    const dash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v).replace(/[|\r\n]+/g, ' ').trim() || '-');
    return [result.line1, result.line2, result.klasifikasi, result.food_health_score, result.risk_level].map(dash).join('|');
}

module.exports = { canonicalName, PROMPT, buildPrompt, toFullText, NUTRITION, detectMime, extractJson, lookupNutrition, buildResult, toText, clip };
