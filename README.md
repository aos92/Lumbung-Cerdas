# Lumbung Cerdas (fruit-nvidia-api)

Backend + firmware ESP32 untuk memantau kesegaran buah: foto (ESP32-CAM) + gas (MQ-3, MQ-4, MQ-135) + suhu/kelembaban (DHT22),
dengan batas min/maks yang diatur dari aplikasi MIT App Inventor. **Satu jalur model**:

```
ESP32-CAM --JPEG--> POST /api/fruit --> NVIDIA Build (model vision) --> "Nama|Nutrisi"
```

Tanpa proxy lain, tanpa login browser, tanpa Chrome extension, tanpa dependensi npm.

## Model AI

`meta/llama-3.2-11b-vision-instruct` lewat NVIDIA Build (bawaan; ganti dengan env `NVIDIA_VISION_MODEL`).
Spesifikasi: https://docs.api.nvidia.com/nim/reference/meta-llama-3_2-11b-vision-instruct
Teks + gambar masuk, teks keluar, konteks 128k. Untuk masukan gambar + teks hanya bahasa Inggris yang didukung resmi, sehingga prompt di `lib/fruit.js`
berbahasa Inggris; jawaban model (kondisi, keyakinan) diterjemahkan ke label Indonesia (`segar|matang|mulai busuk|busuk`) oleh server.
Lisensi model: Llama 3.2 Community License.

## Dokumentasi API (Swagger UI)

Halaman publik **`GET /docs`** (tanpa `x-api-key`) berisi struktur backend dan fungsinya, spesifikasi model AI, dan semua endpoint
dengan keterangan serta parameter yang bisa diuji langsung (**Try it out**). Spesifikasi mentah: **`GET /openapi.json`**.
Untuk menguji `/api/*`, klik **Authorize** lalu isi `x-api-key` dengan `SHARED_SECRET`. Kode: `lib/docs.js`.
Swagger UI dimuat browser dari CDN jsDelivr (versi dipatok), jadi server tetap tanpa dependensi npm.

## Endpoint

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | `/docs` | tidak | dokumentasi Swagger UI (struktur backend, model AI, uji endpoint langsung) |
| GET | `/openapi.json` | tidak | spesifikasi OpenAPI 3 |
| GET | `/health` | tidak | `{"status":"ok","provider":"nvidia","model":"..."}` |
| POST | `/api/fruit` | `x-api-key: <SHARED_SECRET>` atau `Authorization: Bearer <SHARED_SECRET>` | body JPEG/PNG mentah, atau JSON `{"image":"<base64>"}` |
| POST | `/api/sensors` | sama | nilai sensor (JSON atau query) dari Central Unit; balasan memuat klasifikasi sensor |
| GET/POST | `/api/limits` | sama | batas min/maks alkohol, CO2, metana, amonia dari textbox App Inventor; `?format=text` |
| GET/POST | `/api/setpoints` | sama | 5 setpoint kontrol (CO2, metana, alkohol, suhu, kelembaban) dari App Inventor, diambil Central Unit; `?format=text` membalas `OK` + lima nilai (urutan co2, metana, alkohol, suhu, kelembaban) + penanda custom 0/1 |
| GET | `/api/latest` | sama | hasil foto + sensor terakhir; `?format=text` untuk App Inventor |
| GET | `/api/history` | sama | riwayat; `?type=results\|sensors&limit=20` |
| GET | `/api/trend` | sama | analisis perubahan per jenis buah/batch; `?key=pisang`, `?format=text` |

Balasan `/api/fruit`:

- JSON (default): `{"ok":true,"is_fruit":true,"fruit":"Jeruk","fruit_en":"Orange","confidence":"tinggi","nutrition":"Tinggi vitamin C","line1":"Jeruk","line2":"Tinggi vitamin C"}`
- `?format=text`: `Jeruk|Tinggi vitamin C` (paling ringan untuk ESP32)
- `?format=full`: `Jeruk|Tinggi vitamin C|segar|95|rendah` (Nama, Nutrisi, Klasifikasi akhir, Skor, Risiko); dipakai Central Unit
- Bukan buah: `Bukan buah|Coba arahkan ulang`
- Error: JSON `{"ok":false,"error":"..."}` atau teks `ERR|pesan`

## Sensor referensi (MQ-135, MQ-4, MQ-3, DHT22)

