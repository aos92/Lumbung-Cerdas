'use strict';
/**
 * Dokumentasi API publik: spesifikasi OpenAPI 3.0 + halaman Swagger UI.
 *   GET /docs          halaman Swagger UI (publik, tanpa x-api-key)
 *   GET /openapi.json  spesifikasi mentah (publik)
 * Hanya berisi dokumentasi: tidak ada rahasia/key. Untuk "Try it out" endpoint /api/*,
 * pengguna menekan tombol Authorize lalu mengisi SHARED_SECRET sendiri.
 * Tanpa dependensi npm: Swagger UI dimuat browser dari CDN (versi dipatok).
 */
const nvidia = require('./nvidia');
const { DEFAULT_LIMITS } = require('./limits');
const { DEFAULT_SETPOINTS } = require('./setpoints');

const SWAGGER_UI_VERSION = '5.17.14';

function description(cfg, env = process.env) {
    return `
Backend **Lumbung Cerdas** (\`fruit-nvidia-api\`): memantau kesegaran buah dari **foto** (ESP32-CAM) + **gas**
(MQ-3, MQ-4, MQ-135) + **suhu/kelembaban** (DHT22). Foto dikirim ke model vision di NVIDIA Build, lalu hasilnya
digabung dengan penilaian sensor yang deterministik (tanpa AI).

\`\`\`
ESP32-CAM --JPEG--> POST /api/fruit --> NVIDIA Build (model vision) --> nama + nutrisi + kondisi
Central Unit --sensor--> POST /api/sensors --> skor, risiko, klasifikasi
MIT App Inventor <-- GET /api/latest, /api/history, /api/trend ; --> POST /api/limits, /api/setpoints
\`\`\`

## Cara menguji endpoint langsung
1. Klik tombol **Authorize** (kanan atas), isi \`x-api-key\` dengan nilai **SHARED_SECRET** server, lalu **Authorize**.
   (Di mode lokal tanpa SHARED_SECRET, kunci tidak perlu diisi.)
2. Buka endpoint, klik **Try it out**, isi parameter, klik **Execute**.
3. \`/health\`, \`/docs\` dan \`/openapi.json\` publik; semua \`/api/*\` butuh kunci.

> Catatan: data disimpan **di memori** server dan hilang saat restart/tidur (Render gratis tidak punya disk tetap).

## Struktur backend dan fungsinya

| Berkas | Fungsi |
|---|---|
| \`server.js\` | Server HTTP bawaan Node (tanpa framework). Routing, autentikasi kunci bersama (\`x-api-key\` / Bearer, dibandingkan timing-safe), pembacaan body dengan batas ukuran, log request, validasi konfigurasi saat start. Handler: \`handleFruit\`, \`handleSensors\`, \`handleLimits\`, \`handleSetpoints\`, \`handleLatest\`, \`handleHistory\`, \`handleTrend\`. |
| \`lib/nvidia.js\` | Klien NVIDIA Build (API kompatibel OpenAI, \`/chat/completions\`). Timeout, ulang satu kali bila NVIDIA 5xx, pemetaan galat ke pesan Indonesia (401/402/404/413/429/504). |
| \`lib/fruit.js\` | Prompt model, deteksi JPEG/PNG dari byte awal, pengurai jawaban JSON model, tabel nutrisi kurasi, nama baku buah, format keluaran \`text\` dan \`full\`. |
| \`lib/assess.js\` | Validasi 6 nilai sensor (alias ID/EN) dan **skor kesehatan makanan** 0-100, indeks risiko, level risiko (rendah/sedang/tinggi). Deterministik. |
| \`lib/classify.js\` | **Klasifikasi** segar / matang / mulai busuk / busuk dari posisi gas terhadap rentang min-maks, plus penggabungan dengan kondisi visual (diambil yang terburuk). |
| \`lib/limits.js\` | Rentang min/maks 4 gas (alkohol, CO2, metana, amonia) dari textbox App Inventor; parsing, validasi, gabung, format teks. |
| \`lib/setpoints.js\` | 5 setpoint kontrol kipas/Peltier (CO2, metana, alkohol, suhu, kelembaban) yang diambil Central Unit. |
| \`lib/trend.js\` | Analisis perubahan dari waktu ke waktu per jenis buah/\`batch\` (delta gas terhadap baseline, kemiringan skor per jam) dan penalti skor bila signifikan. |
| \`lib/store.js\` | Penyimpanan **in-memory**: sensor terakhir (maks 200), hasil foto (maks 100), pelacak tren (maks 50 pelacak x 200 pengamatan), batas, setpoint. |
| \`lib/env.js\` | Pembaca \`.env\` (variabel environment selalu menang). |
| \`lib/docs.js\` | Modul ini: spesifikasi OpenAPI dan halaman Swagger UI. |
| \`esp32/\` | Firmware Central Unit (baca sensor, kontrol kipas/Peltier, kirim ke backend) dan sub unit kamera. |
| \`tests/\` | Uji otomatis (\`npm test\`) memakai mock NVIDIA, tanpa key asli. |

**Alur \`POST /api/fruit\`:** autentikasi -> baca body (JPEG/PNG mentah atau JSON base64) -> validasi 6 sensor (inline atau pembacaan tersimpan yang masih baru)
-> klasifikasi sensor -> **panggil model vision** (gambar + data gas + rentang) -> bentuk hasil -> penilaian skor/risiko -> analisis tren -> klasifikasi akhir = yang terburuk antara visual dan sensor -> simpan -> balas.

## Model AI yang digunakan

| Item | Nilai |
|---|---|
| Model | \`${cfg.model}\` (bawaan \`${nvidia.DEFAULT_MODEL}\`; ganti dengan env \`NVIDIA_VISION_MODEL\`) |
| Penyedia | NVIDIA Build (Free Endpoint), \`${cfg.base}/chat/completions\` |
| Jenis | Vision-language model (Llama 3.2 Vision, 11B), instruction-tuned |
| Masukan / keluaran | Gambar + teks -> teks (backend meminta satu baris JSON) |
| Konteks | 128k token |
| Bahasa prompt | Inggris (untuk gambar + teks hanya bahasa Inggris yang didukung resmi); hasil diterjemahkan server ke label Indonesia |
| Parameter inferensi | \`max_tokens=200\`, \`temperature=0\`, \`top_p=1\`, \`stream=false\` |
| Format gambar | JPEG atau PNG, dikirim sebagai data URL base64; maks ${Number(env.MAX_IMAGE_BYTES) > 0 ? Number(env.MAX_IMAGE_BYTES) : 3145728} byte (\`MAX_IMAGE_BYTES\`) |
| Timeout / ulang | ${cfg.timeoutMs} ms (\`FRUIT_TIMEOUT_MS\`); diulang 1 kali bila NVIDIA membalas 5xx |
| Lisensi model | Llama 3.2 Community License |
| Spesifikasi resmi | https://docs.api.nvidia.com/nim/reference/meta-llama-3_2-11b-vision-instruct |

Model hanya dipakai untuk **mengenali buah, kondisi visual (segar/matang/mulai busuk/busuk), tingkat keyakinan, dan ringkasan nutrisi**.
Nutrisi memakai tabel kurasi di \`lib/fruit.js\` lebih dulu agar konsisten. **Skor, risiko, klasifikasi sensor, dan tren dihitung tanpa AI** (aturan di \`lib/assess.js\`, \`lib/classify.js\`, \`lib/trend.js\`); ambangnya heuristik untuk demo/penelitian, bukan standar keamanan pangan.

## Sensor (keenamnya wajib)
\`co2\` (0-10000 ppm), \`ammonia\` (0-1000 ppm; alias \`amonia\`, \`nh3\`), \`alcohol\` (0-5000 ppm; alias \`alkohol\`, \`etanol\`), \`methane\` (0-10000 ppm; alias \`metana\`, \`ch4\`), \`temp\` (-40..80 °C; alias \`suhu\`), \`hum\` (0-100 %; alias \`kelembaban\`).
`.trim();
}

