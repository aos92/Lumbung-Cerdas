# Skenario: ESP32 di hotspot HP Android, backend jalan di Termux (tanpa Render)

```
   HP Android
   ├─ Hotspot WiFi 2.4 GHz  ◄───────── ESP32 Central Unit  (http://<gateway>:9655, otomatis)
   ├─ Termux: node server.js  (HOST=0.0.0.0, PORT=9655)
   ├─ Aplikasi App Inventor   (http://127.0.0.1:9655)
   └─ Data seluler ───────────────────► internet: NVIDIA (pengenalan foto) + NTP (jam WIB)
```

Data sensor, klasifikasi, batas gas, dan dashboard berjalan **sepenuhnya lokal** (tanpa internet).
Internet hanya dipakai untuk dua hal: pengenalan foto oleh NVIDIA dan sinkron jam (NTP) di footer TFT.

## 1. Syarat dan batasan (baca dulu)

| Hal | Penjelasan |
|---|---|
| Internet HP harus dari **data seluler** | Kebanyakan HP Android tidak bisa menjadi klien WiFi sambil menjadi hotspot. Tanpa data seluler: sensor dan klasifikasi tetap jalan, tetapi foto gagal (`ERR\|Tidak bisa menghubungi NVIDIA`) dan jam footer tidak sinkron. |
| Hotspot harus **2.4 GHz**, sandi **WPA2** | ESP32 tidak mendukung 5 GHz dan WPA3-saja. Di pengaturan hotspot pilih band 2.4 GHz (Samsung: aktifkan "Maximize compatibility"). |
| Matikan **pemadaman hotspot otomatis** | Pengaturan hotspot → "Turn off automatically when no devices connected" = mati. |
| Termux harus tetap hidup | Pasang Termux dari **F-Droid** (versi Play Store usang). Pengaturan Android → Aplikasi → Termux → Baterai → **Tanpa batasan**. Jalankan lewat `npm run termux` (memanggil `termux-wake-lock`). Jangan "swipe" Termux dari aplikasi terbaru. |
| Data hilang bila Termux berhenti | Server menyimpan data di memori. Batas gas dikirim ulang oleh aplikasi dari TinyDB (lihat panduan App Inventor). |
| Pemakaian data seluler kecil | Hanya foto yang ke NVIDIA (puluhan KB per foto, bawaan 1 foto tiap 30 menit). Kiriman sensor ESP32 ke HP bersifat lokal, tidak memakai kuota. |

## 2. Memasang backend di Termux

```sh
pkg update && pkg upgrade -y
pkg install -y nodejs unzip nano
termux-setup-storage                      # izinkan akses penyimpanan
cd ~
unzip ~/storage/downloads/Lumbung-Cerdas-v5.zip
cd Lumbung-Cerdas
cp .env.example .env
nano .env
```

Isi `.env` (simpan: Ctrl+O, Enter, Ctrl+X):

```
NVIDIA_API_KEY=nvapi-xxxxxxxx
SHARED_SECRET=kata-sandi-rahasia-anda
HOST=0.0.0.0
PORT=9655
```

- `HOST=0.0.0.0` wajib agar ESP32 (perangkat lain) bisa menjangkau server. Bawaan `127.0.0.1` hanya menerima dari HP itu sendiri.
- `SHARED_SECRET` **wajib** bila `HOST` bukan loopback; server menolak start tanpanya. Nilainya sama dengan `API_KEY` di sketch dan `api_key` di App Inventor.

Cek lalu jalankan:

```sh
npm run doctor     # cek konfigurasi (tambahkan --live untuk uji key NVIDIA, butuh internet)
npm run termux     # jalankan server + mulai ulang otomatis bila berhenti
```

Keluaran yang benar: `[fruit] siap di http://0.0.0.0:9655 ...`. Hentikan dengan Ctrl+C.
Bila server mati kurang dari 10 detik setelah start, skrip berhenti dan menampilkan penyebabnya (biasanya `.env` salah).

## 2b. Versi proot-distro Debian (di dalam Termux)

proot memakai jaringan Android yang sama, jadi server di `0.0.0.0:9655` langsung terjangkau ESP32 lewat hotspot. Bedanya hanya di pemasangan:

```sh
# di Termux biasa
pkg install -y proot-distro
proot-distro install debian
proot-distro login debian --shared-tmp

# di dalam Debian (root)
cd /root && unzip /sdcard/Download/Lumbung-Cerdas-v5.zip -d . 2>/dev/null || true   # sesuaikan lokasi zip
cd Lumbung-Cerdas
sh scripts/setup-proot-debian.sh      # pasang curl/unzip/Node 22 + perbaiki DNS
cp .env.example .env && nano .env     # isi NVIDIA_API_KEY lengkap, SHARED_SECRET, HOST=0.0.0.0
npm run doctor                        # cek konfigurasi
npm run termux                        # jalankan; di proot skrip ini menyetel IPv4-first otomatis
```

Catatan khusus proot:

| Hal | Penjelasan |
|---|---|
| `termux-wake-lock` | Tidak ada di dalam proot. Buka sesi Termux **biasa** (geser dari kiri > New session), jalankan `termux-wake-lock`, lalu Baterai Termux = Tanpa batasan. |
| IP tidak terbaca | Di Android 11+ proot sering gagal membaca daftar IP. Server tetap jalan; pakai baris `Gateway (= HP)` di Serial Monitor ESP32. |
| `ENOTFOUND` / foto macet ke NVIDIA | `setup-proot-debian.sh` mengisi `/etc/resolv.conf`; `npm run termux` memaksa DNS IPv4-first (`--dns-result-order=ipv4first`). |
| Uji server yang sedang jalan | Di sesi proot lain: `npm run doctor:local` (cek `/health`, `/api/latest`, dan SHARED_SECRET). |
| Log request | Tiap request tampil `[req] <ip> GET /api/latest -> 200`. Matikan dengan `LOG_REQUESTS=0` di `.env`. |

## 2c. ESP32 restart terus (`rst:0x1 (POWERON_RESET)` berulang)

`POWERON_RESET` adalah reset **perangkat keras**, bukan crash kode (crash tampil sebagai `PANIC`/`WDT` dengan backtrace). Penyebab tersering: catu daya jatuh saat WiFi mengirim, kabel USB tipis/panjang, port USB HP/hub lemah, atau `EN` kena derau. Central Unit versi ini:

- mencetak **penyebab restart terakhir** saat boot (`Penyebab restart terakhir: ...`);
- menurunkan daya pancar WiFi (`WIFI_TX_POWER`) untuk mengurangi lonjakan arus;
- punya `DISABLE_BROWNOUT`: set `0` untuk diagnosa. Bila Serial lalu menampilkan `BROWNOUT`, penyebabnya pasti catu daya (pakai adaptor 5 V >= 1 A, kabel pendek, tambahkan kapasitor 470-1000 uF antara 5V dan GND dekat ESP32).

Bila restart tetap ada **tanpa** TFT dan Sub Unit terpasang, kodenya bukan penyebab.

## 3. Mengatur ESP32 Central Unit

Di `esp32/central_unit/central_unit.ino`:

```cpp
const char* WIFI_SSID     = "NamaHotspotHP";        // nama hotspot HP
const char* WIFI_PASSWORD = "SandiHotspot";
const char* BACKEND_URL   = "auto";                 // alamat HP diambil otomatis dari gateway WiFi
#define BACKEND_PORT 9655
const char* API_KEY       = "kata-sandi-rahasia-anda";   // = SHARED_SECRET
```

Mode `"auto"` memakai alamat gateway WiFi, yang di hotspot adalah HP itu sendiri (misalnya `192.168.43.1`),
sehingga tetap benar walau Android mengubah IP hotspot. Mode lain (`https://...onrender.com` atau `http://IP:PORT`) tetap bisa dipakai.

## 4. Mengatur aplikasi App Inventor

Di blok global `base_url`:

| Aplikasi berjalan di | `base_url` |
|---|---|
| **HP yang sama** dengan Termux | `http://127.0.0.1:9655` |
| HP lain yang tersambung ke hotspot itu | `http://<IP hotspot>:9655` (mis. `http://192.168.43.1:9655`) |

Alamatnya `http://` (bukan `https://`) dan tanpa `/` di akhir.

## 5. Uji berurutan

1. Di Termux server menyala (`siap di http://0.0.0.0:9655`).
2. Dari perangkat lain yang tersambung ke hotspot (mis. laptop), buka `http://<IP hotspot>:9655/health`. Harus tampil `{"status":"ok",...}`. Ini membuktikan hotspot dan server bisa dijangkau.
3. Nyalakan ESP32 Central. Di Serial Monitor: `[HTTP] sensors code=200`. Di TFT badge berubah ke **LIVE**.
4. Buka aplikasi: badge LIVE dan nilai sensor tampil.
5. Buka-tutup pintu: Serial menampilkan `[HTTP] fruit code=200 ...` (butuh data seluler).

## 6. Masalah umum

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| TFT badge **NO WIFI** terus | SSID/sandi salah, hotspot 5 GHz, atau WPA3-saja | Perbaiki bagian 1 dan 3 |
| Serial: `[HTTP] sensors code=-1` | Server tidak menyala / `HOST` masih `127.0.0.1` / port beda | Pastikan `HOST=0.0.0.0` dan `PORT` sama dengan `BACKEND_PORT` |
| `code=401` | `API_KEY` di sketch tidak sama dengan `SHARED_SECRET` | Samakan (huruf besar/kecil berpengaruh) |
| `/health` dari laptop gagal tetapi dari HP bisa | Server masih di `127.0.0.1` | Ubah `HOST=0.0.0.0` lalu jalankan ulang |
| Foto: `ERR\|Tidak bisa menghubungi NVIDIA: ENOTFOUND` | HP tidak punya internet (data seluler mati / kuota habis) | Nyalakan data seluler |
| TFT footer "MENYINKRONKAN WAKTU..." | NTP butuh internet | Sama di atas |
| Server berhenti saat layar mati | Android menidurkan Termux | Baterai Termux "Tanpa batasan"; jalankan lewat `npm run termux`; biarkan notifikasi Termux terlihat |
| Badge **OFFLINE** padahal ESP32 menyala | Hotspot mati otomatis lalu ESP32 belum tersambung kembali | Matikan auto-off hotspot; ESP32 mencoba tersambung ulang tiap 10 detik |