Sensor dikirim sebagai nilai ppm/°C/%: `co2`, `ammonia`, `alcohol`, `methane`, `temp`, `hum` **Keenamnya WAJIB** (alias `amonia`/`nh3`, `etanol`/`alkohol`, `metana`, `suhu`, `kelembaban` diterima). Amonia menggantikan CO; MQ-135 membaca CO2 dan amonia sekaligus. Data sebagian ditolak dengan 400 yang menyebut kunci yang kurang, dan foto tanpa data sensor ditolak **sebelum** memanggil NVIDIA.
Dua cara:

1. **Bersama foto**: `POST /api/fruit?co2=500&ammonia=2&alcohol=1&methane=3&temp=26&hum=65`, atau JSON `{"image":"<base64>","sensors":{...}}`.
2. **Terpisah** (disarankan): node sensor memanggil `POST /api/sensors`; foto berikutnya otomatis memakai pembacaan terakhir yang lengkap bila umurnya di bawah `SENSOR_MAX_AGE_S` (600 detik); bila sudah basi, foto ditolak.
   ESP32-CAM praktis tidak punya pin ADC1 bebas (ADC2 tidak jalan saat WiFi aktif), jadi di rancangan satu kotak ini MQ-3/MQ-4/MQ-135 dan DHT22 dibaca langsung oleh Central Unit (ADC1) dan didorong ke `/api/sensors` tiap 10 detik.

Balasan `/api/fruit` bertambah: `condition` (segar|matang|mulai busuk|busuk, dari model vision), `food_health_score` (0-100),
`risk_index` (0-100), `risk_level` (rendah|sedang|tinggi), `notes`, `basis`, `sensors`, `sensors_source` (inline|stored|none).
`?format=text` tetap `Nama|Nutrisi`. Tambahan: `klasifikasi` (akhir), `classification` (`final`, `sensor`, `visual`, `index`, `gases`), `limits`.

### Batas min/maks dan klasifikasi kesegaran

Aplikasi mengirim batas lewat `POST /api/limits` (8 nilai: `alkohol_min`, `alkohol_maks`, `co2_min`, `co2_maks`, `metana_min`, `metana_maks`,
`amonia_min`, `amonia_maks`; nama Inggris juga diterima, boleh sebagian). Minimal harus lebih kecil dari maksimal, kalau tidak ditolak 400 dan nilai lama tetap.
Bawaan: alkohol 5-50, CO2 800-2500, metana 5-100, amonia 5-50 ppm.

Batas itu dipakai tiga kali:

1. **Prompt model AI** (`fruit.buildPrompt`): nilai gas, batasnya, dan klasifikasi sensor ikut dikirim bersama foto ke NVIDIA, sehingga model memutuskan kondisi dari gambar **dan** data gas.
2. **Klasifikasi sensor** (`lib/classify.js`, deterministik): posisi tiap gas dalam rentang -> indeks 0-100 -> `segar | matang | mulai busuk | busuk`;
   satu gas >= maksimal -> minimal `mulai busuk`, dua gas -> `busuk`. Tersedia juga tanpa foto (di `/api/sensors` dan `/api/latest`).
3. **Skor dan risiko** (`lib/assess.js`): penalti naik linear dari minimal ke maksimal; >= maksimal dianggap parah.

`klasifikasi` akhir pada hasil foto = yang lebih buruk antara kondisi visual (AI) dan klasifikasi sensor.

### Analisis dari waktu ke waktu (perubahan signifikan = pembusukan)

Setiap foto buah (`is_fruit=true`) dicatat sebagai pengamatan pada satu *pelacak*: nama baku jenis buah (mis. "Pisang Ambon" dan "banana" -> `pisang`),
atau `?batch=<id>` bila ada beberapa buah sejenis yang dipantau terpisah. Analisis butuh minimal 4 pengamatan dan rentang waktu 10 menit
(`TREND_MIN_SPAN_MIN`); sebelum itu `change.status` = `belum cukup data` dan skor tidak dikurangi.

Rata-rata pengamatan awal (baseline) dibandingkan dengan rata-rata pengamatan terbaru. Sinyal pembusukan bila:
alkohol naik >= 15 ppm, metana >= 20 ppm, CO2 >= 300 ppm, amonia >= 5 ppm, skor statis turun >= 15 poin, atau kondisi visual memburuk menjadi *mulai busuk/busuk*.
Suhu/kelembaban hanya dicatat sebagai konteks, bukan sinyal. Dampaknya:

- minimal satu sinyal (`change.significant`): risiko minimal **sedang**; dua sinyal atau lebih: risiko **tinggi**
- skor dikurangi `change.penalty` (maks 20); skor sebelum pengurangan ada di `food_health_score_static`
- `change.status`: `memburuk` (ada sinyal atau kemiringan skor <= -2 poin/jam), `membaik`, `stabil`, `belum cukup data`

Kekurangannya: tanpa pembacaan udara kosong sebagai pembanding, pergeseran udara ruangan ikut terbaca sebagai perubahan.
Pengamatan hilang saat server restart. Ambang ada di `lib/trend.js` (`THRESHOLDS`) dan `lib/assess.js`; semuanya heuristik.

Skor dan risiko dihitung deterministik di `lib/assess.js` (kondisi visual + gas terhadap batas min/maks + suhu/kelembaban), **bukan** oleh AI.
Ambangnya heuristik, bukan standar keamanan pangan; sensor MQ tidak spesifik dan perlu kalibrasi (lihat komentar di sketch).
Panduan App Inventor: `docs/APP_INVENTOR.md`.

Kode status: 400 input salah, 401 kunci salah, 405 bukan POST, 413 gambar terlalu besar,
429 batas NVIDIA, 500 `NVIDIA_API_KEY` kosong, 502 NVIDIA menolak / jawaban tak terbaca / tak terjangkau, 504 NVIDIA terlalu lama.

## Konfigurasi (env)

| Variabel | Wajib | Bawaan | Fungsi |
|---|---|---|---|
| `NVIDIA_API_KEY` | ya | - | key `nvapi-...` dari build.nvidia.com/settings/api-keys |
| `SHARED_SECRET` | ya bila `HOST` bukan loopback | - | kunci bersama dengan sketch ESP32 |
| `NVIDIA_VISION_MODEL` | tidak | `meta/llama-3.2-11b-vision-instruct` | ganti model tanpa ubah kode |
| `NVIDIA_BASE_URL` | tidak | `https://integrate.api.nvidia.com/v1` | |
| `FRUIT_TIMEOUT_MS` | tidak | `30000` | batas tunggu NVIDIA (ms) |
| `MAX_IMAGE_BYTES` | tidak | `3145728` | batas ukuran foto |
| `HOST` / `PORT` | tidak | `127.0.0.1` / `9655` | Render mengisi `PORT` sendiri |

Server **berhenti dengan pesan `FATAL`** bila `NVIDIA_API_KEY` kosong, atau `SHARED_SECRET` kosong padahal `HOST` publik.
Jadi salah konfigurasi langsung terlihat di log deploy, bukan baru saat ESP32 mengirim foto.

## Jalankan lokal

```
cp .env.example .env        # isi NVIDIA_API_KEY (SHARED_SECRET boleh kosong di 127.0.0.1)
npm run doctor -- --live    # validasi key dan model
npm run doctor -- --image jeruk.jpg
npm start
curl -X POST "http://127.0.0.1:9655/api/fruit?format=text" -H "Content-Type: image/jpeg" --data-binary @jeruk.jpg
```

## Tes

```
npm test
```

84 tes: logika buah, batas min/maks dan klasifikasi, penilaian skor/risiko, sensor dan endpoint App Inventor, seluruh server melawan mock NVIDIA (auth, format, semua kode error, ulang 5xx, timeout,
tiga foto bersamaan), dan proses nyata (start seperti di Render, FATAL saat konfigurasi salah).
Tes memakai server NVIDIA tiruan; key asli belum teruji di sini, gunakan `npm run doctor -- --live` untuk itu.

## Struktur