// ── Komponen skema bersama ──
const SENSOR_PARAMS = [
    ['co2', 'CO2 (ppm), 0..10000', 450],
    ['ammonia', 'Amonia (ppm), 0..1000. Alias: amonia, nh3', 2],
    ['alcohol', 'Alkohol/etanol (ppm), 0..5000. Alias: alkohol, etanol', 1],
    ['methane', 'Metana (ppm), 0..10000. Alias: metana, ch4', 3],
    ['temp', 'Suhu (°C), -40..80. Alias: suhu, temperature', 26],
    ['hum', 'Kelembaban (%), 0..100. Alias: kelembaban, humidity', 65],
];
const q = (name, description, example, extra = {}) => ({ name, in: 'query', description, schema: { type: 'number', example, ...extra } });
const sensorQuery = (required) => SENSOR_PARAMS.map(([n, d, e]) => ({ ...q(n, d, e), required }));
const actuatorQuery = [
    { name: 'peltier', in: 'query', description: 'Status Peltier dari Central Unit (opsional, untuk dashboard). 1/0, true/false, on/off, ya/tidak', schema: { type: 'string', enum: ['0', '1'] } },
    { name: 'fan', in: 'query', description: 'Status kipas dari Central Unit (opsional). Alias: kipas', schema: { type: 'string', enum: ['0', '1'] } },
];
const formatText = (desc = 'Isi `text` untuk balasan satu baris dipisah `|` (untuk ESP32 / App Inventor)') => ({ name: 'format', in: 'query', description: desc, schema: { type: 'string', enum: ['text'] } });

