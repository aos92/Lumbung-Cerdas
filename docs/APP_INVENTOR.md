# Panduan MIT App Inventor — Lumbung Cerdas (dashboard sama dengan gambar desain + batas gas)

Layar utama aplikasi **meniru gambar desain dashboard** dan **identik dengan tampilan TFT Central Unit**:
header biru "LUMBUNG CERDAS ! MONITORING" + LIVE, kartu SUHU INTERNAL dan KELEMBABAN (RH) dengan bar,
panel EMISI GAS BUMI, panel KONDISI & PREDIKSI AI (Pendingin, Sirkulasi, Mode Buah), dan footer hari/tanggal/jam WIB.
Di bawah dashboard ada bagian **batas min/maks gas** (8 TextBox) dan **setpoint kontrol** (5 TextBox: CO2, metana, alkohol, suhu, kelembaban; bagian 5A).

Dashboard digambar di satu **Canvas** memakai koordinat yang sama dengan TFT (kanvas desain **320 x 240**), diskalakan
otomatis ke lebar layar ponsel. Pratinjau: `docs/Pratinjau_Tampilan.png`.

- Endpoint yang dipakai: `GET /api/latest?format=text`, `GET|POST /api/limits?format=text`, `GET|POST /api/setpoints?format=text`, dan (opsional, uji)
  `POST /api/sensors?format=text`.
- Semua permintaan memakai header `x-api-key` (= `SHARED_SECRET` di server), diatur **lewat blok** di `Screen1.Initialize`.
- Semua `GotText` memakai pembanding `responseCode = 200`; selain 200, isi balasan (`ERR|pesan`) ditampilkan apa adanya.
- Seluruh blok ditulis lengkap. Tidak ada "sama dengan yang di atas".
- Arsip ini tidak berisi berkas `.aia`; buat layar sesuai bagian 1 lalu susun blok sesuai bagian 2 sampai 7.

## Perbedaan yang disengaja dari gambar desain

| Pada gambar | Pada alat/aplikasi | Alasan |
|---|---|---|
| Baris `C2H4 (Etilen)` | `C2H5OH (Etanol)` | Alat **tidak punya sensor etilen**; sensor ketiga adalah MQ-3 (alkohol/etanol). Menampilkan nilai MQ-3 sebagai "etilen" menyesatkan. |
| `CO2 (Karbon dioksida)` | `CO2 (Karbon)` | Teks panjang tidak muat di panel 153 px pada TFT 320 px. Aplikasi memakai teks yang sama agar identik. |
| `AUTO (LOW)` | `AUTO (ON)` / `AUTO (OFF)` | Kipas hanya hidup/mati (transistor), tidak ada kecepatan. |
| Hanya 3 gas | Amonia (MQ-135) tetap dipakai klasifikasi, ditampilkan di bawah dashboard | Gambar tidak punya baris amonia. |

Tanda `!` di judul dan footer dibuat persis seperti gambar (ganti teksnya bila itu sebenarnya titik pemisah).

## 0. Cara membaca notasi blok

| Notasi di panduan | Blok di App Inventor (drawer) |
|---|---|
| `when X.Event` | Blok event komponen `X` |
| `to NamaProc p1 p2` | Procedures → *to procedure do* (atau *to procedure result* bila ada `(returns)`) |
| `call Proc a: … b: …` | Procedures → *call Proc* dengan soket bernama |
| `initialize local v to … in` | Variables → *initialize local … in* (versi *do* untuk statement, versi *return* untuk ekspresi) |
| `get v` / `set v to` | Variables → *get* / *set* |
| `get global v` / `set global v to` | Variables → *get global* / *set global* |
| `split text … at "\|"` | Text → *split* (pilih *split*, bukan *split at first*) |
| `select list item list … index …` | Lists → *select list item* |
| `length of list …` / `length …` | Lists → *length of list* / Text → *length* |
| `replace all text … segment … replacement …` | Text → *replace all* |
| `join a b c` | Text → *join* (klik gerigi untuk tambah soket) |
| `for each i from a to b by c` | Control → *for each number from* |
| `if … then … else if … else …` | Control → *if* (gerigi: *else if* / *else*). Versi bernilai (untuk `(returns)`) = *if then else* (ekspresi) |
| `make a list …` | Lists → *make a list* |
| `make color (make a list r g b)` | Colors → *make color* dengan *make a list* berisi tiga angka |
| `is number? x` | Math → *is number?* |
| `is a list? x` | Lists → *is a list?* |
| `format as decimal number x places n` | Math → *format as decimal* |
| `min` / `max` / `round` | Math → *min* / *max* / *round* |

---

## 1. Designer

Atur **Screen1**: `BackgroundColor Black`, `Scrollable true`, `TitleVisible false`, `AlignHorizontal Center`.

### Komponen non-visual

| Komponen | Tipe | Properti penting |
|---|---|---|
| `Web_Latest` | Web | `Timeout 60000` (Render gratis bisa ~1 menit untuk bangun) |
| `Web_Batas` | Web | `Timeout 60000` |
| `Web_Setpoint` | Web | `Timeout 60000` (bagian 5A) |
| `Web_Uji` | Web | `Timeout 60000` — **sementara**, hanya untuk uji (bagian 7) |
| `Clock1` | Clock | `TimerInterval 5000`, `TimerEnabled true`, `TimerAlwaysFires false` (ambil data) |
| `Clock_Jam` | Clock | `TimerInterval 1000`, `TimerEnabled true`, `TimerAlwaysFires false` (jam footer + titik LIVE berkedip) |
| `TinyDB1` | TinyDB | `Namespace "LumbungCerdas"` |
| `Notifier1` | Notifier | — |

Satu Web **per jenis permintaan**: jangan memakai satu Web untuk dua permintaan yang bisa jalan bersamaan.

### Komponen tampilan (urut dari atas)

