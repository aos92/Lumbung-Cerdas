// ============================================================================
// LUMBUNG CERDAS - CENTRAL UNIT (ESP32 WROOM-32D)
//
// Satu kotak: Central Unit (sensor gas + DHT22 + reed + TFT + WiFi) dan
// Sub Unit 1 (ESP32-CAM, hanya mengambil foto lewat UART).
//
// Alur:
//   - Tiap SENSOR_READ_MS   : baca MQ-135 (CO2, NH3), MQ-4 (CH4), MQ-3 (alkohol), DHT22.
//   - Tiap SENSOR_PUSH_MS   : POST /api/sensors ke backend (Render).
//   - Pintu dibuka lalu ditutup (reed) atau jadwal rutin -> "CAP\n" ke ESP32-CAM
//     -> JPEG lewat UART -> POST /api/fruit?format=full (sensor ikut) -> hasil di TFT.
//   - TFT 320x240 mengikuti docs/Pratinjau_Tampilan.png.
//   - KONTROL (berdasarkan 5 setpoint dari aplikasi Android, disimpan di backend lalu diambil
//     lewat GET /api/setpoints dan disalin ke memori flash ESP32):
//       Kipas   ON bila suhu >= setpoint suhu, ATAU CO2 / metana / alkohol >= setpointnya,
//               ATAU kelembaban >= setpoint kelembaban; mati bila semuanya sudah di bawah.
//       Peltier ON bila suhu >= setpoint suhu (mendinginkan); mati bila suhu sudah di bawahnya.
//     Klasifikasi foto/sensor hanya untuk tampilan "Mode Buah", tidak menggerakkan kipas/Peltier.
//
// Board  : "ESP32 Dev Module" (WROOM-32D)
// Library: TFT_eSPI (User_Setup.h sudah diatur di library), DHT sensor library (Adafruit)
//          + Adafruit Unified Sensor. WiFi/HTTPClient/WiFiClientSecure sudah ada di core ESP32.
// Serial Monitor: 115200 baud. Perintah: c = foto sekarang, r = kalibrasi ulang R0, i = info.
//
// Pin ( sesuai daftar koneksi ):
//   TFT: CS15 RST4 DC2 MOSI23 SCK18 MISO19 (diatur di User_Setup TFT_eSPI, bukan di sini)
//   MQ-135=36  MQ-4=39  MQ-3=34 (ADC1, lewat pembagi tegangan 10k/20k)
//   Reed=32  DHT22=27  UART2: RX=16 TX=17 (ke ESP32-CAM)
//   Keluaran kontrol: 33 = Peltier, 14 = kipas (MOSFET/relay; lihat AUTO_KONTROL dan OUTPUT_ACTIVE_HIGH)
// ============================================================================
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <DHT.h>
#include <time.h>
#include <math.h>
#include <Preferences.h>

// ───────────────────────────── KONFIGURASI ─────────────────────────────
#define WIFI_SSID      "ISI_SSID_WIFI"
#define WIFI_PASSWORD  "ISI_PASSWORD_WIFI"
#define BACKEND_URL    "https://NAMA-APP.onrender.com"   // tanpa "/" di akhir
#define API_KEY        "ISI_SHARED_SECRET"               // sama dengan SHARED_SECRET di Render
#define BATCH_ID       ""                                // opsional: pisahkan pelacakan buah sejenis (huruf/angka/-_. maks 40, tanpa spasi: tidak di-URL-encode)

// Pin
#define PIN_MQ135      36
#define PIN_MQ4        39
#define PIN_MQ3        34
#define PIN_REED       32      // reed ke GND, INPUT_PULLUP: tertutup = LOW, terbuka = HIGH
#define PIN_DHT        27
#define PIN_CAM_RX     16      // <- TX (GPIO1/U0T) ESP32-CAM
#define PIN_CAM_TX     17      // -> RX (GPIO3/U0R) ESP32-CAM
#define PIN_PELTIER    33      // keluaran Peltier (lewat MOSFET/relay)
#define PIN_FAN        14      // keluaran kipas (lewat MOSFET/relay)

// Perilaku
#define AUTO_KONTROL                 1          // 1 = Central menggerakkan pin Peltier/kipas; 0 = hanya hitung dan tampilkan
#define OUTPUT_ACTIVE_HIGH           1          // 1 = HIGH menyalakan (MOSFET); 0 = LOW menyalakan (modul relay aktif-LOW)
#define SCHEDULE_CAPTURE_INTERVAL_MS 1800000UL  // foto rutin 30 menit, 0 = nonaktif
#define CAPTURE_AFTER_DOOR_CLOSE_MS  2000UL     // jeda setelah pintu tertutup sebelum foto
#define MIN_CAPTURE_GAP_MS           15000UL    // jarak minimum antar foto (lindungi kuota NVIDIA)
#define SENSOR_READ_MS               2500UL
#define SENSOR_PUSH_MS               10000UL
#define SCREEN_ROTATION              1          // 1 atau 3 (balik 180 derajat)

// Setpoint bawaan (dipakai sampai aplikasi mengirim nilai; sama dengan bawaan backend lib/setpoints.js)
#define SP_CO2_DEFAULT               2500.0f    // ppm
#define SP_CH4_DEFAULT               100.0f     // ppm
#define SP_ALC_DEFAULT               50.0f      // ppm
#define SP_TEMP_DEFAULT              25.0f      // derajat C
#define SP_HUM_DEFAULT               85.0f      // persen
#define SETPOINT_POLL_MS             30000UL    // ambil setpoint dari backend tiap 30 detik