const errRef = { $ref: '#/components/schemas/Error' };
const jsonErr = (description) => ({ description, content: { 'application/json': { schema: errRef }, 'text/plain': { schema: { type: 'string', example: 'ERR|pesan galat' } } } });
const sec = [{ ApiKeyAuth: [] }, { BearerAuth: [] }];
const std = {
    401: jsonErr('x-api-key salah atau kosong'),
};
const textOk = (description, example) => ({ description, content: { 'text/plain': { schema: { type: 'string', example } } } });

const SENSOR_OBJ = {
    type: 'object',
    properties: Object.fromEntries(SENSOR_PARAMS.map(([n, d, e]) => [n, { type: 'number', description: d, example: e }])),
};
const LIMITS_BODY = {
    type: 'object',
    description: 'Boleh sebagian. Nama Inggris (alcohol_min, methane_max, ammonia_max) juga diterima. Minimal harus lebih kecil dari maksimal.',
    properties: {
        alkohol_min: { type: 'number', example: 5 }, alkohol_maks: { type: 'number', example: 50 },
        co2_min: { type: 'number', example: 800 }, co2_maks: { type: 'number', example: 2500 },
        metana_min: { type: 'number', example: 5 }, metana_maks: { type: 'number', example: 100 },
        amonia_min: { type: 'number', example: 5 }, amonia_maks: { type: 'number', example: 50 },
    },
};
const SETPOINTS_BODY = {
    type: 'object',
    description: 'Boleh sebagian. Awalan setpoint_/sp_ dan nama Inggris (methane, alcohol, temp, hum) juga diterima.',
    properties: {
        co2: { type: 'number', example: 2500, description: 'ppm, 1..10000: kipas ON bila CO2 >= nilai' },
        metana: { type: 'number', example: 100, description: 'ppm, 1..10000' },
        alkohol: { type: 'number', example: 50, description: 'ppm, 1..5000' },
        suhu: { type: 'number', example: 25, description: '°C, -40..80: kipas ON dan Peltier mendinginkan bila suhu >= nilai' },
        kelembaban: { type: 'number', example: 85, description: '%, 1..100' },
    },
};
const limitQuery = [
    ['alkohol_min', 5], ['alkohol_maks', 50], ['co2_min', 800], ['co2_maks', 2500],
    ['metana_min', 5], ['metana_maks', 100], ['amonia_min', 5], ['amonia_maks', 50],
].map(([n, e]) => q(n, `Batas ${n.replace('_', ' ')} (ppm). Opsional; boleh sebagian`, e));
const setpointQuery = [
    ['co2', 2500, 'ppm'], ['metana', 100, 'ppm'], ['alkohol', 50, 'ppm'], ['suhu', 25, '°C'], ['kelembaban', 85, '%'],
].map(([n, e, u]) => q(n, `Setpoint ${n} (${u}). Opsional; boleh sebagian`, e));

