'use strict';
/**
 * Rentang referensi (min/maks) per gas yang diisi dari textbox aplikasi MIT App Inventor.
 *   nilai <= min  -> normal (buah segar)
 *   min..maks     -> waspada (menuju pembusukan)
 *   nilai >= maks -> tinggi (indikasi busuk)
 * Satuan ppm. Bawaan di bawah dipakai sampai aplikasi mengirim nilai sendiri.
 */

const GASES = ['alcohol', 'co2', 'methane', 'ammonia'];
const LABELS = { alcohol: 'Alkohol', co2: 'CO2', methane: 'Metana', ammonia: 'Amonia' };
const MAX_VALUE = { alcohol: 5000, co2: 10000, methane: 10000, ammonia: 1000 };
const DEFAULT_LIMITS = {
    alcohol: { min: 5, max: 50 },
    co2: { min: 800, max: 2500 },
    methane: { min: 5, max: 100 },
    ammonia: { min: 5, max: 50 },
};
// Nama kunci yang diterima untuk <gas>_min / <gas>_max (Indonesia dan Inggris).
const NAMES = {
    alcohol: ['alcohol', 'alkohol', 'ethanol', 'etanol'],
    co2: ['co2'],
    methane: ['methane', 'metana', 'ch4'],
    ammonia: ['ammonia', 'amonia', 'nh3'],
};
// Urutan kolom teks (App Inventor): alkohol_min|alkohol_maks|co2_min|co2_maks|metana_min|metana_maks|amonia_min|amonia_maks
const TEXT_ORDER = GASES.flatMap((g) => [[g, 'min'], [g, 'max']]);

const clone = (l) => Object.fromEntries(GASES.map((g) => [g, { ...l[g] }]));
const num = (x) => (typeof x === 'number' ? x : Number(String(x).trim().replace(',', '.')));
const blank = (x) => x === undefined || x === null || String(x).trim() === '';

/**
 * Ambil nilai min/maks yang dikirim (query/JSON datar `alkohol_min`, atau bersarang `{alcohol:{min,max}}`,
 * atau `{limits:{...}}`). Hanya kunci yang dikirim yang dikembalikan.
 */
function parseLimits(src) {
    const provided = {};
    if (!src || typeof src !== 'object') return { provided };
    const flat = {};
    const nested = src.limits && typeof src.limits === 'object' ? src.limits : {};
    for (const [k, v] of Object.entries({ ...src, ...nested })) flat[String(k).toLowerCase()] = v;
    for (const g of GASES) {
        for (const side of ['min', 'max']) {
            let raw;
            for (const name of NAMES[g]) {
                const candidates = [flat[`${name}_${side}`], side === 'max' ? flat[`${name}_maks`] : undefined,
                    flat[name] && typeof flat[name] === 'object' ? (flat[name][side] ?? (side === 'max' ? flat[name].maks : undefined)) : undefined];
                raw = candidates.find((c) => !blank(c));
                if (raw !== undefined) break;
            }
            if (raw === undefined) continue;
            const n = num(raw);
            if (!Number.isFinite(n) || n < 0 || n > MAX_VALUE[g]) {
                return { provided: {}, error: `Batas tidak valid: ${LABELS[g]} ${side === 'min' ? 'minimal' : 'maksimal'} (harus 0..${MAX_VALUE[g]})` };
            }
            (provided[g] = provided[g] || {})[side] = Math.round(n * 100) / 100;
        }
    }
    return { provided };
}

/** Gabungkan nilai baru ke batas saat ini; tolak bila minimal >= maksimal. */
function mergeLimits(current, provided) {
    const out = clone(current || DEFAULT_LIMITS);
    for (const g of GASES) Object.assign(out[g], provided[g] || {});
    for (const g of GASES) {
        if (!(out[g].min < out[g].max)) return { error: `${LABELS[g]}: minimal (${out[g].min}) harus lebih kecil dari maksimal (${out[g].max})` };
    }
    return { limits: out };
}

/** "alkohol_min|alkohol_maks|co2_min|..." dalam urutan TEXT_ORDER. */
function toText(limits) {
    return TEXT_ORDER.map(([g, side]) => limits[g][side]).join('|');
}

module.exports = { GASES, LABELS, DEFAULT_LIMITS, MAX_VALUE, parseLimits, mergeLimits, toText, clone };