// Histeresis agar kipas/Peltier tidak bolak-balik di sekitar setpoint:
// ON saat nilai >= setpoint, OFF saat nilai <= setpoint dikurangi histeresis.
#define HYST_TEMP                    0.5f       // derajat C
#define HYST_HUM                     2.0f       // persen RH
#define HYST_GAS_FRAC                0.05f      // 5% dari setpoint gas
#define OUTPUT_MIN_ON_MS             10000UL    // kipas/Peltier yang sudah ON tidak dimatikan sebelum selama ini
#define PELTIER_COOLING              1          // 1 = Peltier ON saat suhu >= setpoint (mendinginkan, bersama kipas)
                                                // 0 = Peltier ON saat suhu < setpoint (pemanas / sesuai tulisan lama)
#define HUM_CONTROLS_FAN             1          // 1 = kelembaban >= setpoint ikut menyalakan kipas

// UART ke ESP32-CAM
#define CAM_BAUD               921600
#define JPEG_MAX_BYTES         61440UL    // harus >= MAX_JPEG_BYTES di sub_unit_1
#define CAM_HEADER_TIMEOUT_MS  8000UL
#define CAM_IDLE_TIMEOUT_MS    2500UL

// Sensor gas (ADC1 + pembagi 10k/20k -> faktor 30/20 = 1.5)
#define DIVIDER_GAIN     1.5f
#define VCC_MQ           5.0f
#define RL_KOHM          10.0f
#define ADC_SAMPLES      16
#define WARMUP_SECONDS   60               // pemanasan sebelum kalibrasi R0
#define CO2_BASELINE_PPM 400.0f           // MQ-135 membaca selisih; tambah CO2 atmosfer
#define ALCOHOL_SCALE    530.0f           // rumus MQ-3 pustaka = mg/L; x530 = ppm etanol (setpoint dan batas backend dalam ppm)
// R0 manual (kOhm). 0 = kalibrasi otomatis saat boot (HARUS di udara bersih).
// Setelah dikalibrasi, salin nilai R0 dari Serial Monitor ke sini agar tetap konsisten.
#define R0_MQ135         0.0f
#define R0_MQ4           0.0f
#define R0_MQ3           0.0f

// ───────────────────────────── WARNA (RGB565) ─────────────────────────────
#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))
#define C_BLACK   0x0000
#define C_BORDER  RGB565(30, 100, 255)
#define C_HEAD    RGB565(10, 30, 140)
#define C_CYAN    RGB565(0, 229, 255)
#define C_PALE    RGB565(176, 255, 255)
#define C_LIME    RGB565(190, 255, 0)
#define C_GREEN   RGB565(0, 255, 0)
#define C_ORANGE  RGB565(255, 160, 0)
#define C_YELLOW  RGB565(255, 255, 0)
#define C_MAGENTA RGB565(255, 0, 255)
#define C_RED     RGB565(255, 0, 0)
#define C_DKRED   RGB565(110, 0, 0)
#define C_BLUE    RGB565(0, 130, 220)
#define C_GREY    RGB565(130, 130, 130)
#define C_BARFRM  RGB565(0, 120, 255)

TFT_eSPI tft = TFT_eSPI();
DHT dht(PIN_DHT, DHT22);

// Deklarasi awal dengan nilai bawaan (agar aman dari pembuat prototipe otomatis Arduino).
static float readRs(uint8_t pin, float* voltsOut = nullptr);
static void  textAt(const char* s, int x, int y, uint16_t fg, uint16_t bg, uint8_t font, uint8_t datum = TL_DATUM);
static void  setStatus(const String& s, uint32_t holdMs = 0);
static void  bootLine(int row, const char* s, uint16_t col = C_CYAN);

// ───────────────────────────── STATE ─────────────────────────────
struct MQSensor { const char* name; uint8_t pin; float cleanRatio; float r0; bool ok; };
MQSensor mq135 = {"MQ-135", PIN_MQ135, 3.6f, R0_MQ135, false};
MQSensor mq4   = {"MQ-4",   PIN_MQ4,   4.4f, R0_MQ4,   false};
MQSensor mq3   = {"MQ-3",   PIN_MQ3,   60.0f, R0_MQ3,  false};

float gCo2 = NAN, gNh3 = NAN, gCh4 = NAN, gAlc = NAN;   // ppm (sudah dihaluskan)
float gTemp = NAN, gHum = NAN;
bool  haveDht = false;
int   dhtFail = 0;
bool  gasReady = false;                                  // semua MQ terkalibrasi

String sensorClass = "";     // dari /api/sensors
String photoClass  = "";     // dari /api/fruit
String fruitName   = "";
String photoScore  = "-";
String photoRisk   = "-";
bool   fanOn = false, peltierOn = false;

// Setpoint aktif (dari backend; disalin ke NVS agar tetap berlaku saat boot tanpa WiFi/server)
float spCo2 = SP_CO2_DEFAULT, spCh4 = SP_CH4_DEFAULT, spAlc = SP_ALC_DEFAULT, spTemp = SP_TEMP_DEFAULT, spHum = SP_HUM_DEFAULT;
Preferences prefs;
uint32_t lastSetpointMs = 0;
uint32_t fanOnSince = 0, peltierOnSince = 0;

uint8_t* jpegBuf = nullptr;

volatile bool     reedEdge = false;
volatile uint32_t reedEdgeMs = 0;
bool     doorOpen = false;
bool     doorWasOpen = false;
uint32_t doorClosedAt = 0;

bool     pendingCapture = false;
uint32_t lastCaptureMs = 0;
uint32_t lastSensorMs = 0, lastPushMs = 0, lastPushOkMs = 0, lastWifiTry = 0;
uint32_t bootMs = 0;
bool     capturing = false;

String   statusText = "LIVE";
uint32_t statusUntil = 0;
bool     dotOn = true;
uint32_t lastBlink = 0;
int      lastSecond = -1;

// ───────────────────────────── UTIL ─────────────────────────────
static int rankOf(const String& s) {
  if (s == "segar") return 0;
  if (s == "matang") return 1;
  if (s == "mulai busuk") return 2;
  if (s == "busuk") return 3;
  return -1;
}

