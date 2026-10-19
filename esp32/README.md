# Firmware ESP32 Lumbung Cerdas (satu kotak)

Dua papan: **Central Unit** (ESP32 WROOM-32D) dan **Sub Unit 1** (ESP32-CAM). Belum diuji di perangkat keras.

```
esp32/central_unit/central_unit.ino            sensor, TFT, WiFi, master UART, unggah ke backend
esp32/sub_unit_1/sub_unit_1.ino                ESP32-CAM, foto atas perintah Central
```

## Central Unit (ESP32 WROOM-32D)

| GPIO | Fungsi | Tersambung ke |
|---|---|---|
| 15 | TFT CS | CS layar |
| 4 | TFT RST | RESET layar |
| 2 | TFT DC | DC/RS layar |
| 23 | TFT MOSI | SDI/MOSI layar |
| 18 | TFT SCK | SCK layar |
| 19 | TFT MISO | SDO/MISO layar |
| 36 (VP) | MQ-135 (AO) | tengah pembagi tegangan |
| 39 (VN) | MQ-4 (AO) | tengah pembagi tegangan |
| 34 | MQ-3 (AO) | tengah pembagi tegangan |
| 32 | Reed switch pintu | satu kaki reed, kaki lain ke GND (`INPUT_PULLUP`) |
| 27 | DHT22 data | pin data DHT22 |
| 16 (RX2) | UART dari CAM | TX (GPIO1/U0T) ESP32-CAM |
| 17 (TX2) | UART ke CAM | RX (GPIO3/U0R) ESP32-CAM |
| 33 | Peltier (keluaran) | gate MOSFET logic-level atau modul relay; HIGH = ON (`OUTPUT_ACTIVE_HIGH`) |
| 14 | Kipas (keluaran) | gate MOSFET logic-level atau modul relay; HIGH = ON |

Pin cadangan lain: 13, 22, 21, 25, 26, dan 35 (input saja, tanpa pull-up internal). GPIO14 mengeluarkan sinyal PWM singkat saat boot, jadi kipas bisa berkedip sesaat; beri pull-down 10k dari gate ke GND.

**TFT ILI9341:** VCC ke 3V3, GND ke GND, LED/BL ke 3V3. Pin T_CLK, T_CS, T_DIN, T_DO, T_IRQ dibiarkan kosong.
Pin TFT diatur di `User_Setup.h` di library TFT_eSPI harus: driver ILI9341, MISO 19, MOSI 23, SCLK 18, CS 15, DC 2, RST 4, dan font GLCD, FONT2, FONT4 aktif. Bukan di sketch.

**MQ-135, MQ-4, MQ-3:** VCC ke 5V, GND ke GND. AO tidak boleh langsung ke ESP32. Pembagi tegangan per sensor:
```
AO ── 10k ──┬── GPIO (36/39/34)
            ├── 100nF ── GND
            └── 20k ──── GND
```
Sketch mengalikan tegangan ADC dengan 1.5 (30k/20k) untuk mendapat tegangan AO asli. ADC jenuh sekitar 3.1 V di pin, atau sekitar 4.65 V di AO.

**DHT22:** VCC ke 3V3, GND ke GND, data ke GPIO27 (pull-up 10k ke 3V3 bila bukan modul 3 pin). Letakkan jauh dari MQ dan ESP32-CAM.

**Reed switch:** GPIO32 ke reed, reed ke GND. Pintu tertutup = LOW, terbuka = HIGH. Satu siklus buka lalu tutup memicu foto.

## Kontrol kipas dan Peltier (setpoint dari aplikasi)

Lima setpoint (CO2, metana, alkohol dalam ppm; suhu dalam °C; kelembaban dalam %) diisi di aplikasi Android, disimpan di backend (`/api/setpoints`),
diambil Central Unit tiap 30 detik, dan disalin ke flash ESP32 (NVS) sehingga tetap berlaku saat WiFi atau server mati. Bawaan sampai aplikasi mengirim:
CO2 2500, metana 100, alkohol 50, suhu 25, kelembaban 85.

| Kondisi | Kipas (GPIO14) | Peltier (GPIO33) |
|---|---|---|
| suhu >= setpoint suhu | ON | ON (mendinginkan) |
| suhu <= setpoint suhu (di bawah) | mati bila gas dan kelembaban juga di bawah setpoint | OFF |
| CO2 atau metana atau alkohol >= setpointnya | ON segera (buang gas) | tidak berubah |
| kelembaban >= setpoint kelembaban | ON | tidak berubah |

Agar tidak bolak-balik di sekitar setpoint dipakai histeresis (suhu 0.5 °C, kelembaban 2 %, gas 5 % dari setpoint) dan kipas/Peltier yang sudah ON
bertahan minimal 10 detik (`OUTPUT_MIN_ON_MS`). Semuanya bisa diubah di bagian konfigurasi `central_unit.ino`. Klasifikasi foto/sensor hanya untuk
tampilan **Mode Buah**. Layar menampilkan status keluaran yang sebenarnya (`PELTIER ON/OFF`, `AUTO (ON/OFF)`) dan Central melaporkannya ke backend.

