'use strict';
/**
 * Penyimpanan di memori (hilang saat server restart/tidur; Render gratis tidak punya disk tetap).
 * Cukup untuk dipantau App Inventor; untuk arsip jangka panjang simpan di sisi aplikasi.
 */
const MAX_SENSORS = 200;
const MAX_RESULTS = 100;

const MAX_SERIES = 200;
const MAX_TRACKS = 50;
const { DEFAULT_LIMITS, clone } = require('./limits');
const setpointsLib = require('./setpoints');
const state = { sensor: null, sensors: [], result: null, results: [], tracks: new Map(), limits: null, setpoints: null };
const iso = (ts) => new Date(ts).toISOString();
const age = (ts, now) => Math.max(0, Math.round((now - ts) / 1000));
const push = (arr, item, max) => { arr.unshift(item); if (arr.length > max) arr.length = max; };

function saveSensors(values, now = Date.now(), act = null) {
    // act = status aktuator {peltier:0|1, fan:0|1} dari Central Unit (opsional, untuk tampilan dashboard)
    const entry = { ts: now, values: { ...values }, ...(act ? { act: { ...act } } : {}) };
    state.sensor = entry;
    push(state.sensors, entry, MAX_SENSORS);
    return entry;
}
function saveResult(result, now = Date.now()) {
    const entry = { ts: now, ...result };
    state.result = entry;
    push(state.results, entry, MAX_RESULTS);
    return entry;
}
/** Pembacaan sensor terakhir bila belum lewat maxAgeS detik, selain itu null. */
function freshSensors(maxAgeS, now = Date.now()) {
    if (!state.sensor || (now - state.sensor.ts) / 1000 > maxAgeS) return null;
    return state.sensor;
}
const view = (e, now) => { if (!e) return null; const { ts, ...rest } = e; return { at: iso(ts), age_s: age(ts, now), ...rest }; };
function latest(now = Date.now()) { return { result: view(state.result, now), sensors: view(state.sensor, now) }; }
function history(kind, limit, now = Date.now()) {
    const arr = kind === 'sensors' ? state.sensors : state.results;
    return arr.slice(0, limit).map((e) => view(e, now));
}
function addObservation(key, obs, now = Date.now()) {
    if (!state.tracks.has(key)) {
        if (state.tracks.size >= MAX_TRACKS) state.tracks.delete(state.tracks.keys().next().value);
        state.tracks.set(key, []);
    }
    const arr = state.tracks.get(key);
    arr.push({ ts: now, ...obs });
    if (arr.length > MAX_SERIES) arr.shift();
}
/** Pengamatan satu pelacak, terlama dulu, hanya yang masih dalam jendela waktu. */
function series(key, windowMs, now = Date.now()) {
    return (state.tracks.get(key) || []).filter((o) => now - o.ts <= windowMs);
}
function tracks(windowMs, now = Date.now()) {
    return [...state.tracks.keys()].map((key) => ({ key, items: series(key, windowMs, now) })).filter((t) => t.items.length);
}
/** Rentang min/maks gas dari aplikasi (bawaan bila belum pernah dikirim). Selalu salinan. */
function getLimits() { return clone(state.limits || DEFAULT_LIMITS); }
function saveLimits(limits) { state.limits = clone(limits); return getLimits(); }
/** Setpoint kontrol (suhu, kelembaban, CO2, metana, alkohol) dari aplikasi. `custom` = true bila pernah diisi aplikasi (bukan bawaan). */
function getSetpoints() { return { values: setpointsLib.clone(state.setpoints || setpointsLib.DEFAULT_SETPOINTS), custom: !!state.setpoints }; }
function saveSetpoints(provided) {
    state.setpoints = { ...setpointsLib.clone(state.setpoints || setpointsLib.DEFAULT_SETPOINTS), ...provided };
    return getSetpoints();
}
function reset() { state.setpoints = null; state.limits = null; state.sensor = null; state.sensors = []; state.result = null; state.results = []; state.tracks = new Map(); }

module.exports = { getLimits, saveLimits, getSetpoints, saveSetpoints, addObservation, series, tracks, saveSensors, saveResult, freshSensors, latest, history, reset };