// Kondisi akhir = yang lebih buruk antara foto dan sensor (sama dengan server).
static String combinedClass() {
  int a = rankOf(photoClass), b = rankOf(sensorClass);
  int r = (a > b) ? a : b;
  switch (r) {
    case 0: return "segar";
    case 1: return "matang";
    case 2: return "mulai busuk";
    case 3: return "busuk";
  }
  return "";
}

static int splitPipe(const String& s, String* out, int maxParts) {
  int n = 0, start = 0;
  while (n < maxParts) {
    int p = s.indexOf('|', start);
    if (p < 0) { out[n++] = s.substring(start); break; }
    out[n++] = s.substring(start, p);
    start = p + 1;
  }
  for (int i = 0; i < n; i++) out[i].trim();
  return n;
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static float ema(float cur, float x) { return isnan(cur) ? x : cur + 0.3f * (x - cur); }

static bool sensorsReady() {
  return gasReady && haveDht && !isnan(gCo2) && !isnan(gNh3) && !isnan(gAlc) && !isnan(gCh4);
}

// ───────────────────────────── SENSOR GAS ─────────────────────────────
static float readSensorVolts(uint8_t pin) {
  uint32_t sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) { sum += analogReadMilliVolts(pin); delayMicroseconds(300); }
  return (sum / (float)ADC_SAMPLES) * DIVIDER_GAIN / 1000.0f;   // tegangan AO sebenarnya
}

static float readRs(uint8_t pin, float* voltsOut) {
  float v = readSensorVolts(pin);
  if (voltsOut) *voltsOut = v;
  v = clampf(v, 0.02f, VCC_MQ - 0.02f);
  return RL_KOHM * (VCC_MQ - v) / v;
}

static float ppmFrom(float rs, float r0, float a, float b) {
  if (!(r0 > 0)) return NAN;
  return a * powf(rs / r0, b);
}

static void calibrateOne(MQSensor& s) {
  if (s.r0 > 0) { s.ok = true; return; }        // R0 manual
  float sumRs = 0, sumV = 0;
  for (int i = 0; i < 20; i++) {
    float v; sumRs += readRs(s.pin, &v); sumV += v; delay(100);
  }
  float avgV = sumV / 20.0f;
  float r0 = (sumRs / 20.0f) / s.cleanRatio;
  if (avgV < 0.05f) {
    Serial.printf("[%s] ERROR: AO ~0 V, kabel putus atau sensor tak dapat daya 5V\n", s.name);
    s.ok = false; return;
  }
  if (avgV > 3.2f) Serial.printf("[%s] PERINGATAN: AO %.2f V tinggi (ADC jenuh ~3.1 V di GPIO), cek udara/pembagi\n", s.name, avgV);
  s.r0 = r0;
  s.ok = isfinite(r0) && r0 > 0.05f;
  Serial.printf("[%s] R0 = %.3f kOhm (AO %.2f V)%s\n", s.name, r0, avgV, s.ok ? "" : "  <- TIDAK VALID");
}

static void calibrateAll() {
  mq135.r0 = R0_MQ135; mq4.r0 = R0_MQ4; mq3.r0 = R0_MQ3;
  calibrateOne(mq135); calibrateOne(mq4); calibrateOne(mq3);
  gasReady = mq135.ok && mq4.ok && mq3.ok;
  gCo2 = gNh3 = gCh4 = gAlc = NAN;
}

static void readGases() {
  if (!gasReady) return;
  float rs = readRs(PIN_MQ135);
  float co2 = CO2_BASELINE_PPM + ppmFrom(rs, mq135.r0, 110.47f, -2.862f);
  float nh3 = ppmFrom(rs, mq135.r0, 102.2f, -2.473f);
  float ch4 = ppmFrom(readRs(PIN_MQ4), mq4.r0, 1012.7f, -2.786f);
  float alc = ALCOHOL_SCALE * ppmFrom(readRs(PIN_MQ3), mq3.r0, 0.3934f, -1.504f);
  if (!isfinite(co2) || !isfinite(nh3) || !isfinite(ch4) || !isfinite(alc)) return;
  gCo2 = ema(gCo2, clampf(co2, 0, 10000));
  gNh3 = ema(gNh3, clampf(nh3, 0, 1000));
  gCh4 = ema(gCh4, clampf(ch4, 0, 10000));
  gAlc = ema(gAlc, clampf(alc, 0, 5000));
}

static void readDht() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) { if (dhtFail < 1000) dhtFail++; return; }
  dhtFail = 0; haveDht = true;
  gTemp = t; gHum = clampf(h, 0, 100);
}

// ───────────────────────────── TFT ─────────────────────────────
#define CARD_X1  6
#define CARD_X2  166
#define CARD_W   148
#define ROW1_Y   41
#define ROW1_H   62
#define ROW2_Y   108
#define ROW2_H   92

static void drawCard(int x, int y, int w, int h) {
  tft.fillRoundRect(x, y, w, h, 6, C_BLACK);
  tft.drawRoundRect(x, y, w, h, 6, C_BORDER);
}

static void textAt(const char* s, int x, int y, uint16_t fg, uint16_t bg, uint8_t font, uint8_t datum) {
  tft.setTextDatum(datum);
  tft.setTextColor(fg, bg);
  tft.setTextPadding(0);
  tft.drawString(s, x, y, font);
  tft.setTextDatum(TL_DATUM);
}

