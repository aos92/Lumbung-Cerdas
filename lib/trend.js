'use strict';
/**
 * Analisis perubahan dari waktu ke waktu untuk satu "pelacak" (jenis buah, atau `batch` bila diberikan).
 * Membandingkan pembacaan awal (baseline) dengan pembacaan terbaru, lalu menilai apakah ada perubahan
 * signifikan yang menandakan pembusukan. Ambang = heuristik, bisa disetel di THRESHOLDS.
 */

const THRESHOLDS = {
    ethylene: { delta: 15, label: 'Etilen naik' },   // ppm vs baseline (fermentasi)
    methane: { delta: 20, label: 'Metana naik' },           // ppm
    co2: { delta: 300, label: 'CO2 naik' },                 // ppm
    scoreDrop: 15,                                          // poin skor statis
    slopePerHour: 2,                                        // poin/jam; <= -2 memburuk, >= +2 membaik
};
const MIN_SAMPLES = 4;
const RANK = { segar: 0, matang: 1, 'mulai busuk': 2, busuk: 3 };

const mean = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / arr.length;
const r1 = (n) => Math.round(n * 10) / 10;
const ramp = (v, lo, hi, max) => Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * max;
const minSpanMin = () => (process.env.TREND_MIN_SPAN_MIN !== undefined && Number(process.env.TREND_MIN_SPAN_MIN) >= 0 ? Number(process.env.TREND_MIN_SPAN_MIN) : 10);

function slopePerHour(obs) {
    const pts = obs.slice(-20).filter((o) => typeof o.score === 'number');
    if (pts.length < 3) return null;
    const t0 = pts[0].ts;
    const xs = pts.map((p) => (p.ts - t0) / 3600000);
    const ys = pts.map((p) => p.score);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (den === 0) return null;
    return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den;
}

/** obs: urut dari terlama, TERMASUK pembacaan sekarang. Setiap item {ts, sensors, score, condition}. */
function analyze(obs) {
    const n = obs.length;
    const out = { samples: n, status: 'belum cukup data', significant: false, signals: [], deltas: null, score_per_hour: null, span_min: 0, baseline_at: null, penalty: 0 };
    if (n < 2) return out;
    out.span_min = r1((obs[n - 1].ts - obs[0].ts) / 60000);
    out.baseline_at = new Date(obs[0].ts).toISOString();
    if (n < MIN_SAMPLES || out.span_min < minSpanMin()) return out;

    const k = Math.min(3, Math.floor(n / 2));
    const base = obs.slice(0, k);
    const recent = obs.slice(-k);
    const deltas = {};
    for (const key of ['co2', 'ethylene', 'methane', 'temp', 'hum']) {
        deltas[key] = r1(mean(recent, (o) => o.sensors[key]) - mean(base, (o) => o.sensors[key]));
    }
    out.deltas = deltas;

    const signals = [];
    for (const key of ['ethylene', 'methane', 'co2']) {
        if (deltas[key] >= THRESHOLDS[key].delta) signals.push(`${THRESHOLDS[key].label} ${deltas[key]} ppm dari baseline`);
    }
    const scored = (o) => typeof o.score === 'number';
    if (base.every(scored) && recent.every(scored)) {
        const drop = r1(mean(base, (o) => o.score) - mean(recent, (o) => o.score));
        out.score_drop = drop;
        if (drop >= THRESHOLDS.scoreDrop) signals.push(`Skor turun ${drop} poin dari baseline`);
    }
    const c0 = RANK[obs[0].condition];
    const c1 = RANK[obs[n - 1].condition];
    if (c0 !== undefined && c1 !== undefined && c1 >= 2 && c1 > c0) signals.push(`Kondisi visual memburuk: ${obs[0].condition} -> ${obs[n - 1].condition}`);

    const slope = slopePerHour(obs);
    out.score_per_hour = slope === null ? null : r1(slope);
    out.signals = signals;
    out.significant = signals.length > 0;
    out.status = out.significant || (slope !== null && slope <= -THRESHOLDS.slopePerHour) ? 'memburuk'
        : slope !== null && slope >= THRESHOLDS.slopePerHour ? 'membaik' : 'stabil';
    out.penalty = Math.round(Math.min(20, ramp(deltas.ethylene, 5, 50, 10) + ramp(deltas.methane, 10, 100, 5) + ramp(deltas.co2, 150, 800, 5)));
    return out;
}

/** Terapkan hasil analisis ke penilaian statis: kurangi skor, naikkan risiko bila perlu. */
function applyChange(verdict, change) {
    if (!change || verdict.food_health_score === null) return { ...verdict, food_health_score_static: verdict.food_health_score };
    const score = Math.max(0, verdict.food_health_score - change.penalty);
    let riskIndex = Math.max(verdict.risk_index ?? 0, 100 - score);
    let level = verdict.risk_level;
    const order = ['rendah', 'sedang', 'tinggi'];
    const raise = (to) => { if (order.indexOf(to) > order.indexOf(level)) level = to; };
    if (change.significant) { raise('sedang'); riskIndex = Math.max(riskIndex, 40); }
    if (change.signals.length >= 2) { raise('tinggi'); riskIndex = Math.max(riskIndex, 70); }
    if (score < 40) raise('tinggi');
    else if (score < 70) raise('sedang');
    return {
        ...verdict,
        food_health_score_static: verdict.food_health_score,
        food_health_score: score,
        risk_index: Math.round(riskIndex),
        risk_level: level,
        notes: change.significant ? [...verdict.notes.filter((n) => n !== 'Tidak ada indikator pembusukan'), ...change.signals] : verdict.notes,
    };
}

module.exports = { analyze, applyChange, THRESHOLDS, MIN_SAMPLES };