Sakelar penting: `PELTIER_COOLING` (1 = Peltier ON saat suhu di atas setpoint; 0 = ON saat di bawah), `HUM_CONTROLS_FAN`, `AUTO_KONTROL` (0 = hanya hitung dan tampilkan, pin tidak digerakkan).
Peltier TEC1-12706 wajib memakai heatsink dengan kipas di sisi panas dan driver arus besar (MOSFET/relay), bukan dari pin ESP32 langsung.

## Sub Unit 1 (ESP32-CAM)

| ESP32-CAM | Tersambung ke |
|---|---|
| 5V | rail 5V |
| GND | GND bersama |
| U0T (GPIO1) | GPIO16 Central |
| U0R (GPIO3) | GPIO17 Central |

GPIO0 CAM ke GND hanya saat upload kode, lalu dilepas dan tekan RESET. Lepas adaptor USB-serial saat dipasang ke Central.

### Protokol UART (921600 baud, 8N1)

| Arah | Isi |
|---|---|
| Central -> CAM | `CAP\n` |
| CAM -> Central | `0xAA 0x55` + panjang JPEG 4 byte little-endian + data JPEG |
| CAM gagal | `0xAA 0x55 00 00 00 00` |
| Central -> CAM | `PING\n`, CAM membalas `PONG\n` (uji koneksi saat boot) |

Central membuang byte sampah (log boot CAM) sampai menemukan `0xAA 0x55`, lalu memeriksa awal `FF D8` dan akhir `FF D9`. Ukuran maksimum JPEG 60000 byte (`MAX_JPEG_BYTES` di CAM, `JPEG_MAX_BYTES` 61440 di Central); bila lebih besar CAM menaikkan angka kualitas (kompresi lebih kuat) sampai muat.

## Catu daya

Satu adaptor 5V minimal 3A. Rail 5V ke VIN/5V ESP32, VCC tiga MQ, dan 5V ESP32-CAM. Rail 3V3 (dari ESP32) ke TFT dan DHT22. Semua GND disatukan di satu titik. Kapasitor 470-1000 uF dekat ESP32-CAM dan dekat ESP32.

## Pin yang tidak boleh dipakai

- GPIO 6-11: flash internal.
- GPIO 1 dan 3 pada Central: USB serial (upload dan monitor).
- GPIO 0 dan 12: strapping, jangan ditahan saat boot.
- GPIO 2 (TFT DC) dan 15 (TFT CS) juga pin strapping. Bila upload gagal, cabut kabel DC sebentar saat upload.
- ADC2 (4, 0, 2, 15, 13, 12, 14, 27, 25, 26) tidak dipakai untuk sensor analog. Ketiga MQ ada di ADC1, aman saat WiFi menyala.

## Langkah pertama

1. Pasang TFT_eSPI (dengan `User_Setup.h` sesuai pin di atas), DHT sensor library, Adafruit Unified Sensor.
2. Upload `sub_unit_1` ke ESP32-CAM (Board "AI Thinker ESP32-CAM", PSRAM Enabled, Core Debug Level None).
3. Isi `WIFI_SSID`, `WIFI_PASSWORD`, `BACKEND_URL`, `API_KEY` di `central_unit.ino`, upload ke WROOM-32D (Board "ESP32 Dev Module").
4. Boot di udara bersih: Central memanaskan sensor 60 detik lalu mengalibrasi R0 tiap MQ. Salin nilai R0 dari Serial Monitor ke `R0_MQ135`, `R0_MQ4`, `R0_MQ3` agar kalibrasi tidak bergantung udara saat boot.
5. Serial Monitor 115200: `c` = foto sekarang, `r` = kalibrasi ulang, `i` = info sensor, setpoint, dan status kipas/Peltier.
6. Isi lima setpoint di aplikasi; Serial Monitor menampilkan `[setpoint] baru: ...` dalam ±30 detik.

## Catatan jujur

- Pemanasan awal MQ sebenarnya 24-48 jam; 60 detik hanya cukup untuk uji. Nilai ppm adalah perkiraan dari kurva pustaka, bukan pengukuran terkalibrasi.
- `CO2_BASELINE_PPM` (400) ditambahkan karena rumus MQ-135 mengembalikan selisih. Rumus MQ-3 pustaka berunit mg/L; sketch mengalikannya dengan `ALCOHOL_SCALE` = 530 (1 mg/L etanol ≈ 530 ppm) agar sama dengan satuan ppm di setpoint dan batas aplikasi. Sketch uji di `test/mq3` masih menampilkan mg/L.
- TLS memakai `setInsecure()` (tanpa verifikasi sertifikat) agar tidak perlu menanam CA yang kedaluwarsa. API key tetap terkirim lewat HTTPS.
- Render gratis tidur saat sepi; Central memanggil `/health` dulu sebelum mengunggah foto.

## Foto di aplikasi

Foto dari ESP32-CAM diunggah Central Unit ke `POST /api/fruit`; backend menyimpannya (walau analisis AI gagal) dan aplikasi menampilkannya lewat `GET /api/image`.
Ketik `g` di Serial Monitor untuk mengecek foto terakhir di backend (kode HTTP, ukuran, id foto).