static void drawStatic() {
  tft.fillScreen(C_BLACK);
  tft.drawRoundRect(0, 0, 320, 240, 8, C_BORDER);
  tft.drawRoundRect(1, 1, 318, 238, 7, C_BORDER);
  tft.fillRoundRect(4, 4, 312, 30, 5, C_HEAD);
  tft.drawRoundRect(4, 4, 312, 30, 5, C_BORDER);
  textAt("LUMBUNG CERDAS ! MONITORING", 12, 15, C_CYAN, C_HEAD, 1);
  tft.drawFastHLine(4, 37, 312, C_BORDER);

  drawCard(CARD_X1, ROW1_Y, CARD_W, ROW1_H);
  drawCard(CARD_X2, ROW1_Y, CARD_W, ROW1_H);
  drawCard(CARD_X1, ROW2_Y, CARD_W, ROW2_H);
  drawCard(CARD_X2, ROW2_Y, CARD_W, ROW2_H);

  textAt("SUHU INTERNAL",        CARD_X1 + 7, ROW1_Y + 6, C_CYAN, C_BLACK, 1);
  textAt("KELEMBABAN (RH)",      CARD_X2 + 7, ROW1_Y + 6, C_CYAN, C_BLACK, 1);
  tft.drawRect(CARD_X1 + 7, ROW1_Y + 49, CARD_W - 14, 9, C_BARFRM);
  tft.drawRect(CARD_X2 + 7, ROW1_Y + 49, CARD_W - 14, 9, C_BARFRM);

  textAt("EMISI GAS BUMI",       CARD_X1 + 7, ROW2_Y + 7, C_CYAN, C_BLACK, 1);
  textAt("CO2 (Karbon)",         CARD_X1 + 7, ROW2_Y + 26, C_CYAN, C_BLACK, 1);
  textAt("CH4 (Metana)",         CARD_X1 + 7, ROW2_Y + 42, C_ORANGE, C_BLACK, 1);
  textAt("C2H5OH (Etanol)",      CARD_X1 + 7, ROW2_Y + 58, C_MAGENTA, C_BLACK, 1);

  textAt("KONDISI & PREDIKSI AI", CARD_X2 + 7, ROW2_Y + 7, C_CYAN, C_BLACK, 1);
  textAt("Pendingin :",          CARD_X2 + 7, ROW2_Y + 26, C_CYAN, C_BLACK, 1);
  textAt("Sirkulasi :",          CARD_X2 + 7, ROW2_Y + 42, C_CYAN, C_BLACK, 1);
  textAt("Mode Buah :",          CARD_X2 + 7, ROW2_Y + 58, C_CYAN, C_BLACK, 1);
}

static void drawDot() {
  uint16_t c = C_GREY;
  if (WiFi.status() == WL_CONNECTED) c = dotOn ? C_RED : C_DKRED;
  tft.fillCircle(306, 19, 5, c);
}

static void drawHeaderStatus() {
  tft.fillRect(180, 11, 116, 16, C_HEAD);
  textAt(statusText.c_str(), 294, 15, C_CYAN, C_HEAD, 1, TR_DATUM);
  drawDot();
}

static void setStatus(const String& s, uint32_t holdMs) {
  statusText = s;
  statusUntil = holdMs ? millis() + holdMs : 0;
  drawHeaderStatus();
}

static String defaultStatus() {
  if (WiFi.status() != WL_CONNECTED) return "OFFLINE";
  if (!gasReady) return "SENSOR ERR";
  if (lastPushOkMs && millis() - lastPushOkMs < 3UL * SENSOR_PUSH_MS) return "LIVE";
  return "SERVER?";
}

static void drawBar(int x, int y, int w, float frac, uint16_t color) {
  frac = clampf(frac, 0, 1);
  int inner = w - 2;
  int f = (int)(inner * frac);
  if (f > 0) tft.fillRect(x + 1, y + 1, f, 7, color);
  if (f < inner) tft.fillRect(x + 1 + f, y + 1, inner - f, 7, C_BLACK);
}

static void drawTemp() {
  static int last = -9999;
  int v = haveDht ? (int)roundf(gTemp * 10) : -9998;
  if (v == last) return;
  last = v;
  int x = CARD_X1, y = ROW1_Y;
  tft.fillRect(x + 6, y + 17, CARD_W - 12, 29, C_BLACK);
  char b[12];
  if (haveDht) snprintf(b, sizeof b, "%.1f", gTemp); else strcpy(b, "--.-");
  textAt(b, x + 7, y + 18, C_PALE, C_BLACK, 4);
  int tw = tft.textWidth(b, 4);
  tft.drawCircle(x + 7 + tw + 8, y + 22, 3, C_LIME);
  textAt("C", x + 7 + tw + 14, y + 18, C_LIME, C_BLACK, 4);
  drawBar(x + 7, y + 49, CARD_W - 14, haveDht ? gTemp / 60.0f : 0, C_GREEN);   // skala 0-60 C
}

static void drawHum() {
  static int last = -9999;
  int v = haveDht ? (int)roundf(gHum * 10) : -9998;
  if (v == last) return;
  last = v;
  int x = CARD_X2, y = ROW1_Y;
  tft.fillRect(x + 6, y + 17, CARD_W - 12, 29, C_BLACK);
  char b[12];
  if (haveDht) snprintf(b, sizeof b, "%.1f", gHum); else strcpy(b, "--.-");
  textAt(b, x + 7, y + 18, C_PALE, C_BLACK, 4);
  int tw = tft.textWidth(b, 4);
  textAt("%", x + 7 + tw + 6, y + 18, C_CYAN, C_BLACK, 4);
  drawBar(x + 7, y + 49, CARD_W - 14, haveDht ? gHum / 100.0f : 0, C_CYAN);
}

static void fmtPpm(char* out, size_t n, float v) {
  if (isnan(v)) snprintf(out, n, "-- PPM");
  else if (v < 10) snprintf(out, n, "%.1f PPM", v);
  else snprintf(out, n, "%d PPM", (int)roundf(v));
}

static void drawGasRow(int row, const char* label, float v, uint16_t color, String& cache) {
  char b[16];
  fmtPpm(b, sizeof b, v);
  if (cache == b) return;
  cache = b;
  int y = ROW2_Y + 26 + row * 16;
  int rightEdge = CARD_X1 + CARD_W - 6;
  int clearX = CARD_X1 + 7 + tft.textWidth(label, 1) + 3;
  tft.fillRect(clearX, y, rightEdge - clearX + 1, 8, C_BLACK);
  textAt(b, rightEdge, y, color, C_BLACK, 1, TR_DATUM);
}

