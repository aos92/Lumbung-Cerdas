# Deploy ke Render + ESP32 (Central, Sub Unit 1 CAM, Sub Unit 2 sensor)

1. Buat key NVIDIA: https://build.nvidia.com/settings/api-keys, **Generate Key** (berawalan `nvapi-`, hanya tampil sekali).
2. Buat rahasia bersama, mis. `openssl rand -hex 32`. Nilainya sama dengan `API_KEY` di sketch.
3. Push folder ini ke GitHub (**private**). Jangan commit sketch yang sudah berisi rahasia asli ke repo publik.
4. Render > New > **Blueprint** > pilih repo (membaca `render.yaml`).
5. Isi dua env di dashboard: `SHARED_SECRET` dan `NVIDIA_API_KEY`. Tidak ada Secret File.
6. Tunggu deploy hijau. Cek: `curl https://NAMA-SERVICE.onrender.com/health` harus `{"status":"ok","provider":"nvidia",...}`.
   Bila deploy gagal, baca log: baris `FATAL:` menyebut env mana yang kurang.
7. Tes satu foto sebelum merakit ESP32:
```
curl -X POST "https://NAMA-SERVICE.onrender.com/api/fruit?format=text" \
  -H "x-api-key: ISI_SHARED_SECRET" -H "Content-Type: image/jpeg" \
  --data-binary @jeruk.jpg
```
   Harus membalas mis. `Jeruk|Tinggi vitamin C`.
8. Upload tiga sketch (disarankan ESP32 Arduino core 2.0.14+; Sub Unit 2 memakai API ADC lama `esp_adc_cal`, belum dicoba di core 3.x):
   - `esp32/central_unit`: isi `WIFI_SSID`, `WIFI_PASSWORD`, `BACKEND_URL` (alamat Render, tanpa `/` akhir), `API_KEY` (= `SHARED_SECRET`). Board ESP32 WROOM-32D, library TFT_eSPI.
   - `esp32/sub_unit_1`: board "AI Thinker ESP32-CAM" (PSRAM aktif). UART ke Central di GPIO 14 (RX) dan 15 (TX); jangan pakai SD card.
   - `esp32/central_unit`: board ESP32 WROOM-32D, library TFT_eSPI + ESP32ClientSecure (AHT20 + BMP280 lewat `Wire.h`). Kalibrasi `R0_MQ4`, `R0_MQ3`, `R0_MQ135` di udara bersih.
   Wiring lengkap ada di `Catatan.txt`. Semua GND harus disatukan.

## Sensor dan App Inventor

- Central Unit mendorong data Sub Unit 2 ke `/api/sensors` tiap 10 detik (tidak perlu sketch sensor terpisah).
- Batas min/maks gas diatur dari aplikasi lewat `POST /api/limits` (lihat `docs/APP_INVENTOR.md`); uji: `curl -X POST "https://NAMA-SERVICE.onrender.com/api/limits?etilen_min=5&etilen_maks=50&co2_min=800&co2_maks=2500" -H "x-api-key: ISI_SHARED_SECRET"`
- Uji tanpa perangkat: `curl -X POST "https://NAMA-SERVICE.onrender.com/api/sensors?co2=500&ethylene=3&methane=4&temp=27&hum=65" -H "x-api-key: ISI_SHARED_SECRET"`
- Pantau dari ponsel: `GET /api/latest`. Langkah App Inventor ada di `docs/APP_INVENTOR.md`.

## Catatan

- Render gratis tidur setelah ~15 menit idle; request pertama bisa 30-60 detik (timeout sketch 90 detik).
- NVIDIA mencatat penggunaan dan meminta jangan mengunggah data pribadi (wajah/suara). Foto buah aman; jangan arahkan kamera ke orang.
- Batas gratis NVIDIA (kredit, request/menit) bisa berubah; cek di akun NVIDIA Developer.
- Model bawaan `meta/llama-3.2-11b-vision-instruct`. Pada uji, model 90B macet (tanpa jawaban) sementara 11B menjawab dalam ~1 detik; ketersediaan model gratis NVIDIA bisa berubah. Cek cepat: `npm run doctor -- --live`, atau uji tiap model dengan curl ke `/v1/chat/completions` (batas waktu 20 detik).
- Ganti model lewat env `NVIDIA_VISION_MODEL` (pilih yang bertanda *Free Endpoint* di build.nvidia.com/models). Bila model dihentikan, server membalas "Model NVIDIA tidak ditemukan: ...".
- Batas ukuran gambar inline untuk tiap model NVIDIA belum terverifikasi. Foto VGA ESP32 (20-50 KB) seharusnya aman; bila muncul "Gambar terlalu besar untuk NVIDIA", turunkan `frame_size` atau naikkan angka `jpeg_quality` di sketch.