function buildSpec(env = process.env) {
    const cfg = nvidia.config(env);
    return {
        openapi: '3.0.3',
        info: {
            title: 'Lumbung Cerdas API',
            version: '1.0.0',
            description: description(cfg, env),
            license: { name: 'MIT' },
        },
        servers: [{ url: '/', description: 'Server ini (relatif; Try it out memanggil host yang sama)' }],
        tags: [
            { name: 'Sistem', description: 'Publik, tanpa kunci.' },
            { name: 'Pengenalan buah (AI)', description: 'Foto -> model vision NVIDIA -> nama, nutrisi, kondisi, skor, risiko, klasifikasi.' },
            { name: 'Sensor', description: 'Pembacaan gas/suhu/kelembaban dari Central Unit.' },
            { name: 'Pengaturan (App Inventor)', description: 'Batas min/maks gas dan setpoint kontrol kipas/Peltier.' },
            { name: 'Pemantauan', description: 'Data terakhir, riwayat, dan analisis tren (dipakai MIT App Inventor).' },
        ],
        paths: {
            '/health': {
                get: {
                    tags: ['Sistem'], summary: 'Health check', security: [],
                    description: 'Publik. Dipakai health check Render. Tidak membocorkan key. Alias: `GET /`.',
                    responses: { 200: { description: 'Server hidup', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, service: { type: 'string', example: 'fruit-nvidia-api' }, provider: { type: 'string', example: 'nvidia' }, model: { type: 'string', example: cfg.model } } } } } } },
                },
            },
            '/api/fruit': {
                post: {
                    tags: ['Pengenalan buah (AI)'], summary: 'Kenali buah dari foto', security: sec,
                    description: [
                        'Mengirim foto ke model vision NVIDIA (`' + cfg.model + '`) bersama data sensor, lalu mengembalikan nama buah, nutrisi, kondisi visual, skor kesehatan, risiko, tren, dan klasifikasi akhir.',
                        '',
                        '**Enam sensor WAJIB** (`co2, ammonia, alcohol, methane, temp, hum`): kirim lewat query/JSON, atau biarkan kosong bila `POST /api/sensors` sudah dikirim dalam `SENSOR_MAX_AGE_S` detik (bawaan 600). Tanpa sensor, permintaan ditolak **sebelum** memanggil NVIDIA.',
                        '',
                        'Body: **JPEG/PNG mentah** (pilih berkas), atau JSON `{"image":"<base64>","sensors":{...}}`. Maks ' + (Number(env.MAX_IMAGE_BYTES) > 0 ? Number(env.MAX_IMAGE_BYTES) : 3145728) + ' byte (`MAX_IMAGE_BYTES`).',
                        '',
                        '`format`: kosong = JSON lengkap; `text` = `Nama|Nutrisi`; `full` = `Nama|Nutrisi|Klasifikasi|Skor|Risiko`.',
                        '',
                        'Memanggil model, jadi butuh beberapa detik dan memakai kuota NVIDIA Anda.',
                    ].join('\n'),
                    parameters: [
                        { name: 'format', in: 'query', description: 'Format balasan', schema: { type: 'string', enum: ['text', 'full'] } },
                        { name: 'batch', in: 'query', description: 'ID untuk memisahkan pelacakan buah sejenis (huruf/angka/spasi/.-_ maks 40). Bawaan: nama buah', schema: { type: 'string', example: 'rak-1' } },
                        ...sensorQuery(false),
                        ...actuatorQuery,
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                            'image/png': { schema: { type: 'string', format: 'binary' } },
                            'application/json': {
                                schema: {
                                    type: 'object', required: ['image'],
                                    properties: {
                                        image: { type: 'string', description: 'JPEG/PNG base64 (boleh berawalan data:image/jpeg;base64,)' },
                                        sensors: SENSOR_OBJ,
                                        batch: { type: 'string', example: 'rak-1' },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        200: { description: 'Hasil pengenalan', content: { 'application/json': { schema: { $ref: '#/components/schemas/FruitResult' } }, 'text/plain': { schema: { type: 'string', example: 'Jeruk|Tinggi vitamin C|segar|95|rendah' } } } },
                        400: jsonErr('Gambar kosong / bukan JPEG-PNG / JSON rusak / sensor tidak valid atau kurang / batch tidak valid'),
                        401: std[401],
                        413: jsonErr('Gambar terlalu besar'),
                        429: jsonErr('Batas request NVIDIA tercapai'),
                        502: jsonErr('NVIDIA gagal/ditolak atau jawaban model tidak bisa dibaca'),
                        504: jsonErr('Waktu habis menunggu NVIDIA'),
                    },
                },
            },
            '/api/sensors': {
                post: {
                    tags: ['Sensor'], summary: 'Kirim pembacaan sensor', security: sec,
                    description: 'Dipanggil Central Unit (tiap ~10 detik). Keenam nilai wajib. Balasan memuat skor, risiko, dan klasifikasi sensor. Pembacaan terbaru dipakai otomatis oleh `/api/fruit` bila foto dikirim tanpa sensor. Nilai bisa lewat query, atau body JSON (datar atau di dalam `sensors`).',
                    parameters: [...sensorQuery(false), ...actuatorQuery, formatText('`text` membalas `OK|skor|risiko|klasifikasi`')],
                    requestBody: { required: false, content: { 'application/json': { schema: { ...SENSOR_OBJ, properties: { ...SENSOR_OBJ.properties, peltier: { type: 'integer', enum: [0, 1] }, fan: { type: 'integer', enum: [0, 1] } } } } } },
                    responses: {
                        200: { description: 'Tersimpan', content: { 'application/json': { schema: { $ref: '#/components/schemas/SensorResult' } }, 'text/plain': { schema: { type: 'string', example: 'OK|88|rendah|segar' } } } },
                        400: jsonErr('JSON tidak valid / nilai di luar rentang / sensor kurang'),
                        401: std[401],
                        413: jsonErr('Body terlalu besar (maks 8 KB)'),
                    },
                },
            },
            '/api/limits': {
                get: {
                    tags: ['Pengaturan (App Inventor)'], summary: 'Baca batas min/maks gas', security: sec,
                    description: `Bawaan: alkohol ${DEFAULT_LIMITS.alcohol.min}-${DEFAULT_LIMITS.alcohol.max}, CO2 ${DEFAULT_LIMITS.co2.min}-${DEFAULT_LIMITS.co2.max}, metana ${DEFAULT_LIMITS.methane.min}-${DEFAULT_LIMITS.methane.max}, amonia ${DEFAULT_LIMITS.ammonia.min}-${DEFAULT_LIMITS.ammonia.max} ppm. Teks: \`OK|alkohol_min|alkohol_maks|co2_min|co2_maks|metana_min|metana_maks|amonia_min|amonia_maks\`.`,
                    parameters: [formatText()],
                    responses: { 200: { description: 'Batas saat ini', content: { 'application/json': { schema: { $ref: '#/components/schemas/LimitsResult' } }, 'text/plain': { schema: { type: 'string', example: 'OK|5|50|800|2500|5|100|5|50' } } } }, 401: std[401] },
                },
                post: {
                    tags: ['Pengaturan (App Inventor)'], summary: 'Simpan batas min/maks gas', security: sec,
                    description: 'Gabungkan nilai yang dikirim ke batas saat ini (boleh sebagian). Ditolak 400 bila minimal >= maksimal; nilai lama tetap.',
                    parameters: [...limitQuery, formatText()],
                    requestBody: { required: false, content: { 'application/json': { schema: LIMITS_BODY } } },
                    responses: { 200: { description: 'Batas tersimpan', content: { 'application/json': { schema: { $ref: '#/components/schemas/LimitsResult' } }, 'text/plain': { schema: { type: 'string', example: 'OK|5|50|800|2500|5|100|5|50' } } } }, 400: jsonErr('Nilai tidak valid / kosong / min >= maks'), 401: std[401] },
                },
            },
            '/api/setpoints': {
                get: {
                    tags: ['Pengaturan (App Inventor)'], summary: 'Baca setpoint kontrol', security: sec,
                    description: `Diambil Central Unit untuk kontrol kipas/Peltier. Bawaan: CO2 ${DEFAULT_SETPOINTS.co2}, metana ${DEFAULT_SETPOINTS.methane}, alkohol ${DEFAULT_SETPOINTS.alcohol}, suhu ${DEFAULT_SETPOINTS.temp}, kelembaban ${DEFAULT_SETPOINTS.hum}. Teks: \`OK|co2|metana|alkohol|suhu|kelembaban|custom\` (custom 1 = sudah diisi aplikasi, 0 = masih bawaan).`,
                    parameters: [formatText()],
                    responses: { 200: { description: 'Setpoint saat ini', content: { 'application/json': { schema: { $ref: '#/components/schemas/SetpointsResult' } }, 'text/plain': { schema: { type: 'string', example: 'OK|2500|100|50|25|85|0' } } } }, 401: std[401] },
                },
                post: {
                    tags: ['Pengaturan (App Inventor)'], summary: 'Simpan setpoint kontrol', security: sec,
                    description: 'Boleh sebagian; nilai lain tetap.',
                    parameters: [...setpointQuery, formatText()],
                    requestBody: { required: false, content: { 'application/json': { schema: SETPOINTS_BODY } } },
                    responses: { 200: { description: 'Setpoint tersimpan', content: { 'application/json': { schema: { $ref: '#/components/schemas/SetpointsResult' } }, 'text/plain': { schema: { type: 'string', example: 'OK|2500|100|50|25|85|1' } } } }, 400: jsonErr('Nilai tidak valid / kosong'), 401: std[401] },
                },
            },
            '/api/latest': {
                get: {
                    tags: ['Pemantauan'], summary: 'Hasil foto + sensor terakhir', security: sec,
                    description: 'Untuk dashboard MIT App Inventor. JSON memuat `result` (hasil foto terakhir), `image` (metadata foto: id, at, age_s, bytes), `sensors` (pembacaan terbaru + penilaian), `limits`, `setpoints`. `format=text` = 26 kolom dipisah `|` (lihat docs/APP_INVENTOR.md): nama, nutrisi, skor, risiko, indeks, co2, amonia, alkohol, metana, suhu, kelembaban, status tren, tren signifikan, kelas sensor, indeks sensor, status 4 gas, klasifikasi foto, umur sensor, umur foto, kondisi terburuk, Peltier, kipas, id foto (untuk `GET /api/image?v=`).',
                    parameters: [formatText()],
                    responses: { 200: { description: 'Data terakhir', content: { 'application/json': { schema: { $ref: '#/components/schemas/Latest' } }, 'text/plain': { schema: { type: 'string', example: 'Jeruk|Tinggi vitamin C|95|rendah|5|450|1|1|3|25|60|...' } } } }, 401: std[401] },
                },
            },
            '/api/image': {
                get: {
                    tags: ['Pemantauan'], summary: 'Foto terakhir dari ESP32-CAM', security: sec,
                    description: 'Mengembalikan foto terakhir (image/jpeg) yang dikirim ke `POST /api/fruit`, tanpa dibungkus JSON. Untuk komponen **Image** MIT App Inventor yang hanya menerima URL dan tidak bisa mengirim header, kunci boleh lewat `?key=`. Tambahkan `&v=<id foto>` (kolom ke-26 `/api/latest?format=text`) supaya gambar baru dimuat ulang. Foto hanya disimpan di memori server (hilang saat restart/tidur). 404 bila belum ada foto.',
                    parameters: [
                        { name: 'key', in: 'query', required: false, schema: { type: 'string' }, description: 'Alternatif header x-api-key (hanya endpoint ini).' },
                        { name: 'v', in: 'query', required: false, schema: { type: 'string' }, description: 'Id foto; hanya penanda anti-cache, tidak mengubah isi.' },
                    ],
                    responses: { 200: { description: 'Foto terakhir', headers: { 'X-Image-Id': { schema: { type: 'string' } }, 'X-Image-Time': { schema: { type: 'string' } } }, content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } } } }, 401: std[401], 404: { description: 'Belum ada foto' } },
                },
            },
            '/api/history': {
                get: {
                    tags: ['Pemantauan'], summary: 'Riwayat hasil foto atau sensor', security: sec,
                    description: 'Terbaru lebih dulu. Disimpan di memori (hasil maks 100, sensor maks 200).',
                    parameters: [
                        { name: 'type', in: 'query', description: 'Jenis riwayat', schema: { type: 'string', enum: ['results', 'sensors'], default: 'results' } },
                        { name: 'limit', in: 'query', description: 'Jumlah item, 1..100', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
                    ],
                    responses: { 200: { description: 'Daftar riwayat', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, type: { type: 'string', example: 'results' }, count: { type: 'integer' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } } } }, 401: std[401] },
                },
            },
            '/api/trend': {
                get: {
                    tags: ['Pemantauan'], summary: 'Analisis perubahan dari waktu ke waktu', security: sec,
                    description: 'Tanpa `key`: ringkasan semua pelacak (jenis buah atau `batch`). Dengan `key`: detail satu pelacak. Status: belum cukup data / stabil / memburuk / membaik (perlu min. 4 pengamatan dan rentang `TREND_MIN_SPAN_MIN` menit). Teks tanpa key: `key|jumlah|status|signifikan|skor_terakhir` per baris; dengan key: `key|jumlah|status|signifikan|skor_awal|skor_akhir|skor_per_jam`.',
                    parameters: [
                        { name: 'key', in: 'query', description: 'Nama pelacak (huruf kecil), mis. `pisang` atau ID batch', schema: { type: 'string', example: 'pisang' } },
                        { name: 'limit', in: 'query', description: 'Jumlah pengamatan pada detail (1..200)', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
                        formatText(),
                    ],
                    responses: { 200: { description: 'Hasil tren', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } }, 'text/plain': { schema: { type: 'string', example: 'pisang|12|memburuk|ya|92|71|-3.5' } } } }, 401: std[401], 404: jsonErr('Belum ada data untuk pelacak ini') },
                },
            },
        },
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Nilai SHARED_SECRET server (sama dengan API_KEY di sketch ESP32)' },
                BearerAuth: { type: 'http', scheme: 'bearer', description: 'Alternatif: Authorization: Bearer <SHARED_SECRET>' },
            },
            schemas: {
                Error: { type: 'object', properties: { ok: { type: 'boolean', example: false }, error: { type: 'string', example: 'x-api-key salah atau kosong' } } },
                FruitResult: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' }, is_fruit: { type: 'boolean' },
                        fruit: { type: 'string', example: 'Jeruk' }, fruit_en: { type: 'string', example: 'Orange' },
                        confidence: { type: 'string', enum: ['tinggi', 'sedang', 'rendah'] },
                        condition: { type: 'string', nullable: true, enum: ['segar', 'matang', 'mulai busuk', 'busuk', null], description: 'Kondisi visual dari model' },
                        nutrition: { type: 'string', example: 'Tinggi vitamin C' },
                        line1: { type: 'string', description: 'Baris 1 layar ESP32 (nama)' }, line2: { type: 'string', description: 'Baris 2 (nutrisi)' },
                        food_health_score: { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
                        risk_index: { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
                        risk_level: { type: 'string', enum: ['rendah', 'sedang', 'tinggi', 'tidak diketahui'] },
                        notes: { type: 'array', items: { type: 'string' } }, basis: { type: 'array', items: { type: 'string' } },
                        sensors: SENSOR_OBJ, sensors_source: { type: 'string', enum: ['inline', 'stored'] },
                        change: { type: 'object', nullable: true, additionalProperties: true, description: 'Hasil analisis tren (status, significant, signals, deltas, score_per_hour)' },
                        track_key: { type: 'string', nullable: true },
                        klasifikasi: { type: 'string', enum: ['segar', 'matang', 'mulai busuk', 'busuk'], description: 'Klasifikasi akhir = terburuk antara visual dan sensor' },
                        classification: { type: 'object', additionalProperties: true, description: 'final, sensor, visual, index, gases' },
                        limits: { type: 'object', additionalProperties: true },
                    },
                },
                SensorResult: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' }, sensors: SENSOR_OBJ,
                        act: { type: 'object', properties: { peltier: { type: 'integer' }, fan: { type: 'integer' } } },
                        food_health_score: { type: 'integer' }, risk_index: { type: 'integer' }, risk_level: { type: 'string' },
                        notes: { type: 'array', items: { type: 'string' } }, basis: { type: 'array', items: { type: 'string' } },
                        klasifikasi: { type: 'string' }, classification: { type: 'object', additionalProperties: true },
                    },
                },
                LimitsResult: { type: 'object', properties: { ok: { type: 'boolean' }, limits: { type: 'object', additionalProperties: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } }, example: DEFAULT_LIMITS } } },
                SetpointsResult: { type: 'object', properties: { ok: { type: 'boolean' }, setpoints: { type: 'object', properties: { co2: { type: 'number' }, methane: { type: 'number' }, alcohol: { type: 'number' }, temp: { type: 'number' }, hum: { type: 'number' } }, example: DEFAULT_SETPOINTS }, custom: { type: 'boolean' } } },
                Latest: { type: 'object', properties: { ok: { type: 'boolean' }, server_time: { type: 'string', format: 'date-time' }, limits: { type: 'object', additionalProperties: true }, setpoints: { type: 'object', additionalProperties: true }, result: { type: 'object', nullable: true, additionalProperties: true }, sensors: { type: 'object', nullable: true, additionalProperties: true } } },
            },
        },
    };
}

function swaggerPage() {
    const v = SWAGGER_UI_VERSION;
    return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumbung Cerdas API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui.css">
<style>body{margin:0}.swagger-ui .info .title{font-size:2rem}</style>
</head>
<body>
<div id="swagger-ui"></div>
<noscript>Halaman ini membutuhkan JavaScript. Spesifikasi mentah: <a href="/openapi.json">/openapi.json</a></noscript>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui-bundle.js"></script>
<script>
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: false,
    displayRequestDuration: true,
    tryItOutEnabled: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0
  });
};
</script>
</body>
</html>
`;
}

module.exports = { buildSpec, swaggerPage, SWAGGER_UI_VERSION };