static void drawGas() {
  static String c0, c1, c2;
  drawGasRow(0, "CO2 (Karbon)",    gCo2, C_CYAN,    c0);
  drawGasRow(1, "CH4 (Metana)",    gCh4, C_YELLOW,  c1);
  drawGasRow(2, "C2H5OH (Etanol)", gAlc, C_MAGENTA, c2);
}

static void drawStatusCard() {
  static String last = "?";
  String cls = combinedClass();
  String key = cls + (peltierOn ? "P1" : "P0") + (fanOn ? "F1" : "F0");
  if (key == last) return;
  last = key;
  int x = CARD_X2 + 7, w = CARD_W - 14;

  tft.fillRect(x + 70, ROW2_Y + 26, w - 70, 8, C_BLACK);
  textAt(peltierOn ? "PELTIER ON" : "PELTIER OFF", x + 70, ROW2_Y + 26, peltierOn ? C_GREEN : C_CYAN, C_BLACK, 1);

  tft.fillRect(x + 70, ROW2_Y + 42, w - 70, 8, C_BLACK);
  textAt(fanOn ? "AUTO (ON)" : "AUTO (OFF)", x + 70, ROW2_Y + 42, fanOn ? C_CYAN : C_BLUE, C_BLACK, 1);

  const char* txt = "MENUNGGU DATA"; uint16_t col = C_GREY;
  if (cls == "segar")            { txt = "OPTIMAL / SEGAR"; col = C_GREEN; }
  else if (cls == "matang")      { txt = "MATANG";          col = C_YELLOW; }
  else if (cls == "mulai busuk") { txt = "MULAI BUSUK";     col = C_ORANGE; }
  else if (cls == "busuk")       { txt = "BUSUK";           col = C_RED; }
  tft.fillRect(x, ROW2_Y + 74, w, 10, C_BLACK);
  textAt(txt, x, ROW2_Y + 74, col, C_BLACK, 1);
}

static const char* DAY_ID[] = {"MINGGU", "SENIN", "SELASA", "RABU", "KAMIS", "JUMAT", "SABTU"};

static void drawClock(bool force) {
  time_t now = time(nullptr);
  char b[48];
  if (now < 1700000000) {
    if (!force && lastSecond == -2) return;
    lastSecond = -2;
    snprintf(b, sizeof b, "MENUNGGU WAKTU NTP...");
  } else {
    struct tm ti; localtime_r(&now, &ti);
    if (!force && ti.tm_sec == lastSecond) return;
    lastSecond = ti.tm_sec;
    snprintf(b, sizeof b, "%s, %02d/%02d/%04d ! %02d:%02d:%02d WIB", DAY_ID[ti.tm_wday],
             ti.tm_mday, ti.tm_mon + 1, ti.tm_year + 1900, ti.tm_hour, ti.tm_min, ti.tm_sec);
  }
  uint8_t font = (tft.textWidth(b, 2) <= 306) ? 2 : 1;
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_CYAN, C_BLACK);
  tft.setTextPadding(306);
  tft.drawString(b, 160, 219, font);
  tft.setTextPadding(0);
  tft.setTextDatum(TL_DATUM);
}

static void refreshScreen() {
  drawTemp(); drawHum(); drawGas(); drawStatusCard();
}

// ───────────────────────────── KONTROL (SETPOINT) ─────────────────────────────
static inline void writeOut(uint8_t pin, bool on) {
  digitalWrite(pin, (on == (bool)OUTPUT_ACTIVE_HIGH) ? HIGH : LOW);
}

static void outputsInit() {
  pinMode(PIN_FAN, OUTPUT); pinMode(PIN_PELTIER, OUTPUT);
  writeOut(PIN_FAN, false); writeOut(PIN_PELTIER, false);
}

// true bila v >= setpoint; false bila v <= setpoint - histeresis; di antaranya tetap seperti sebelumnya.
static bool latchAbove(bool cur, float v, float sp, float hyst) {
  if (isnan(v)) return false;
  if (v >= sp) return true;
  if (v <= sp - hyst) return false;
  return cur;
}

// Nyala langsung; mati hanya setelah OUTPUT_MIN_ON_MS (melindungi Peltier/relay dari on-off cepat).
static bool settle(bool cur, bool want, uint32_t& onSince) {
  uint32_t now = millis();
  if (want && !cur) { onSince = now; return true; }
  if (!want && cur && now - onSince >= OUTPUT_MIN_ON_MS) return false;
  return cur;
}

static void applyControl() {
  static bool tAbove = false, cAbove = false, mAbove = false, aAbove = false, hAbove = false;
  tAbove = latchAbove(tAbove, haveDht ? gTemp : NAN, spTemp, HYST_TEMP);
  cAbove = latchAbove(cAbove, gCo2, spCo2, spCo2 * HYST_GAS_FRAC);
  mAbove = latchAbove(mAbove, gCh4, spCh4, spCh4 * HYST_GAS_FRAC);
  aAbove = latchAbove(aAbove, gAlc, spAlc, spAlc * HYST_GAS_FRAC);
#if HUM_CONTROLS_FAN
  hAbove = latchAbove(hAbove, haveDht ? gHum : NAN, spHum, HYST_HUM);
#else
  hAbove = false;
#endif
  bool wantFan = tAbove || cAbove || mAbove || aAbove || hAbove;
#if PELTIER_COOLING
  bool wantPeltier = haveDht && tAbove;
#else
  bool wantPeltier = haveDht && !tAbove;
#endif
  fanOn = settle(fanOn, wantFan, fanOnSince);
  peltierOn = settle(peltierOn, wantPeltier, peltierOnSince);
#if AUTO_KONTROL
  writeOut(PIN_FAN, fanOn);
  writeOut(PIN_PELTIER, peltierOn);
#endif
}

