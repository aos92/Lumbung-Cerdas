'use strict';
/**
 * Satu-satunya jalur model: NVIDIA Build (API kompatibel OpenAI).
 *   POST {NVIDIA_BASE_URL}/chat/completions, Authorization: Bearer nvapi-...
 * Semua konfigurasi dibaca saat dipanggil (bukan saat load) agar mudah diuji.
 */

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'meta/llama-3.2-11b-vision-instruct';

function config(env = process.env) {
    return {
        key: String(env.NVIDIA_API_KEY || '').trim(),
        base: String(env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
        model: String(env.NVIDIA_VISION_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
        timeoutMs: Number(env.FRUIT_TIMEOUT_MS) > 0 ? Number(env.FRUIT_TIMEOUT_MS) : 30000,
    };
}

function errorMessage(status, payload, model) {
    if (status === 401 || status === 403) return 'Key NVIDIA ditolak, cek NVIDIA_API_KEY';
    if (status === 402) return 'Kredit NVIDIA habis';
    if (status === 404) return `Model NVIDIA tidak ditemukan: ${model}`;
    if (status === 413) return 'Gambar terlalu besar untuk NVIDIA, turunkan resolusi/kualitas JPEG';
    if (status === 429) return 'Batas request NVIDIA tercapai, coba lagi sebentar';
    const raw = payload?.detail ?? payload?.error?.message ?? payload?.message ?? payload?.error ?? `HTTP ${status}`;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

async function once(cfg, dataUrl, prompt) {
    const res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(cfg.timeoutMs),
        body: JSON.stringify({
            model: cfg.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: dataUrl } },
                    { type: 'text', text: prompt },
                ],
            }],
            max_tokens: 200,
            temperature: 0,
            top_p: 1,
            stream: false,
        }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const status = res.status === 429 ? 429 : 502;
        throw Object.assign(new Error(errorMessage(res.status, payload, cfg.model)), { status, upstream: res.status });
    }
    const content = payload?.choices?.[0]?.message?.content;
    return Array.isArray(content) ? content.map((c) => c?.text || '').join('') : (content || '');
}

function mapError(err) {
    if (err.status !== undefined) return err;                 // sudah dipetakan (respons NVIDIA)
    if (err.name === 'TimeoutError') return Object.assign(new Error('Waktu habis menunggu NVIDIA'), { status: 504 });
    return Object.assign(new Error(`Tidak bisa menghubungi NVIDIA: ${err.cause?.code || err.message}`), { status: 502 });
}

/** Kirim gambar (data URL) + prompt, kembalikan teks jawaban model. Ulang satu kali bila NVIDIA 5xx. */
async function ask(dataUrl, prompt, env = process.env) {
    const cfg = config(env);
    if (!cfg.key) throw Object.assign(new Error('NVIDIA_API_KEY belum diisi di server'), { status: 500 });
    try {
        return await once(cfg, dataUrl, prompt);
    } catch (first) {
        if (!(first.upstream >= 500)) throw mapError(first);
        try { return await once(cfg, dataUrl, prompt); } catch (second) { throw mapError(second); }
    }
}

module.exports = { ask, config, errorMessage, DEFAULT_BASE_URL, DEFAULT_MODEL };