| Komponen | Tipe | Properti |
|---|---|---|
| `Canvas_Dash` | Canvas | `Width Fill parent`, `Height 300` (diatur ulang lewat blok menjadi 3/4 lebar), `BackgroundColor Black` |
| `Img_Foto` | Image | `Width Fill parent`, `Height 240`, `ScalePictureToFit true`, `Visible false` (baru tampil setelah ada foto; bagian 4.6) |
| `Lbl_Koneksi` | Label | `FontSize 12`, `TextColor Gray`, `Width Fill parent` |
| `Lbl_JudulBatas` | Label | Teks "BATAS GAS (ppm)", `TextColor Cyan`, `FontBold true` |
| `TxtAlkoholMin`, `TxtAlkoholMaks` | TextBox | `NumbersOnly true`, `BackgroundColor Dark Gray`, `TextColor White`, Hint "Alkohol min/maks (ppm)" |
| `TxtCO2Min`, `TxtCO2Maks` | TextBox | sama, Hint "CO2 min/maks (ppm)" |
| `TxtMetanaMin`, `TxtMetanaMaks` | TextBox | sama, Hint "Metana min/maks (ppm)" |
| `TxtAmoniaMin`, `TxtAmoniaMaks` | TextBox | sama, Hint "Amonia min/maks (ppm)" |
| `Btn_Simpan` | Button | Teks "Simpan batas" |
| `Lbl_StatusBatas` | Label | `TextColor White` |
| `Lbl_InfoAmonia` | Label | `TextColor Cyan` (nilai dan status amonia) |
| `Btn_UjiSensor` | Button | Teks "Uji kirim sensor" — **sementara** (bagian 7) |

Arti batas per gas (ppm): nilai ≤ **min** → `normal`; di antara → `waspada`; ≥ **maks** → `tinggi`.
Bawaan server: alkohol 5–50, CO2 800–2500, metana 5–100, amonia 5–50.

### Tata letak dashboard (satuan desain 320 x 240, sama dengan TFT)

| Elemen | x | y | lebar x tinggi |
|---|---|---|---|
| Bingkai luar (2 garis) | 0 / 1 | 0 / 1 | 320x240 / 318x238 |
| Header (isi biru tua) | 3 | 3 | 314x31, garis cyan di y = 35 |
| Kartu Suhu | 5 | 40 | 153x63 |
| Kartu Kelembapan | 163 | 40 | 152x63 |
| Panel Emisi Gas | 5 | 109 | 153x90 |
| Panel Kondisi & Prediksi AI | 163 | 109 | 152x90 |
| Footer (teks tengah) | — | 204 | x 6 s.d. 314 |

Warna: bingkai biru (24,96,255), header (8,34,140), cyan (0,230,255), cyan redup (0,140,210), angka (170,245,255),
lime (190,255,0), hijau (0,255,0), oranye (255,160,0), kuning (255,235,0), magenta (255,0,255), merah (255,0,0), abu (110,110,110).

---

## 2. Variabel global

```
initialize global base_url         to "https://NAMA-SERVICE.onrender.com"
initialize global api_key          to "ISI_SHARED_SECRET"
initialize global sedang_latest    to false
initialize global sedang_batas     to false
initialize global batas_senyap     to true
initialize global tick             to 0
initialize global batas_basi_detik to 30
initialize global skala            to 0
initialize global skala_font       to 1
initialize global blink            to false
initialize global badge            to "OFFLINE"
initialize global data             to create empty list
initialize global hari             to make a list "MINGGU" "SENIN" "SELASA" "RABU" "KAMIS" "JUMAT" "SABTU"
initialize global nama_batas       to make a list
    "alkohol_min" "alkohol_maks" "co2_min" "co2_maks"
    "metana_min"  "metana_maks"  "amonia_min" "amonia_maks"
initialize global batas_bawaan     to make a list 5 50 800 2500 5 100 5 50
initialize global sedang_sp        to false
initialize global sp_senyap        to true
initialize global nama_sp          to make a list "co2" "metana" "alkohol" "suhu" "kelembaban"

initialize global c_bg        to make color (make a list 0 0 0)
initialize global c_frame     to make color (make a list 24 96 255)
initialize global c_hdr       to make color (make a list 8 34 140)
initialize global c_cyan      to make color (make a list 0 230 255)
initialize global c_cyan_dim  to make color (make a list 0 140 210)
initialize global c_num       to make color (make a list 170 245 255)
initialize global c_lime      to make color (make a list 190 255 0)
initialize global c_green     to make color (make a list 0 255 0)
initialize global c_orange    to make color (make a list 255 160 0)
initialize global c_yellow    to make color (make a list 255 235 0)
initialize global c_magenta   to make color (make a list 255 0 255)
initialize global c_red       to make color (make a list 255 0 0)
initialize global c_red_redup to make color (make a list 90 0 0)
initialize global c_grey      to make color (make a list 110 110 110)
```

- `base_url` tanpa `/` di akhir. Render: `https://NAMA-SERVICE.onrender.com`. Backend di Termux pada HP yang sama:
  `http://127.0.0.1:9655` (lihat `docs/TERMUX.md`).
- `skala` = lebar kanvas / 320, dihitung saat menggambar. `skala_font` = kalibrasi ukuran teks (bagian 4.1).
- `foto_id` = "" (id foto terakhir yang sudah ditampilkan di `Img_Foto`, bagian 4.6).
- `data` = 26 kolom balasan `/api/latest` terakhir (bagian 4.2). `badge` = "LIVE" | "OFFLINE" | "NO NET".
- `sedang_latest` / `sedang_batas` mencegah dua permintaan menimpa satu komponen Web.
- `batas_basi_detik` = 30: Central Unit mengirim sensor tiap 10 detik; data lebih tua dari 30 detik berarti alat mati.

## 3. Screen1.Initialize dan Clock

```
when Screen1.Initialize
    set Web_Latest.RequestHeaders to make a list
        make a list "x-api-key" (get global api_key)
    set Web_Batas.RequestHeaders to make a list
        make a list "x-api-key" (get global api_key)
    set Web_Setpoint.RequestHeaders to make a list
        make a list "x-api-key" (get global api_key)
    set Web_Uji.RequestHeaders to make a list
        make a list "x-api-key" (get global api_key)
    initialize local tersimpan to
        call TinyDB1.GetValue tag: "batas" valueIfTagNotThere: (get global batas_bawaan)
    in
        call Procedure_IsiTextBox values: (get tersimpan)
        // server menyimpan batas di memori (hilang saat tidur/restart): kirim ulang dari ponsel
        call Procedure_KirimBatas values: (get tersimpan) senyap: true
    // setpoint: hanya dikirim bila pernah disimpan dari aplikasi. Tanpa itu server tetap di bawaan dan ESP32
    // mempertahankan nilai di flash-nya (jangan mengirim nilai bawaan karena akan menimpa setpoint alat)
    initialize local sp to call TinyDB1.GetValue tag: "setpoint" valueIfTagNotThere: ""
    in
        if is a list? (get sp) then
            call Procedure_IsiSp values: (get sp)
            call Procedure_KirimSp values: (get sp) senyap: true
    call Procedure_PanggilLatest

when Clock1.Timer
    call Procedure_PanggilLatest
    set global tick to (get global tick) + 1
    if (get global tick) ≥ 12 then
        set global tick to 0
        // sinkron ulang tiap ±60 detik, memakai batas yang TERSIMPAN (bukan isi TextBox yang sedang diketik)
        call Procedure_KirimBatas
            values: call TinyDB1.GetValue tag: "batas" valueIfTagNotThere: (get global batas_bawaan)
            senyap: true
        // setpoint: sama, hanya bila sudah pernah disimpan
        initialize local sp to call TinyDB1.GetValue tag: "setpoint" valueIfTagNotThere: ""
        in
            if is a list? (get sp) then
                call Procedure_KirimSp values: (get sp) senyap: true

when Clock_Jam.Timer
    set global blink to not (get global blink)
    if (get global skala) = 0 then
        call Procedure_GambarDashboard          // gambar penuh pertama kali (menunggu lebar kanvas tersedia)
    else
        call Procedure_GambarBadge
        call Procedure_GambarJam

when Screen1.ErrorOccurred (component, functionName, errorNumber, message)
    set global sedang_latest to false
    set global sedang_batas to false
    set global sedang_sp to false
    set global badge to "NO NET"
    set Lbl_Koneksi.Text to join "Gangguan koneksi: " (get message)
    set Lbl_Koneksi.TextColor to red
    call Procedure_GambarDashboard
```