// ───────────────────────────── SETPOINT (NVS + BACKEND) ─────────────────────────────
static void loadSetpoints() {
  prefs.begin("lumbung", true);
  spCo2  = prefs.getFloat("co2",  spCo2);
  spCh4  = prefs.getFloat("ch4",  spCh4);
  spAlc  = prefs.getFloat("alc",  spAlc);
  spTemp = prefs.getFloat("temp", spTemp);
  spHum  = prefs.getFloat("hum",  spHum);
  prefs.end();
}

static void saveSetpoints() {
  prefs.begin("lumbung", false);
  prefs.putFloat("co2", spCo2); prefs.putFloat("ch4", spCh4); prefs.putFloat("alc", spAlc);
  prefs.putFloat("temp", spTemp); prefs.putFloat("hum", spHum);
  prefs.end();
}

// GET /api/setpoints?format=text -> OK|co2|metana|alkohol|suhu|kelembaban|custom(0/1)
// custom=0 berarti server belum menerima setpoint dari aplikasi (mis. server baru bangun): nilai tersimpan tidak ditimpa.
static bool fetchSetpoints() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(12000);
  if (!http.begin(client, String(BACKEND_URL) + "/api/setpoints?format=text")) return false;
  http.addHeader("x-api-key", API_KEY);
  int code = http.GET();
  String body = (code == 200) ? http.getString() : String("");
  http.end();
  if (code != 200) { Serial.printf("[setpoint] HTTP %d\n", code); return false; }
  body.trim();
  String f[8]; int n = splitPipe(body, f, 8);
  if (n < 7 || f[0] != "OK") { Serial.printf("[setpoint] balasan tak dikenal: %s\n", body.c_str()); return false; }
  if (f[6] != "1") { Serial.println("[setpoint] aplikasi belum mengirim setpoint; pakai nilai tersimpan"); return true; }
  float co2 = f[1].toFloat(), ch4 = f[2].toFloat(), alc = f[3].toFloat(), t = f[4].toFloat(), h = f[5].toFloat();
  if (!(co2 > 0 && ch4 > 0 && alc > 0 && h > 0 && h <= 100 && t >= -40 && t <= 80)) { Serial.println("[setpoint] nilai di luar rentang, diabaikan"); return false; }
  bool changed = fabsf(co2 - spCo2) > 0.001f || fabsf(ch4 - spCh4) > 0.001f || fabsf(alc - spAlc) > 0.001f
              || fabsf(t - spTemp) > 0.001f || fabsf(h - spHum) > 0.001f;
  if (changed) {
    spCo2 = co2; spCh4 = ch4; spAlc = alc; spTemp = t; spHum = h;
    saveSetpoints();
    Serial.printf("[setpoint] baru: CO2 %.0f, CH4 %.0f, alkohol %.0f ppm, suhu %.1f C, RH %.0f %%\n", spCo2, spCh4, spAlc, spTemp, spHum);
    applyControl();
  }
  return true;
}

// ───────────────────────────── NETWORK ─────────────────────────────
static void wifiKeepAlive() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 10000UL) return;
  lastWifiTry = millis();
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static void addActuators(char* q, size_t n) {
#if AUTO_KONTROL
  size_t l = strlen(q);
  snprintf(q + l, n - l, "&peltier=%d&fan=%d", peltierOn ? 1 : 0, fanOn ? 1 : 0);
#endif
}

static void sensorQuery(char* q, size_t n) {
  snprintf(q, n, "co2=%.0f&ammonia=%.1f&alcohol=%.2f&methane=%.1f&temp=%.1f&hum=%.1f",
           gCo2, gNh3, gAlc, gCh4, gTemp, gHum);
  addActuators(q, n);
}

