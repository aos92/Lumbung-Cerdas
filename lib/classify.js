'use strict';
/**
 * Klasifikasi kesegaran dari nilai sensor gas terhadap rentang min/maks (lib/limits.js).
 * Deterministik, tanpa AI. Hasil ini juga dikirim ke model AI sebagai konteks (lihat fruit.buildPrompt)
 * dan digabung dengan kondisi visual dari model vision (combine).
 *
 *   posisi gas  t = (nilai - min) / (maks - min), dibatasi 0..1
 *   indeks      = rata-rata t semua gas yang tersedia x 100
 *   kelas       segar < 20 <= matang < 45 <= mulai busuk < 70 <= busuk
 *   aturan keras: ada gas >= maks -> minimal "mulai busuk"; dua gas atau lebih >= maks -> "busuk"
 */
const { GASES, LABELS, DEFAULT_LIMITS } = require('./limits');

const CLASSES = ['segar', 'matang', 'mulai busuk', 'busuk'];
const RANK = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
const STATUS_ORDER = { normal: 0, waspada: 1, tinggi: 2 };

function gasStatus(value, lim) {
    if (value >= lim.max) return 'tinggi';
    if (value > lim.min) return 'waspada';
    return 'normal';
}

function classifySensors(sensors, limits = DEFAULT_LIMITS) {
    const gases = {};
    const positions = [];
    let high = 0;
    for (const g of GASES) {
        const v = sensors ? sensors[g] : undefined;
        if (v === undefined || v === null || !Number.isFinite(v)) { gases[g] = null; continue; }
        const lim = limits[g] || DEFAULT_LIMITS[g];
        const t = Math.min(1, Math.max(0, (v - lim.min) / (lim.max - lim.min)));
        const status = gasStatus(v, lim);
        if (status === 'tinggi') high++;
        positions.push(t);
        gases[g] = { value: v, min: lim.min, max: lim.max, status, position: Math.round(t * 100) / 100 };
    }
    if (!positions.length) return { class: null, index: null, gases, high_gases: 0 };
    const index = Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 100);
    let rank = index < 20 ? 0 : index < 45 ? 1 : index < 70 ? 2 : 3;
    if (high >= 1) rank = Math.max(rank, 2);
    if (high >= 2) rank = 3;
    return { class: CLASSES[rank], index, gases, high_gases: high };
}

/** Gabungkan kelas dari sensor dan kondisi visual: ambil yang lebih buruk (pilihan aman untuk pangan). */
function combine(visual, sensorClass) {
    const v = RANK[visual];
    const s = RANK[sensorClass];
    if (v === undefined && s === undefined) return null;
    if (v === undefined) return sensorClass;
    if (s === undefined) return visual;
    return CLASSES[Math.max(v, s)];
}

/** Catatan teks ringkas per gas yang melewati min. */
function gasNotes(cls) {
    const notes = [];
    for (const g of GASES) {
        const x = cls.gases[g];
        if (x && x.status !== 'normal') notes.push(`${LABELS[g]} ${x.status}: ${x.value} ppm (rentang ${x.min}-${x.max})`);
    }
    return notes;
}

/** Status per gas dalam urutan tetap alkohol, co2, metana, amonia; '-' bila tidak ada. */
function statusList(cls) {
    return GASES.map((g) => (cls.gases[g] ? cls.gases[g].status : '-'));
}

module.exports = { CLASSES, RANK, STATUS_ORDER, classifySensors, combine, gasNotes, statusList };