`RequestHeaders` adalah **daftar berisi daftar**: satu daftar luar, di dalamnya satu pasangan (`"x-api-key"`, nilai kunci).

---

## 4. Dashboard

### 4.1 Procedure menggambar (semua koordinat dalam satuan desain 320 x 240)

```
to Procedure_Kotak x y w h warna isi radius
    set Canvas_Dash.PaintColor to (get warna)
    call Canvas_Dash.DrawRect
        left:   (get x) * (get global skala)
        top:    (get y) * (get global skala)
        right:  ((get x) + (get w)) * (get global skala)
        bottom: ((get y) + (get h)) * (get global skala)
        fill:   (get isi)
        radius: (get radius) * (get global skala)

to Procedure_Garis x1 y1 x2 y2 warna
    set Canvas_Dash.PaintColor to (get warna)
    call Canvas_Dash.DrawLine
        x1: (get x1) * (get global skala)   y1: (get y1) * (get global skala)
        x2: (get x2) * (get global skala)   y2: (get y2) * (get global skala)

to Procedure_Lingkaran x y r warna
    set Canvas_Dash.PaintColor to (get warna)
    call Canvas_Dash.DrawCircle
        centerX: (get x) * (get global skala)
        centerY: (get y) * (get global skala)
        radius:  (get r) * (get global skala)
        fill:    true

to Procedure_Teks teks x y ukuran warna rata
    // y = tepi ATAS teks; Canvas menggambar pada garis dasar, jadi ditambah 0,8 x ukuran
    // rata: 0 = kiri, 1 = tengah, 2 = kanan
    set Canvas_Dash.PaintColor to (get warna)
    set Canvas_Dash.FontSize to (get ukuran) * (get global skala) * (get global skala_font)
    set Canvas_Dash.TextAlignment to (get rata)
    call Canvas_Dash.DrawText
        text: (get teks)
        x: (get x) * (get global skala)
        y: ((get y) + 0.8 * (get ukuran)) * (get global skala)

to Procedure_Bar x y w h frac warna
    call Procedure_Kotak x: (get x) y: (get y) w: (get w) h: (get h) warna: (get global c_cyan_dim) isi: false radius: 0
    initialize local fw to round (((get w) - 2) * (min 1 (max 0 (get frac))))
    in
        if (get fw) > 0 then
            call Procedure_Kotak x: (get x) + 1 y: (get y) + 1 w: (get fw) h: (get h) - 2 warna: (get warna) isi: true radius: 0
```

- Bila blok `DrawRect` di versi App Inventor Anda **tidak punya soket `radius`**, hapus soket itu dari panggilan
  (sudut panel menjadi siku, selebihnya sama).
- Ukuran teks dalam satuan desain: kecil = **11**, sedang = **22**, besar (angka) = **33**, judul/mode/footer = **16**.
- **Kalibrasi teks:** bila teks tampak jauh lebih besar atau kecil dari panelnya di ponsel Anda, ubah `skala_font`
  (mis. 0.8 atau 1.25). Cukup satu angka ini; semua teks ikut berubah.

### 4.2 Isi balasan `/api/latest?format=text` (26 kolom, dipisah `|`, `-` bila kosong)

| # | Isi | Dipakai di | # | Isi | Dipakai di |
|---|---|---|---|---|---|
| 1 | nama buah | — | 14 | klasifikasi sensor | — |
| 2 | nutrisi | — | 15 | indeks pembusukan sensor (0–100) | — |
| 3 | skor kesehatan makanan | — | 16 | status alkohol | — |
| 4 | tingkat risiko | — | 17 | status CO2 | — |
| 5 | indeks risiko | — | 18 | status metana | — |
| 6 | **CO2** (ppm) | baris CO2 | 19 | status amonia | `Lbl_InfoAmonia` |
| 7 | amonia (ppm) | `Lbl_InfoAmonia` | 20 | klasifikasi akhir (foto) | — |
| 8 | **alkohol** (ppm) | baris C2H5OH | 21 | umur data sensor (detik) | badge LIVE |
| 9 | **metana** (ppm) | baris CH4 | 22 | umur hasil foto (detik) | `Lbl_Koneksi` |
| 10 | **suhu** (°C) | kartu Suhu | 23 | **kondisi buah** (terburuk: foto vs sensor) | Mode Buah |
| 11 | **kelembapan** (%) | kartu Kelembapan | 24 | **Peltier** `ON`/`OFF` | Pendingin |
| 12 | status tren | — | 25 | **kipas** `ON`/`OFF` | Sirkulasi |
| 13 | perubahan signifikan | — | 26 | **id foto** terakhir (berubah tiap foto baru) | `Img_Foto` (bagian 4.6) |

`split` menghasilkan daftar berindeks **mulai 1**, jadi kolom nomor 7 = `select list item … index 7`.
Kolom 23 = klasifikasi yang **lebih buruk** antara foto terakhir dan sensor terkini (`segar` < `matang` < `mulai busuk` < `busuk`),
dihitung server; kolom 24 dan 25 dikirim Central Unit; semuanya `-` bila belum ada data.

### 4.3 Procedure pembantu