static bool pushSensors() {
  if (WiFi.status() != WL_CONNECTED || !sensorsReady()) return false;
  char q[200]; sensorQuery(q, sizeof q);
  String url = String(BACKEND_URL) + "/api/sensors?format=text&" + q;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(12000);
  if (!http.begin(client, url)) return false;
  http.addHeader("x-api-key", API_KEY);
  int code = http.POST("");
  bool ok = false;
  if (code == 200) {
    String body = http.getString(); body.trim();
    String f[4]; int n = splitPipe(body, f, 4);   // OK|skor|risiko|kelas
    if (n >= 4 && f[0] == "OK") { sensorClass = (f[3] == "-") ? "" : f[3]; ok = true; }
  } else {
    Serial.printf("[sensors] HTTP %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  }
  http.end();
  if (ok) lastPushOkMs = millis();
  return ok;
}

// Render gratis tidur saat tidak dipakai; bangunkan sebelum mengunggah foto.
static void wakeServer() {
  for (int i = 0; i < 3; i++) {
    WiFiClientSecure client; client.setInsecure();
    HTTPClient http;
    http.setConnectTimeout(20000);
    http.setTimeout(30000);
    if (!http.begin(client, String(BACKEND_URL) + "/health")) return;
    int code = http.GET();
    http.end();
    if (code == 200) return;
    delay(1000);
  }
}

// ───────────────────────────── KAMERA (UART) ─────────────────────────────
static bool readExact(uint8_t* dst, size_t n, uint32_t idleMs) {
  size_t got = 0; uint32_t lastRx = millis();
  while (got < n) {
    int avail = Serial2.available();
    if (avail > 0) {
      size_t want = n - got; if ((size_t)avail < want) want = avail;
      got += Serial2.readBytes(dst + got, want);
      lastRx = millis();
    } else {
      if (millis() - lastRx > idleMs) return false;
      delay(1);
    }
  }
  return true;
}

// 0 = ok; 1 = CAM tidak menjawab; 2 = CAM gagal ambil foto; 3 = JPEG terlalu besar;
// 4 = data terputus; 5 = bukan JPEG valid
static int camReceive(size_t& outLen) {
  while (Serial2.available()) Serial2.read();
  Serial2.print("CAP\n");
  Serial2.flush();

  uint32_t t0 = millis(); uint8_t prev = 0; bool sync = false;
  while (millis() - t0 < CAM_HEADER_TIMEOUT_MS) {
    if (Serial2.available()) {
      uint8_t b = Serial2.read();
      if (prev == 0xAA && b == 0x55) { sync = true; break; }
      prev = b;
    } else delay(1);
  }
  if (!sync) return 1;

  uint8_t lb[4];
  if (!readExact(lb, 4, 1000)) return 4;
  uint32_t len = (uint32_t)lb[0] | ((uint32_t)lb[1] << 8) | ((uint32_t)lb[2] << 16) | ((uint32_t)lb[3] << 24);
  if (len == 0) return 2;
  if (len > JPEG_MAX_BYTES) { delay(500); while (Serial2.available()) Serial2.read(); return 3; }
  if (!readExact(jpegBuf, len, CAM_IDLE_TIMEOUT_MS)) return 4;

  if (len < 4 || jpegBuf[0] != 0xFF || jpegBuf[1] != 0xD8) return 5;
  bool eoi = false;
  for (size_t i = len - 2, k = 0; k < 16; k++, i--) {
    if (jpegBuf[i] == 0xFF && jpegBuf[i + 1] == 0xD9) { len = i + 2; eoi = true; break; }
    if (i == 0) break;
  }
  if (!eoi) return 5;
  outLen = len;
  return 0;
}

static const char* camErrText(int rc) {
  switch (rc) {
    case 1: return "CAM MATI";
    case 2: return "CAM GAGAL";
    case 3: return "FOTO BESAR";
    case 4: return "CAM PUTUS";
    default: return "JPEG RUSAK";
  }
}

static void camPing() {
  while (Serial2.available()) Serial2.read();
  Serial2.print("PING\n"); Serial2.flush();
  uint32_t t0 = millis(); String s;
  while (millis() - t0 < 1500) {
    while (Serial2.available()) s += (char)Serial2.read();
    if (s.indexOf("PONG") >= 0) { Serial.println("[cam] PONG, ESP32-CAM terhubung"); setStatus("CAM OK", 3000); return; }
    delay(5);
  }
  Serial.println("[cam] tidak menjawab PING (cek kabel TX/RX silang, 5V, baud 921600)");
  setStatus("CAM MATI", 4000);
}

// ───────────────────────────── FOTO + UNGGAH ─────────────────────────────
static void runCapture(const char* reason) {
  pendingCapture = false;
  if (capturing) return;
  if (!sensorsReady()) { Serial.println("[capture] ditolak: sensor belum siap"); setStatus("SENSOR ERR", 4000); return; }
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[capture] ditolak: WiFi putus"); setStatus("NO WIFI", 4000); return; }
  capturing = true;
  lastCaptureMs = millis();
  Serial.printf("[capture] mulai (%s)\n", reason);

  setStatus("FOTO");
  size_t len = 0;
  int rc = camReceive(len);
  if (rc != 0) {
    Serial.printf("[capture] gagal: %s (kode %d)\n", camErrText(rc), rc);
    setStatus(camErrText(rc), 6000);
    capturing = false;
    return;
  }
  Serial.printf("[capture] JPEG %u byte, heap bebas %u\n", (unsigned)len, (unsigned)ESP.getFreeHeap());

  setStatus("WAKE");
  wakeServer();
  readGases();                         // sensor paling baru ikut bersama foto

  setStatus("KIRIM");
  char q[220]; sensorQuery(q, sizeof q);
  String url = String(BACKEND_URL) + "/api/fruit?format=full&" + q;
  if (strlen(BATCH_ID) > 0) url += String("&batch=") + BATCH_ID;

  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(20000);
  http.setTimeout(75000);
  int code = -1; String body;
  if (http.begin(client, url)) {
    http.addHeader("x-api-key", API_KEY);
    http.addHeader("Content-Type", "image/jpeg");
    code = http.POST(jpegBuf, len);
    body = (code > 0) ? http.getString() : http.errorToString(code);
    http.end();
  }
  body.trim();
  Serial.printf("[capture] HTTP %d: %s\n", code, body.c_str());

  if (code == 200) {
    String f[5]; int n = splitPipe(body, f, 5);   // Nama|Nutrisi|Klasifikasi|Skor|Risiko
    if (n >= 5) {
      fruitName = f[0]; photoClass = f[2]; photoClass.toLowerCase();
      photoScore = f[3]; photoRisk = f[4];
      lastPushOkMs = millis();
      Serial.printf("[hasil] %s | %s | skor %s | risiko %s\n", fruitName.c_str(), photoClass.c_str(), photoScore.c_str(), photoRisk.c_str());
      setStatus("HASIL OK", 4000);
    } else {
      setStatus("BUKAN BUAH", 5000);   // "Bukan buah|Coba arahkan ulang"
    }
  } else {
    char b[20]; snprintf(b, sizeof b, "ERR %d", code);
    setStatus(b, 6000);
  }
  applyControl();
  refreshScreen();
  capturing = false;
}

// ───────────────────────────── REED SWITCH ─────────────────────────────
void IRAM_ATTR onReed() { reedEdge = true; reedEdgeMs = millis(); }

static void handleReed() {
  if (!reedEdge || millis() - reedEdgeMs < 60) return;   // debounce
  reedEdge = false;
  bool open = digitalRead(PIN_REED) == HIGH;
  if (open == doorOpen) return;
  doorOpen = open;
  if (open) {
    doorWasOpen = true;
    Serial.println("[pintu] terbuka");
  } else {
    Serial.println("[pintu] tertutup");
    if (doorWasOpen) { doorWasOpen = false; doorClosedAt = millis(); pendingCapture = true; }
  }
}

// ───────────────────────────── SERIAL ─────────────────────────────
static void printInfo() {
  Serial.printf("CO2=%.0f NH3=%.1f CH4=%.1f ALK=%.2f T=%.1f H=%.1f | R0: 135=%.3f 4=%.3f 3=%.3f | kelas sensor=%s foto=%s | heap=%u\n",
                gCo2, gNh3, gCh4, gAlc, gTemp, gHum, mq135.r0, mq4.r0, mq3.r0,
                sensorClass.c_str(), photoClass.c_str(), (unsigned)ESP.getFreeHeap());
  Serial.printf("Setpoint: CO2 %.0f CH4 %.0f ALK %.0f SUHU %.1f RH %.0f | kipas=%s peltier=%s\n",
                spCo2, spCh4, spAlc, spTemp, spHum, fanOn ? "ON" : "OFF", peltierOn ? "ON" : "OFF");
}

static void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'c') { pendingCapture = true; doorClosedAt = 0; Serial.println("[serial] foto diminta"); }
    else if (c == 'r') { Serial.println("[serial] kalibrasi ulang (udara bersih!)"); setStatus("KALIBRASI"); calibrateAll(); setStatus(defaultStatus()); }
    else if (c == 'i') printInfo();
  }
}