```
server.js            HTTP server, auth, validasi gambar
lib/nvidia.js        satu-satunya panggilan keluar (NVIDIA Build)
lib/fruit.js         prompt (+ data sensor/batas), penguraian jawaban, tabel nutrisi kurasi
lib/assess.js        parsing sensor + skor kesehatan makanan + indeks risiko
lib/limits.js        batas min/maks alkohol, CO2, metana, amonia (parsing, validasi)
lib/setpoints.js     5 setpoint kontrol kipas/Peltier (parsing, rentang, bawaan)
lib/classify.js      klasifikasi kesegaran dari sensor + gabungan dengan kondisi visual
lib/trend.js         analisis perubahan baseline vs terbaru per jenis buah/batch
lib/store.js         penyimpanan terakhir/riwayat/pengamatan/batas di memori
lib/env.js           pembaca .env minimal
lib/docs.js          spesifikasi OpenAPI + halaman Swagger UI (/docs, /openapi.json)
tests/               uji otomatis (npm test), memakai mock NVIDIA
scripts/doctor.js    cek konfigurasi / key / model / satu foto
esp32/central_unit/  central_unit.ino: ESP32 WROOM-32D: MQ-3/MQ-4/MQ-135, DHT22, reed, kipas, Peltier, TFT, WiFi, master UART, unggah ke backend
esp32/sub_unit_1/    sub_unit_1.ino: ESP32-CAM, foto atas perintah Central (JPEG lewat UART)
esp32/README.md      daftar koneksi lengkap, protokol UART, kalibrasi, pemecahan masalah
test/                sketch uji perangkat keras (display, Render + reconnect WiFi, kamera Sub 1, sensor + kontrol Sub 2): lihat test/README.md
docs/APP_INVENTOR.md panduan MIT App Inventor (textbox batas + klasifikasi)
Catatan.txt          daftar wiring dan penempatan sensor
render.yaml          Blueprint Render
Containerfile        opsi container
```

### Firmware ESP32 (belum diuji di perangkat keras)

Rancangan sekarang **satu kotak, dua papan**: Central Unit (ESP32 WROOM-32D) dan Sub Unit 1 (ESP32-CAM). Sub Unit 2 tidak dipakai lagi; sensor gas, DHT22, dan reed switch langsung di Central.
Wiring lengkap, protokol UART, dan kalibrasi: `esp32/README.md`.

Capture punya dua pemicu: (1) reed switch di pintu, satu siklus buka lalu tutup kembali, dan (2) jadwal rutin Central (`SCHEDULE_CAPTURE_INTERVAL_MS`, bawaan 30 menit, 0 = nonaktif).
Alur: pintu tertutup atau jadwal -> `CAP\n` ke Sub Unit 1 -> JPEG lewat UART (921600 baud) -> Central -> `POST /api/fruit?format=full` (sensor ikut) -> hasil tampil di TFT.
Kipas (GPIO14) dan Peltier (GPIO33) dikontrol dari **5 setpoint** yang diisi di aplikasi Android, disimpan di backend (`/api/setpoints`), lalu diambil Central Unit tiap 30 detik dan disalin ke flash ESP32 (tetap berlaku bila WiFi/server mati):

- Kipas ON bila suhu >= setpoint suhu, atau CO2, metana, atau alkohol >= setpoint masing-masing (buang gas segera), atau kelembaban >= setpoint kelembaban; mati bila semuanya di bawah (dengan histeresis kecil dan minimal ON 10 detik).
- Peltier ON bila suhu >= setpoint suhu (mendinginkan); mati bila suhu kembali di bawahnya. `PELTIER_COOLING 0` membalik logikanya.
- Klasifikasi foto/sensor (segar, matang, ...) hanya untuk tampilan **Mode Buah**, tidak menggerakkan kipas/Peltier.
Isi `WIFI_SSID`, `WIFI_PASSWORD`, `BACKEND_URL`, `API_KEY` di `esp32/central_unit/central_unit.ino`. Backend bisa juga dijalankan di HP Android lewat Termux dengan ESP32 di hotspot HP: lihat `docs/TERMUX.md`.
Tampilan TFT Central Unit dan layar App Inventor mengikuti gambar dashboard (pratinjau: `docs/Pratinjau_Tampilan.png`); jam footer memakai NTP lewat WiFi (WIB).
Nama berkas `.ino` sama dengan nama foldernya (syarat Arduino IDE); buka tiap folder sebagai satu sketch.
Library: TFT_eSPI (`User_Setup.h` di library: pin TFT lihat `esp32/README.md`), DHT sensor library + Adafruit Unified Sensor. `WiFiClientSecure` dan `HTTPClient` sudah ada di core ESP32 (panduan ArduinoDroid: `docs/ARDUINODROID.md`).
Peltier TEC1-12706 menarik arus besar: gunakan MOSFET logic-level atau modul relay/driver, bukan langsung dari pin ESP32, dan pasang heatsink dengan kipas di sisi panasnya.

Menambah buah ke tabel nutrisi: edit `NUTRITION` di `lib/fruit.js` (nama Indonesia dan Inggris).

Lisensi: MIT (lihat `LICENSE`).