```
to Procedure_Nilai idx   (returns text)
    result:
        if (length of list (get global data)) ≥ (get idx)
        then select list item list (get global data) index (get idx)
        else "-"

to Procedure_Fmt1 v   (returns text)
    result:
        if is number? (get v) then format as decimal number (get v) places 1 else "--.-"

to Procedure_FmtPpm v   (returns text)
    result:
        if is number? (get v) then join (round (get v)) " PPM" else "-- PPM"

to Procedure_Frac v maks   (returns number)
    result:
        if is number? (get v) then (get v) / (get maks) else 0

to Procedure_ModeTeks kondisi   (returns text)
    result:
        if (get kondisi) = "segar"       then "OPTIMAL / SEGAR"
        else if (get kondisi) = "matang"      then "MATANG"
        else if (get kondisi) = "mulai busuk" then "MULAI BUSUK"
        else if (get kondisi) = "busuk"       then "BUSUK"
        else "MENUNGGU DATA"

to Procedure_ModeWarna kondisi   (returns color)
    result:
        if (get kondisi) = "segar"       then (get global c_green)
        else if (get kondisi) = "matang"      then (get global c_yellow)
        else if (get kondisi) = "mulai busuk" then (get global c_orange)
        else if (get kondisi) = "busuk"       then (get global c_red)
        else (get global c_grey)

to Procedure_TeksAktuator jenis nilai   (returns text)
    result:
        if (get nilai) = "ON" then
            (if (get jenis) = "peltier" then "PELTIER ON" else "AUTO (ON)")
        else if (get nilai) = "OFF" then
            (if (get jenis) = "peltier" then "PELTIER OFF" else "AUTO (OFF)")
        else "--"

to Procedure_WarnaAktuator jenis nilai   (returns color)
    result:
        if (get nilai) = "ON" then
            (if (get jenis) = "peltier" then (get global c_green) else (get global c_cyan))
        else if (get nilai) = "OFF" then (get global c_cyan_dim)
        else (get global c_grey)

to Procedure_AngkaKartu x angka satuan warnaSatuan frac warnaBar
    // angka besar (ukuran 33) + satuan (ukuran 22) di sebelah kanannya + bar di bawah
    call Procedure_Teks teks: (get angka) x: (get x) + 7 y: 58 ukuran: 33 warna: (get global c_num) rata: 0
    call Procedure_Teks teks: (get satuan)
        x: (get x) + 7 + ((length (get angka)) - 1) * 18 + 9 + 5
        y: 60 ukuran: 22 warna: (get warnaSatuan) rata: 0
    call Procedure_Bar x: (get x) + 7 y: 90 w: 139 h: 9 frac: (get frac) warna: (get warnaBar)
```

### 4.4 Menggambar dashboard penuh, badge, dan jam

```
to Procedure_GambarDashboard
    if Canvas_Dash.Width > 0 then
        set global skala to Canvas_Dash.Width / 320
        set Canvas_Dash.Height to 240 * (get global skala)
        call Canvas_Dash.Clear
        set Canvas_Dash.LineWidth to (max 1 (get global skala))

        // ---- bingkai dan header ----
        call Procedure_Kotak x: 0 y: 0 w: 320 h: 240 warna: (get global c_frame) isi: false radius: 7
        call Procedure_Kotak x: 1 y: 1 w: 318 h: 238 warna: (get global c_frame) isi: false radius: 6
        call Procedure_Kotak x: 3 y: 3 w: 314 h: 31 warna: (get global c_hdr) isi: true radius: 5
        call Procedure_Garis x1: 3 y1: 35 x2: 317 y2: 35 warna: (get global c_cyan_dim)
        call Procedure_Teks teks: "LUMBUNG CERDAS ! MONITORING" x: 10 y: 10 ukuran: 16 warna: (get global c_cyan) rata: 0
        call Procedure_GambarBadge

        // ---- empat panel ----
        call Procedure_Kotak x: 5   y: 40  w: 153 h: 63 warna: (get global c_frame) isi: false radius: 5
        call Procedure_Kotak x: 163 y: 40  w: 152 h: 63 warna: (get global c_frame) isi: false radius: 5
        call Procedure_Kotak x: 5   y: 109 w: 153 h: 90 warna: (get global c_frame) isi: false radius: 5
        call Procedure_Kotak x: 163 y: 109 w: 152 h: 90 warna: (get global c_frame) isi: false radius: 5
        call Procedure_Teks teks: "SUHU INTERNAL"          x: 12  y: 46  ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: "KELEMBABAN (RH)"        x: 170 y: 46  ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: "EMISI GAS BUMI"         x: 12  y: 115 ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: "KONDISI & PREDIKSI AI"  x: 170 y: 115 ukuran: 11 warna: (get global c_cyan) rata: 0

        // ---- suhu dan kelembapan (bar suhu 0-60 °C, bar kelembapan 0-100 %) ----
        call Procedure_AngkaKartu x: 5
            angka: (call Procedure_Fmt1 v: (call Procedure_Nilai idx: 10))
            satuan: "°C"  warnaSatuan: (get global c_lime)
            frac: (call Procedure_Frac v: (call Procedure_Nilai idx: 10) maks: 60)
            warnaBar: (get global c_green)
        call Procedure_AngkaKartu x: 163
            angka: (call Procedure_Fmt1 v: (call Procedure_Nilai idx: 11))
            satuan: "%"  warnaSatuan: (get global c_cyan)
            frac: (call Procedure_Frac v: (call Procedure_Nilai idx: 11) maks: 100)
            warnaBar: (get global c_cyan)

        // ---- emisi gas (nilai rata kanan di x = 151) ----
        call Procedure_Teks teks: "CO2 (Karbon)"     x: 12 y: 133 ukuran: 11 warna: (get global c_cyan)    rata: 0
        call Procedure_Teks teks: (call Procedure_FmtPpm v: (call Procedure_Nilai idx: 6))
                            x: 151 y: 133 ukuran: 11 warna: (get global c_cyan)    rata: 2
        call Procedure_Teks teks: "CH4 (Metana)"     x: 12 y: 149 ukuran: 11 warna: (get global c_orange)  rata: 0
        call Procedure_Teks teks: (call Procedure_FmtPpm v: (call Procedure_Nilai idx: 9))
                            x: 151 y: 149 ukuran: 11 warna: (get global c_yellow)  rata: 2
        call Procedure_Teks teks: "C2H5OH (Etanol)"  x: 12 y: 165 ukuran: 11 warna: (get global c_magenta) rata: 0
        call Procedure_Teks teks: (call Procedure_FmtPpm v: (call Procedure_Nilai idx: 8))
                            x: 151 y: 165 ukuran: 11 warna: (get global c_magenta) rata: 2

        // ---- kondisi dan prediksi AI ----
        call Procedure_Teks teks: "Pendingin :" x: 170 y: 133 ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: (call Procedure_TeksAktuator jenis: "peltier" nilai: (call Procedure_Nilai idx: 24))
                            x: 242 y: 133 ukuran: 11
                            warna: (call Procedure_WarnaAktuator jenis: "peltier" nilai: (call Procedure_Nilai idx: 24)) rata: 0
        call Procedure_Teks teks: "Sirkulasi :" x: 170 y: 149 ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: (call Procedure_TeksAktuator jenis: "kipas" nilai: (call Procedure_Nilai idx: 25))
                            x: 242 y: 149 ukuran: 11
                            warna: (call Procedure_WarnaAktuator jenis: "kipas" nilai: (call Procedure_Nilai idx: 25)) rata: 0
        call Procedure_Teks teks: "Mode Buah :" x: 170 y: 165 ukuran: 11 warna: (get global c_cyan) rata: 0
        call Procedure_Teks teks: (call Procedure_ModeTeks kondisi: (call Procedure_Nilai idx: 23))
                            x: 170 y: 178 ukuran: 16
                            warna: (call Procedure_ModeWarna kondisi: (call Procedure_Nilai idx: 23)) rata: 0

        call Procedure_GambarJam

to Procedure_GambarBadge
    // hapus area badge (kanan header) lalu gambar ulang; titik LIVE berkedip tiap detik
    call Procedure_Kotak x: 244 y: 6 w: 68 h: 26 warna: (get global c_hdr) isi: true radius: 0
    if (get global badge) = "LIVE" then
        call Procedure_Teks teks: "LIVE" x: 291 y: 14 ukuran: 11 warna: (get global c_cyan) rata: 2
        call Procedure_Lingkaran x: 303 y: 18 r: 5
            warna: (if (get global blink) then (get global c_red) else (get global c_red_redup))
    else if (get global badge) = "OFFLINE" then
        call Procedure_Teks teks: "OFFLINE" x: 291 y: 14 ukuran: 11 warna: (get global c_grey) rata: 2
        call Procedure_Lingkaran x: 303 y: 18 r: 5 warna: (get global c_grey)
    else
        call Procedure_Teks teks: "NO NET" x: 291 y: 14 ukuran: 11 warna: (get global c_orange) rata: 2
        call Procedure_Lingkaran x: 303 y: 18 r: 5 warna: (get global c_orange)

to Procedure_GambarJam
    // footer: HARI, dd/MM/yyyy ! HH:mm:ss WIB (waktu ponsel; atur zona waktu ponsel ke WIB)
    call Procedure_Kotak x: 6 y: 204 w: 308 h: 26 warna: (get global c_bg) isi: true radius: 0
    initialize local t to Clock_Jam.Now
    in
        call Procedure_Teks
            teks: join
                    (select list item list (get global hari) index (Clock_Jam.Weekday instant: (get t)))
                    ", "
                    (Clock_Jam.FormatDate instant: (get t) pattern: "dd/MM/yyyy")
                    " ! "
                    (Clock_Jam.FormatTime instant: (get t) pattern: "HH:mm:ss")
                    " WIB"
            x: 160 y: 208 ukuran: 16 warna: (get global c_cyan) rata: 1
```