// ───────────────────────────── SETUP / LOOP ─────────────────────────────
static void bootLine(int row, const char* s, uint16_t col) {
  tft.setTextPadding(300);
  tft.setTextColor(col, C_BLACK);
  tft.setTextDatum(TL_DATUM);
  tft.drawString(s, 12, 40 + row * 22, 2);
  tft.setTextPadding(0);
}

void setup() {
  outputsInit();                 // kipas dan Peltier OFF secepat mungkin
  Serial.begin(115200);
  delay(200);
  bootMs = millis();

  pinMode(PIN_REED, INPUT_PULLUP);
  doorOpen = (digitalRead(PIN_REED) == HIGH);
  attachInterrupt(digitalPinToInterrupt(PIN_REED), onReed, CHANGE);

  tft.init();
  tft.setRotation(SCREEN_ROTATION);
  tft.fillScreen(C_BLACK);
  tft.drawRoundRect(0, 0, 320, 240, 8, C_BORDER);
  bootLine(0, "LUMBUNG CERDAS", C_LIME);

  // Alokasi buffer JPEG sebelum WiFi/TLS memakai heap.
  jpegBuf = (uint8_t*)malloc(JPEG_MAX_BYTES);
  if (!jpegBuf) { bootLine(1, "ERR: heap kurang (JPEG)", C_RED); Serial.println("malloc JPEG gagal"); }

  Serial2.setRxBufferSize(8192);
  Serial2.begin(CAM_BAUD, SERIAL_8N1, PIN_CAM_RX, PIN_CAM_TX);

  loadSetpoints();               // setpoint terakhir dari flash
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // WIB

  bootLine(1, "WiFi: menyambung...");
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  if (WiFi.status() == WL_CONNECTED) {
    String s = "WiFi OK " + WiFi.localIP().toString();
    bootLine(1, s.c_str(), C_GREEN);
  } else bootLine(1, "WiFi: belum tersambung", C_ORANGE);

  // Pemanasan MQ (WiFi tetap jalan di latar).
  for (int s = WARMUP_SECONDS; s > 0; s--) {
    char b[40]; snprintf(b, sizeof b, "Pemanasan sensor: %d detik", s);
    bootLine(2, b);
    if (s % 5 == 0) readDht();
    delay(1000);
  }
  bootLine(3, "Kalibrasi R0 (udara bersih)...");
  calibrateAll();
  bootLine(3, gasReady ? "Kalibrasi selesai" : "Kalibrasi GAGAL, cek Serial", gasReady ? C_GREEN : C_RED);
  readDht();
  delay(800);

  drawStatic();
  lastSecond = -1;
  drawClock(true);
  setStatus(defaultStatus());
  refreshScreen();

  camPing();

  lastSensorMs = millis();
  lastPushMs = millis() - SENSOR_PUSH_MS + 3000;   // dorong pertama ~3 detik setelah boot
  lastSetpointMs = millis() - SETPOINT_POLL_MS + 5000;   // ambil setpoint ~5 detik setelah boot
  lastCaptureMs = millis();
  Serial.println("Siap. Perintah: c = foto, r = kalibrasi ulang, i = info");
}

void loop() {
  uint32_t now = millis();

  handleSerial();
  wifiKeepAlive();
  handleReed();

  if (now - lastSensorMs >= SENSOR_READ_MS) {
    lastSensorMs = now;
    readGases();
    readDht();
    applyControl();
    refreshScreen();
  }

  if (now - lastPushMs >= SENSOR_PUSH_MS) {
    lastPushMs = now;
    if (pushSensors()) { applyControl(); refreshScreen(); }
  }

  if (now - lastSetpointMs >= SETPOINT_POLL_MS) {
    lastSetpointMs = now;
    fetchSetpoints();
  }

#if SCHEDULE_CAPTURE_INTERVAL_MS > 0
  if (!capturing && now - lastCaptureMs >= SCHEDULE_CAPTURE_INTERVAL_MS) { pendingCapture = true; doorClosedAt = 0; }
#endif

  if (pendingCapture && !capturing &&
      (doorClosedAt == 0 || now - doorClosedAt >= CAPTURE_AFTER_DOOR_CLOSE_MS) &&
      now - lastCaptureMs >= MIN_CAPTURE_GAP_MS) {
    runCapture(doorClosedAt ? "pintu" : "jadwal/serial");
  }

  if (statusUntil && now > statusUntil) { statusUntil = 0; setStatus(defaultStatus()); }
  else if (!statusUntil) {
    String d = defaultStatus();
    if (d != statusText && statusText != "FOTO" && statusText != "KIRIM" && statusText != "WAKE") setStatus(d);
  }

  if (now - lastBlink >= 800) { lastBlink = now; dotOn = !dotOn; drawDot(); }
  drawClock(false);

  delay(5);
}
