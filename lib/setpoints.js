'use strict';
/**
 * Setpoint kontrol kipas dan Peltier dari aplikasi MIT App Inventor (5 TextBox numerik).
 * Disimpan di backend, lalu diambil Central Unit (GET /api/setpoints?format=text) dan diterapkan di ESP32.
 *
 *   co2       ppm   kipas ON bila CO2 >= setpoint (buang gas)
 *   methane   ppm   kipas ON bila metana >= setpoint
 *   alcohol   ppm   kipas ON bila alkohol >= setpoint
 *   temp      C     kipas ON (dan Peltier mendinginkan) bila suhu >= setpoint; mati bila kembali di bawahnya
 *   hum       %     kipas ON bila kelembaban >= setpoint
 *
 * Urutan teks (App Inventor): co2|metana|alkohol|suhu|kelembaban
 */

const KEYS = ['co2', 'methane', 'alcohol', 'temp', 'hum'];
const LABELS = { co2: 'Setpoint CO2', methane: 'Setpoint metana', alcohol: 'Setpoint alkohol', temp: 'Setpoint suhu', hum: 'Setpoint kelembaban' };
const RANGES = { co2: [1, 10000], methane: [1, 10000], alcohol: [1, 5000], temp: [-40, 80], hum: [1, 100] };
const DEFAULT_SETPOINTS = { co2: 2500, methane: 100, alcohol: 50, temp: 25, hum: 85 };
const NAMES = {
    co2: ['co2'],
    methane: ['metana', 'methane', 'ch4'],
    alcohol: ['alkohol', 'alcohol', 'etanol', 'ethanol'],
    temp: ['suhu', 'temp', 'temperature'],
    hum: ['kelembaban', 'hum', 'humidity', 'rh'],
};

const clone = (s) => ({ ...s });
const blank = (x) => x === undefined || x === null || String(x).trim() === '';
const num = (x) => (typeof x === 'number' ? x : Number(String(x).trim().replace(',', '.')));

/** Ambil setpoint yang dikirim (query/JSON datar, awalan setpoint_/sp_ diterima, atau {setpoints:{...}}). Hanya kunci yang dikirim dikembalikan. */
function parseSetpoints(src) {
    const provided = {};
    if (!src || typeof src !== 'object') return { provided };
    const nested = src.setpoints && typeof src.setpoints === 'object' ? src.setpoints : {};
    const flat = {};
    for (const [k, v] of Object.entries({ ...src, ...nested })) {
        flat[String(k).toLowerCase().replace(/^(setpoint|sp)[_-]/, '')] = v;
    }
    for (const key of KEYS) {
        const name = NAMES[key].find((a) => !blank(flat[a]));
        if (!name) continue;
        const n = num(flat[name]);
        const [lo, hi] = RANGES[key];
        if (!Number.isFinite(n) || n < lo || n > hi) return { provided: {}, error: `${LABELS[key]} tidak valid (angka ${lo}..${hi})` };
        provided[key] = Math.round(n * 100) / 100;
    }
    return { provided };
}

/** "co2|metana|alkohol|suhu|kelembaban" */
function toText(sp) {
    return [sp.co2, sp.methane, sp.alcohol, sp.temp, sp.hum].join('|');
}

module.exports = { KEYS, LABELS, RANGES, DEFAULT_SETPOINTS, parseSetpoints, toText, clone };