`Clock.Weekday` bernilai 1 untuk Minggu sampai 7 untuk Sabtu, cocok dengan urutan daftar `hari`.
`FormatDate` dan `FormatTime` memakai pola numerik sehingga tidak bergantung bahasa ponsel.

### 4.5 Memanggil server dan menampilkan hasil

```
to Procedure_PanggilLatest
    if not (get global sedang_latest) then
        set global sedang_latest to true
        set Web_Latest.Url to join (get global base_url) "/api/latest?format=text"
        call Web_Latest.Get

when Web_Latest.GotText (url, responseCode, responseType, responseContent)
    set global sedang_latest to false
    if (get responseCode) = 200 then
        call Procedure_TampilLatest content: (get responseContent)
    else
        set global badge to "OFFLINE"
        set Lbl_Koneksi.Text to join "Server membalas HTTP " (get responseCode) ": " (get responseContent)
        set Lbl_Koneksi.TextColor to red
        call Procedure_GambarDashboard

when Web_Latest.TimedOut (url)
    set global sedang_latest to false
    set global badge to "NO NET"
    set Lbl_Koneksi.Text to "Server belum merespons (timeout). Render gratis butuh ~1 menit untuk bangun."
    set Lbl_Koneksi.TextColor to red
    call Procedure_GambarDashboard

to Procedure_TampilLatest content
    initialize local f to split text (get content) at "|"
    in
        if (length of list (get f)) ≥ 25 then
            set global data to (get f)
            // ---- status koneksi alat dari umur data sensor (kolom 21) ----
            initialize local umur to select list item list (get f) index 21
            in
                if not (is number? (get umur)) then
                    set global badge to "OFFLINE"
                    set Lbl_Koneksi.Text to "Belum ada data sensor dari alat"
                    set Lbl_Koneksi.TextColor to red
                else if (get umur) > (get global batas_basi_detik) then
                    set global badge to "OFFLINE"
                    set Lbl_Koneksi.Text to join "Alat tidak mengirim data (terakhir " (get umur) " detik lalu)"
                    set Lbl_Koneksi.TextColor to red
                else
                    set global badge to "LIVE"
                    set Lbl_Koneksi.Text to join "Terhubung. Data sensor " (get umur) " detik lalu. Foto: "
                                              (select list item list (get f) index 22) " detik lalu"
                    set Lbl_Koneksi.TextColor to gray
            // ---- amonia (tidak ada di gambar desain, tetap dipakai klasifikasi) ----
            set Lbl_InfoAmonia.Text to join "Amonia (MQ-135): " (select list item list (get f) index 7)
                                            " ppm, " (select list item list (get f) index 19)
        else
            set global badge to "OFFLINE"
            set Lbl_Koneksi.Text to join "Respons tidak dikenal: " (get content)
            set Lbl_Koneksi.TextColor to red
        call Procedure_GambarDashboard
```

### 4.6 Menampilkan foto terakhir (`GET /api/image`)

Komponen **Image** hanya menerima URL dan tidak bisa mengirim header `x-api-key`, jadi kunci dikirim lewat `?key=` (hanya
`/api/image` yang menerimanya). Kolom 26 = id foto; gambar dimuat ulang **hanya bila id berubah**. Blok ini disisipkan
**paling atas** di cabang `then` pada `if (length of list f) ≥ 25` di `Procedure_TampilLatest`:

```
if (length of list (get f)) ≥ 26  and  is number? (select list item (get f) index 26)
   and  (select list item (get f) index 26) ≠ (get global foto_id) then
    set global foto_id to (select list item list (get f) index 26)
    set Img_Foto.Picture to join (get global base_url) "/api/image?key=" (get global api_key)
                                 "&v=" (select list item list (get f) index 26)
    set Img_Foto.Visible to true
```

`&v=<id>` mencegah gambar lama tertahan di cache. Foto disimpan server di memori (hilang saat server tidur/restart):
sebelum ada foto, kolom 26 = `-` dan `Img_Foto` tetap tersembunyi.

Bila server membalas `ERR|…` (kurang dari 25 item), pesannya tampil di `Lbl_Koneksi`, dashboard tetap menampilkan data terakhir
dengan badge OFFLINE.

---

## 5. Batas min/maks (8 TextBox)

### 5.1 Mengambil dan mengisi TextBox

```
to Procedure_AmbilDariTextBox   (returns list)
    result:
        make a list
            replace all text (TxtAlkoholMin.Text)  segment "," replacement "."
            replace all text (TxtAlkoholMaks.Text) segment "," replacement "."
            replace all text (TxtCO2Min.Text)      segment "," replacement "."
            replace all text (TxtCO2Maks.Text)     segment "," replacement "."
            replace all text (TxtMetanaMin.Text)   segment "," replacement "."
            replace all text (TxtMetanaMaks.Text)  segment "," replacement "."
            replace all text (TxtAmoniaMin.Text)   segment "," replacement "."
            replace all text (TxtAmoniaMaks.Text)  segment "," replacement "."

to Procedure_IsiTextBox values
    set TxtAlkoholMin.Text  to select list item list (get values) index 1
    set TxtAlkoholMaks.Text to select list item list (get values) index 2
    set TxtCO2Min.Text      to select list item list (get values) index 3
    set TxtCO2Maks.Text     to select list item list (get values) index 4
    set TxtMetanaMin.Text   to select list item list (get values) index 5
    set TxtMetanaMaks.Text  to select list item list (get values) index 6
    set TxtAmoniaMin.Text   to select list item list (get values) index 7
    set TxtAmoniaMaks.Text  to select list item list (get values) index 8
```

Urutan 8 nilai harus sama dengan `nama_batas`: alkohol min, alkohol maks, CO2 min, CO2 maks, metana min, metana maks,
amonia min, amonia maks.

### 5.2 Mengirim ke server

```
to Procedure_KirimBatas values senyap
    if not (get global sedang_batas) then
        set global sedang_batas to true
        set global batas_senyap to (get senyap)
        initialize local url to join (get global base_url) "/api/limits?format=text"
        do
            for each i from 1 to 8 by 1
            do
                set url to join
                    get url
                    "&"
                    select list item list (get global nama_batas) index (get i)
                    "="
                    call Web_Batas.UriEncode text: (select list item list (get values) index (get i))
            set Web_Batas.Url to (get url)
            call Web_Batas.PostText text: ""

when Btn_Simpan.Click
    if get global sedang_batas then
        // sinkron latar (tiap ±60 detik) atau simpan sebelumnya masih berjalan: beri tahu, jangan diam
        set Lbl_StatusBatas.Text to "Masih menghubungi server, tekan Simpan lagi sebentar lagi"
        set Lbl_StatusBatas.TextColor to orange
    else
        set Lbl_StatusBatas.Text to "Menyimpan..."
        set Lbl_StatusBatas.TextColor to white
        call Procedure_KirimBatas values: (call Procedure_AmbilDariTextBox) senyap: false
```

`PostText` dengan isi kosong aman: semua nilai ada di query URL. TextBox yang dikosongkan **tidak mengubah** batas
yang sudah ada di server (nilai kosong diabaikan), tetapi bila **kesemua 8** kosong server menjawab
`ERR|Tidak ada nilai batas …` (HTTP 400). Bila `sedang_batas` masih `true`, klik Simpan menampilkan pesan oranye
"Masih menghubungi server"; tekan lagi setelah beberapa detik.

### 5.3 Balasan server

`responseContent` = `OK|alkohol_min|alkohol_maks|co2_min|co2_maks|metana_min|metana_maks|amonia_min|amonia_maks`
(nilai yang **berlaku di server**) bila 200; `ERR|pesan` bila 400 (misalnya minimal ≥ maksimal) atau 401.

```
when Web_Batas.GotText (url, responseCode, responseType, responseContent)
    set global sedang_batas to false
    if get global batas_senyap then
        // sinkron latar belakang: jangan ganggu TextBox yang sedang diketik
        do nothing
    else if (get responseCode) = 200 then
        initialize local f to split text (get responseContent) at "|"
        in
            if (select list item list (get f) index 1) = "OK" and (length of list (get f)) ≥ 9 then
                initialize local nilai to create empty list
                in
                    for each i from 2 to 9 by 1
                    do
                        add items to list list (get nilai) item (select list item list (get f) index (get i))
                    call Procedure_IsiTextBox values: (get nilai)
                    call TinyDB1.StoreValue tag: "batas" valueToStore: (get nilai)
                set Lbl_StatusBatas.Text to "Batas tersimpan di server dan ponsel"
                set Lbl_StatusBatas.TextColor to green
            else
                set Lbl_StatusBatas.Text to join "Balasan tak dikenal: " (get responseContent)
                set Lbl_StatusBatas.TextColor to red
    else
        set Lbl_StatusBatas.Text to join "Gagal simpan: " (get responseContent)
        set Lbl_StatusBatas.TextColor to red
        call Notifier1.ShowAlert notice: (get responseContent)

when Web_Batas.TimedOut (url)
    set global sedang_batas to false
    if not (get global batas_senyap) then
        set Lbl_StatusBatas.Text to "Waktu habis. Coba lagi (server mungkin sedang bangun)."
        set Lbl_StatusBatas.TextColor to red
```

Batas **hanya disimpan ke TinyDB setelah server menjawab `OK`**, jadi nilai yang salah tidak pernah tersimpan di ponsel.

---

## 5A. Setpoint kontrol (5 TextBox numerik)

Lima setpoint dikirim ke server dan **diterapkan di ESP32** untuk kipas dan Peltier:

| TextBox | Satuan | Fungsi di alat |
|---|---|---|
| `TxtSpCO2` | ppm | CO2 >= setpoint -> kipas ON (buang gas) |
| `TxtSpMetana` | ppm | metana >= setpoint -> kipas ON |
| `TxtSpAlkohol` | ppm | alkohol >= setpoint -> kipas ON |
| `TxtSpSuhu` | °C | suhu >= setpoint -> kipas ON dan Peltier ON; kembali di bawahnya -> mati |
| `TxtSpKelembaban` | % | kelembaban >= setpoint -> kipas ON |

Properti Designer kelima TextBox: `NumbersOnly true`, `Hint` sesuai nama. Tambahkan juga `Btn_SimpanSp` (Button, teks "Simpan setpoint"),
`Lbl_StatusSp` (Label) dan komponen non-visual `Web_Setpoint` (Web, `Timeout 60000`). Satu Web per jenis permintaan, sama seperti `Web_Batas`.

Rentang yang diterima server: CO2 1..10000, metana 1..10000, alkohol 1..5000, suhu -40..80, kelembaban 1..100. Di luar itu server menjawab `ERR|...` (400)
dan nilai lama tidak berubah. Bawaan server bila aplikasi belum pernah mengirim: CO2 2500, metana 100, alkohol 50, suhu 25, kelembaban 85.

Variabel global `sedang_sp`, `sp_senyap`, dan `nama_sp` sudah ada di bagian 2.

### 5A.1 Mengambil dan mengisi TextBox

```
to Procedure_AmbilSp   (returns list)
    result:
        make a list
            replace all text (TxtSpCO2.Text)        segment "," replacement "."
            replace all text (TxtSpMetana.Text)     segment "," replacement "."
            replace all text (TxtSpAlkohol.Text)    segment "," replacement "."
            replace all text (TxtSpSuhu.Text)       segment "," replacement "."
            replace all text (TxtSpKelembaban.Text) segment "," replacement "."

to Procedure_IsiSp values
    set TxtSpCO2.Text        to select list item list (get values) index 1
    set TxtSpMetana.Text     to select list item list (get values) index 2
    set TxtSpAlkohol.Text    to select list item list (get values) index 3
    set TxtSpSuhu.Text       to select list item list (get values) index 4
    set TxtSpKelembaban.Text to select list item list (get values) index 5
```

### 5A.2 Mengirim ke server

```
to Procedure_KirimSp values senyap
    if not (get global sedang_sp) then
        set global sedang_sp to true
        set global sp_senyap to (get senyap)
        initialize local url to join (get global base_url) "/api/setpoints?format=text"
        do
            for each i from 1 to 5 by 1
            do
                set url to join
                    get url
                    "&"
                    select list item list (get global nama_sp) index (get i)
                    "="
                    call Web_Setpoint.UriEncode text: (select list item list (get values) index (get i))
            set Web_Setpoint.Url to (get url)
            call Web_Setpoint.PostText text: ""

when Btn_SimpanSp.Click
    if get global sedang_sp then
        set Lbl_StatusSp.Text to "Masih menghubungi server, tekan Simpan lagi sebentar lagi"
        set Lbl_StatusSp.TextColor to orange
    else
        set Lbl_StatusSp.Text to "Menyimpan..."
        set Lbl_StatusSp.TextColor to white
        call Procedure_KirimSp values: (call Procedure_AmbilSp) senyap: false
```

TextBox yang dikosongkan tidak mengubah setpoint di server; bila kelimanya kosong server menjawab `ERR|Tidak ada setpoint ...` (400).

### 5A.3 Balasan server

`responseContent` = `OK|co2|metana|alkohol|suhu|kelembaban|custom`. Kolom `custom` = `1` bila nilai berasal dari aplikasi, `0` bila masih bawaan
server (mis. server baru bangun dari tidur). Isi TextBox hanya dari indeks 2 sampai 6.

```
when Web_Setpoint.GotText (url, responseCode, responseType, responseContent)
    set global sedang_sp to false
    if get global sp_senyap then
        do nothing
    else if (get responseCode) = 200 then
        initialize local f to split text (get responseContent) at "|"
        in
            if (select list item list (get f) index 1) = "OK" and (length of list (get f)) ≥ 6 then
                initialize local nilai to create empty list
                in
                    for each i from 2 to 6 by 1
                    do
                        add items to list list (get nilai) item (select list item list (get f) index (get i))
                    call Procedure_IsiSp values: (get nilai)
                    call TinyDB1.StoreValue tag: "setpoint" valueToStore: (get nilai)
                set Lbl_StatusSp.Text to "Setpoint tersimpan di server. ESP32 menerapkannya dalam ±30 detik."
                set Lbl_StatusSp.TextColor to green
            else
                set Lbl_StatusSp.Text to join "Balasan tak dikenal: " (get responseContent)
                set Lbl_StatusSp.TextColor to red
    else
        set Lbl_StatusSp.Text to join "Gagal simpan: " (get responseContent)
        set Lbl_StatusSp.TextColor to red
        call Notifier1.ShowAlert notice: (get responseContent)

when Web_Setpoint.TimedOut (url)
    set global sedang_sp to false
    if not (get global sp_senyap) then
        set Lbl_StatusSp.Text to "Waktu habis. Coba lagi (server mungkin sedang bangun)."
        set Lbl_StatusSp.TextColor to red
```

### 5A.4 Sinkron dari TinyDB

Server menyimpan setpoint **di memori** (hilang saat Render tidur/restart), sama seperti batas gas. Blok sinkronnya sudah tertulis lengkap
di bagian 3 (`Screen1.Initialize` dan `Clock1.Timer`): setpoint dikirim ulang dari TinyDB (tag `setpoint`) **hanya bila pernah disimpan** dari
aplikasi. Aplikasi yang baru dipasang tidak mengirim nilai bawaan, supaya setpoint yang sudah tersimpan di flash ESP32 tidak tertimpa.
Bila server sedang di nilai bawaan (`custom` = `0`), ESP32 juga tidak menimpa setpoint di flash-nya, jadi alat tetap bekerja walau server baru restart.

---

## 6. Alur pemakaian

1. Isi `base_url` dan `api_key` (bagian 2). Jalankan aplikasi.
2. Badge **LIVE** (titik merah berkedip) = Central Unit mengirim sensor. **OFFLINE** = alat tidak mengirim data.
   **NO NET** = ponsel tidak bisa menjangkau server.
3. Ubah batas di TextBox → **Simpan batas**. Mode Buah berubah pada pembacaan sensor berikutnya (≤ 10 detik).
4. Foto terambil otomatis saat pintu dibuka lalu ditutup, dan terjadwal tiap 30 menit (Central Unit).
   **Mode Buah** menampilkan kondisi terburuk antara foto terakhir dan sensor terkini.

Server menyimpan data dan batas **di memori**: hilang saat Render tidur/restart. Batas dikirim ulang dari TinyDB saat aplikasi
dibuka dan tiap ±60 detik (bagian 3), sedangkan riwayat sensor/foto tidak dipulihkan.

---

## 7. Uji tanpa alat (sementara; hapus setelah uji)

```
when Btn_UjiSensor.Click
    set Web_Uji.Url to join (get global base_url)
        "/api/sensors?format=text&co2=1500&ammonia=20&alcohol=30&methane=40&temp=27.5&hum=66&peltier=1&fan=1"
    call Web_Uji.PostText text: ""

when Web_Uji.GotText (url, responseCode, responseType, responseContent)
    call Notifier1.ShowAlert notice: join "HTTP " (get responseCode) ": " (get responseContent)
```

Balasan sukses: `OK|skor|risiko|klasifikasi`, misalnya `OK|63|sedang|matang`. Semua enam parameter gas/suhu wajib;
`peltier` dan `fan` (0 atau 1) opsional. Dalam ±5 detik dashboard menampilkan CO2 1500 PPM, CH4 40 PPM, suhu 27.5 °C,
PELTIER ON, AUTO (ON), dan Mode Buah **MATANG**.

| Balasan / gejala | Penyebab | Perbaikan |
|---|---|---|
| `HTTP 401: ERR\|x-api-key salah atau kosong` | `api_key` tidak sama dengan `SHARED_SECRET` | Samakan; pastikan blok `RequestHeaders` ada di `Screen1.Initialize` |
| Badge NO NET, "timeout" | Render gratis sedang bangun | Tunggu ±1 menit; `Timeout` Web harus 60000 |
| `Gangguan koneksi: …` | Ponsel offline / URL salah | Cek internet dan `base_url` |
| `Respons tidak dikenal: …` | URL menunjuk bukan ke server ini | Cek `base_url` (tanpa `/` di akhir) |
| Kanvas kosong/hitam | `Canvas_Dash.Width` belum tersedia | Tunggu 1 detik (digambar dari `Clock_Jam.Timer`); pastikan `Width Fill parent` |
| Teks terlalu besar/kecil | Satuan `FontSize` Canvas berbeda antar perangkat | Ubah `skala_font` (bagian 4.1) |
| Semua nilai `--` dan badge OFFLINE | Belum ada data dari Central Unit | Cek WiFi dan kabel sensor di Central Unit |
| `ERR\|CO2: minimal (…) harus lebih kecil dari maksimal (…)` | Batas tidak valid | Perbaiki nilai di TextBox |
| `ERR\|Tidak ada nilai batas …` | Semua TextBox kosong | Isi minimal satu batas |

---

## 8. Lampiran: endpoint lain (JSON, opsional)

Pakai `JsonTextDecodeWithDictionaries` (bukan `JsonTextDecode`) agar objek JSON menjadi dictionary.

- `GET /api/latest` — kunci penting: `limits.{alcohol,co2,methane,ammonia}.{min,max}`,
  `sensors.values.{co2,ammonia,alcohol,methane,temp,hum}`, `sensors.act.{peltier,fan}`, `sensors.age_s`,
  `sensors.classification.{class,index,gases}`, `result.fruit`, `result.klasifikasi`, `result.food_health_score`,
  `result.risk_level`, `result.change.{status,significant}`.
  `result` bernilai `null` bila belum ada foto; `sensors` `null` bila belum ada data sensor.
- `GET /api/history?limit=20` (hasil foto) atau `?type=sensors&limit=50`, maksimal 100 item, terbaru dulu.
- `GET /api/trend` (daftar pelacak) dan `GET /api/trend?key=pisang` (detail). Versi teks `?key=pisang&format=text`:
  `kunci|jumlah|status|signifikan|skor_awal|skor_terkini|poin_per_jam`.
- Beberapa buah sejenis? Tambahkan `&batch=pisang-rak1` pada URL foto agar dilacak terpisah.

Catatan: skor, risiko, dan klasifikasi dihitung dari batas di aplikasi (`lib/limits.js`, `lib/classify.js`, `lib/assess.js`),
bukan standar keamanan pangan. Sensor MQ tidak spesifik (MQ-135 membaca CO2 dan amonia sekaligus); kalibrasi R0 di udara bersih.

---

## 9. Daftar periksa kelengkapan blok

- [ ] Komponen: `Canvas_Dash`, `Web_Latest`, `Web_Batas`, `Web_Setpoint`, `Web_Uji` (Timeout 60000), `Clock1` (5000), `Clock_Jam` (1000), `TinyDB1`, `Notifier1`
- [ ] Variabel global bagian 2 (18 umum termasuk `sedang_sp`, `sp_senyap`, `nama_sp`, + 14 warna)
- [ ] `Screen1.Initialize`, `Clock1.Timer`, `Clock_Jam.Timer`, `Screen1.ErrorOccurred`
- [ ] `RequestHeaders` diatur untuk keempat Web (`Web_Latest`, `Web_Batas`, `Web_Setpoint`, `Web_Uji`) di `Screen1.Initialize`
- [ ] Procedure menggambar: `Procedure_Kotak`, `Procedure_Garis`, `Procedure_Lingkaran`, `Procedure_Teks`, `Procedure_Bar`
- [ ] Procedure pembantu: `Procedure_Nilai`, `Procedure_Fmt1`, `Procedure_FmtPpm`, `Procedure_Frac`, `Procedure_ModeTeks`, `Procedure_ModeWarna`, `Procedure_TeksAktuator`, `Procedure_WarnaAktuator`, `Procedure_AngkaKartu`
- [ ] `Procedure_GambarDashboard`, `Procedure_GambarBadge`, `Procedure_GambarJam`
- [ ] `Procedure_PanggilLatest`, `Procedure_TampilLatest`, `Web_Latest.GotText`, `Web_Latest.TimedOut`
- [ ] Bagian 5A: lima TextBox setpoint (`NumbersOnly`), `Btn_SimpanSp`, `Lbl_StatusSp`, `Web_Setpoint`, `Procedure_AmbilSp`, `Procedure_IsiSp`, `Procedure_KirimSp`, `Btn_SimpanSp.Click`, `Web_Setpoint.GotText`, `Web_Setpoint.TimedOut`, `RequestHeaders` untuk `Web_Setpoint`
- [ ] `Procedure_AmbilDariTextBox`, `Procedure_IsiTextBox`, `Procedure_KirimBatas`, `Btn_Simpan.Click`, `Web_Batas.GotText`, `Web_Batas.TimedOut`
- [ ] Di semua `GotText`: soket `responseCode` diisi `get responseCode` dan isi diisi `get responseContent`
- [ ] Hapus `Btn_UjiSensor`, `Web_Uji` setelah uji
