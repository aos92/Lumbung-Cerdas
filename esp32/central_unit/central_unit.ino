// ============================================================================
// LUMBUNG CERDAS - CENTRAL UNIT (ESP32 WROOM-32D)
//
// Satu kotak: Central Unit (sensor gas + BME280 + reed + TFT + WiFi) dan
// Sub Unit 1 (ESP32-CAM, hanya mengambil foto lewat UART).
//
// Alur:
//   - Tiap SENSOR_READ_MS   : baca MQ-135 (CO2, NH3), MQ-4 (CH4), MQ-3 (alkohol), BME280 (suhu, RH).
//   - Tiap SENSOR_PUSH_MS   : POST /api/sensors ke backend (Render).
//   - Pintu dibuka lalu ditutup (reed) atau jadwal rutin -> "CAP\n" ke ESP32-CAM
//     -> JPEG lewat UART -> POST /api/fruit?format=full (sensor ikut) -> hasil di TFT.
//   - KONTROL (5 setpoint dari aplikasi Android, lewat GET /api/setpoints, disimpan di flash):
//       Kipas   ON bila suhu/CO2/metana/alkohol/kelembaban >= setpoint; mati bila semuanya di bawah.
//       Peltier ON bila suhu >= setpoint suhu (mendinginkan).
//
// Board  : "ESP32 Dev Module" (WROOM-32D)
// Library: TFT_eSPI, Adafruit BME280 Library + Adafruit Unified Sensor + Adafruit BusIO.
// Serial Monitor: 115200 baud.
//   Perintah: c = foto, r = kalibrasi ulang R0, i = info, t = uji backend, d = diagnosa BME280 (I2C scan + uji nilai berubah),
//             g = cek foto terakhir di backend (GET /api/image)
//
// Pin:
//   TFT: CS15 RST4 DC2 MOSI23 SCK18 MISO19 (diatur di User_Setup TFT_eSPI)
//   MQ-135=36  MQ-4=39  MQ-3=34 (ADC1, pembagi tegangan 10k/20k)
//   BME280 (I2C): SDA=21  SCL=22  VCC=3V3  GND  (alamat 0x76 atau 0x77, otomatis)
//   Reed=32 (ke GND, INPUT_PULLUP)
//   UART2: RX=16 TX=17 (ke ESP32-CAM)
//   Keluaran: 33 = Peltier, 14 = kipas
// ============================================================================
#include <WiFi.h>
#include <ESP32ClientSecure.h>   // HTTPS ke backend Render
#include <HTTPClient.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <time.h>
#include <math.h>
#include <Preferences.h>

static inline bool isFiniteF(float v) { return (v == v) && (v - v == 0.0f); }

#if !defined(ESP_ARDUINO_VERSION_MAJOR)
#include <esp_adc_cal.h>
static uint32_t analogReadMilliVolts(uint8_t pin) {
  static esp_adc_cal_characteristics_t chars;
  static bool init = false;
  if (!init) {
    analogSetAttenuation(ADC_11db);
    esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12, 1100, &chars);
    init = true;
  }
  return esp_adc_cal_raw_to_voltage(analogRead(pin), &chars);
}
#endif

// ───────────────────────────── KONFIGURASI ─────────────────────────────
#define WIFI_SSID      "android"
#define WIFI_PASSWORD  "1234567890"
#define BACKEND_URL    "https://fruit-api-jmer.onrender.com"   // tanpa "/" di akhir
#define API_KEY        "4dece5ae2bbe1657c2c7cee0"               // sama dengan SHARED_SECRET di Render
#define BATCH_ID       ""   // opsional: huruf/angka/-_. maks 40, tanpa spasi
#define PATH_IMAGE     "/api/image"   // foto terakhir di backend (dipakai aplikasi lewat komponen Image); foto diunggah lewat POST /api/fruit

// Pin
#define PIN_MQ135      36
#define PIN_MQ4        39
#define PIN_MQ3        34
#define PIN_I2C_SDA    21      // BME280 SDA
#define PIN_I2C_SCL    22      // BME280 SCL
#define PIN_REED       32      // reed ke GND, INPUT_PULLUP
#define PIN_CAM_RX     16      // <- TX ESP32-CAM
#define PIN_CAM_TX     17      // -> RX ESP32-CAM
#define PIN_PELTIER    33
#define PIN_FAN        14

// Perilaku
#define AUTO_KONTROL                 1
#define OUTPUT_ACTIVE_HIGH           1
#define SCHEDULE_CAPTURE_INTERVAL_MS 1800000UL
#define CAPTURE_AFTER_DOOR_CLOSE_MS  2000UL
#define MIN_CAPTURE_GAP_MS           15000UL
#define SENSOR_READ_MS               2500UL
#define SENSOR_PUSH_MS               10000UL
#define SCREEN_ROTATION              1

// BME280
#define BME_MAX_FAIL                 6          // gagal berturut-turut sebelum dianggap putus
#define BME_STUCK_READS              40         // pembacaan beruntun IDENTIK (suhu+RH+tekanan) = dianggap beku -> init ulang (40 x 2,5 dtk = 100 dtk)
#define BME_DEBUG                    1          // 1 = cetak status BME280 ke Serial
#define BME_TEMP_OFFSET              0.0f       // koreksi suhu (derajat C), mis. -0.5 bila sensor kena panas PCB
#define BME_HUM_OFFSET               0.0f       // koreksi RH (persen)

// Setpoint bawaan
#define SP_CO2_DEFAULT               2500.0f
#define SP_CH4_DEFAULT               100.0f
#define SP_ALC_DEFAULT               50.0f
#define SP_TEMP_DEFAULT              15.0f   // kotak penyimpanan: suhu >= 15 C -> Peltier aktif (pendingin)
#define SP_HUM_DEFAULT               85.0f
#define SETPOINT_POLL_MS             30000UL

#define HYST_TEMP                    0.5f
#define HYST_HUM                     2.0f
#define HYST_GAS_FRAC                0.05f
#define OUTPUT_MIN_ON_MS             10000UL
#define PELTIER_COOLING              1
#define HUM_CONTROLS_FAN             1

// UART ke ESP32-CAM
#define CAM_BAUD               921600
#define JPEG_MAX_BYTES         61440UL
#define CAM_HEADER_TIMEOUT_MS  8000UL
#define CAM_IDLE_TIMEOUT_MS    2500UL

// Sensor gas
#define DIVIDER_GAIN     1.5f
#define VCC_MQ           5.0f
#define RL_KOHM          10.0f
#define ADC_SAMPLES      16
#define WARMUP_SECONDS   20
#define CO2_BASELINE_PPM 400.0f
#define ALCOHOL_SCALE    530.0f
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
Adafruit_BME280 bme;
bool bmeReady = false;

static float readRs(uint8_t pin, float* voltsOut = nullptr);
static void  textAt(const char* s, int x, int y, uint16_t fg, uint16_t bg, uint8_t font, uint8_t datum = TL_DATUM);
static void  setStatus(const String& s, uint32_t holdMs = 0);
static void  bootLine(int row, const char* s, uint16_t col = C_CYAN);

// ───────────────────────────── STATE ─────────────────────────────
struct MQSensor { const char* name; uint8_t pin; float cleanRatio; float r0; bool ok; };
static void calibrateOne(MQSensor& s);
MQSensor mq135 = {"MQ-135", PIN_MQ135, 3.6f, R0_MQ135, false};
MQSensor mq4   = {"MQ-4",   PIN_MQ4,   4.4f, R0_MQ4,   false};
MQSensor mq3   = {"MQ-3",   PIN_MQ3,   60.0f, R0_MQ3,  false};

float gCo2 = NAN, gNh3 = NAN, gCh4 = NAN, gAlc = NAN;
float gTemp = NAN, gHum = NAN, gPress = NAN;   // gPress (hPa) hanya untuk log/info, tidak dikirim ke backend
uint8_t bmeAddr = 0;
int   bmeSameCount = 0;
float bmeLastT = NAN, bmeLastH = NAN, bmeLastP = NAN;
bool  haveBme = false;
int   bmeFail = 0;
uint32_t lastBmeInitMs = 0;
bool  gasReady = false;

String sensorClass = "";
String photoClass  = "";
String fruitName   = "";
String photoScore  = "-";
String photoRisk   = "-";
bool   fanOn = false, peltierOn = false;

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

static String backendBase() { return String(BACKEND_URL); }

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static float ema(float cur, float x) { return isnan(cur) ? x : cur + 0.3f * (x - cur); }

static bool sensorsReady() {
  return gasReady && haveBme && !isnan(gCo2) && !isnan(gNh3) && !isnan(gAlc) && !isnan(gCh4);
}

// ───────────────────────────── SENSOR GAS ─────────────────────────────
static float readSensorVolts(uint8_t pin) {
  uint32_t sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) { sum += analogReadMilliVolts(pin); delayMicroseconds(300); }
  return (sum / (float)ADC_SAMPLES) * DIVIDER_GAIN / 1000.0f;
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
  if (s.r0 > 0) { s.ok = true; return; }
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
  if (avgV > 3.2f) Serial.printf("[%s] PERINGATAN: AO %.2f V tinggi (ADC jenuh), cek udara/pembagi\n", s.name, avgV);
  s.r0 = r0;
  s.ok = isFiniteF(r0) && r0 > 0.05f;
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
  if (!isFiniteF(co2) || !isFiniteF(nh3) || !isFiniteF(ch4) || !isFiniteF(alc)) return;
  gCo2 = ema(gCo2, clampf(co2, 0, 10000));
  gNh3 = ema(gNh3, clampf(nh3, 0, 1000));
  gCh4 = ema(gCh4, clampf(ch4, 0, 10000));
  gAlc = ema(gAlc, clampf(alc, 0, 5000));
}

// ───────────────────────────── BME280 (I2C) ─────────────────────────────
static bool bmeInit() {
  // Persis seperti sketch uji yang berhasil: Wire.begin(SDA,SCL) + bme.begin(addr,&Wire),
  // tanpa setClock/setSampling (pakai pengaturan bawaan library).
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  bmeAddr = 0;
  if (bme.begin(0x76, &Wire))      bmeAddr = 0x76;
  else if (bme.begin(0x77, &Wire)) bmeAddr = 0x77;
  bool ok = (bmeAddr != 0);
  bmeReady = ok;
  if (ok) {
    Serial.printf("[bme] BME280 siap di 0x%02X (chip ID 0x%02X)\n", bmeAddr, (unsigned)bme.sensorID());
  } else {
    Serial.printf("[bme] BME280 tidak ditemukan di SDA=%d SCL=%d (alamat 0x76/0x77). Ketik 'd' untuk diagnosa.\n", PIN_I2C_SDA, PIN_I2C_SCL);
  }
  lastBmeInitMs = millis();
  return ok;
}

// Satu pembacaan; true bila nilai valid.
static bool bmeReadOnce(float& t, float& h) {
  t = bme.readTemperature();
  h = bme.readHumidity();
  if (isnan(t) || isnan(h)) {
#if BME_DEBUG
    Serial.printf("[bme] baca NaN (T=%s H=%s) -> I2C putus / chip bukan BME280\n", isnan(t) ? "NaN" : "ok", isnan(h) ? "NaN" : "ok");
#endif
    return false;
  }
  t += BME_TEMP_OFFSET;
  h += BME_HUM_OFFSET;
  if (t < -40.0f || t > 85.0f) {
#if BME_DEBUG
    Serial.printf("[bme] suhu di luar rentang: %.2f\n", t);
#endif
    return false;
  }
  if (h < 0.0f || h > 110.0f) {
#if BME_DEBUG
    Serial.printf("[bme] RH di luar rentang: %.2f\n", h);
#endif
    return false;
  }
  return true;
}

static void readBme() {
  if (!bmeReady) {
    // Coba inisialisasi ulang tiap 5 detik (sensor dicolok belakangan / kabel goyang).
    if (millis() - lastBmeInitMs >= 5000UL) bmeInit();
    if (!bmeReady) { haveBme = false; return; }
  }

  float t = NAN, h = NAN;
  bool ok = bmeReadOnce(t, h);
  if (!ok) {
    delay(20);
    ok = bmeReadOnce(t, h);
  }

  if (!ok) {
    if (bmeFail < 1000) bmeFail++;
    if (bmeFail >= BME_MAX_FAIL) { haveBme = false; bmeReady = false; }   // paksa init ulang
#if BME_DEBUG
    Serial.printf("[bme] GAGAL (%d berturut-turut) T=%.1f H=%.1f | ketik 'd' untuk diagnosa\n", bmeFail, t, h);
#endif
    return;
  }
  bmeFail = 0;
  haveBme = true;
  gTemp = t;
  gHum = clampf(h, 0, 100);
  float pr = bme.readPressure() / 100.0f;
  gPress = (pr > 300.0f && pr < 1100.0f) ? pr : NAN;

  // Deteksi nilai beku: BME280 mode normal x16 selalu bergoyang di digit terakhir. Bila suhu, RH dan tekanan
  // IDENTIK berkali-kali, jangan percaya angkanya: tandai sensor tidak valid dan init ulang (soft reset chip).
  if (t == bmeLastT && h == bmeLastH && pr == bmeLastP) {
    if (++bmeSameCount >= BME_STUCK_READS) {
      Serial.printf("[bme] NILAI BEKU %d kali (T=%.2f H=%.2f P=%.2f) -> init ulang I2C + BME280\n", bmeSameCount, t, h, pr);
      bmeSameCount = 0;
      haveBme = false;
      bmeReady = false;
      Wire.end();
      lastBmeInitMs = 0;     // boleh init ulang segera
      return;
    }
  } else {
    bmeSameCount = 0;
  }
  bmeLastT = t; bmeLastH = h; bmeLastP = pr;
#if BME_DEBUG
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 10000UL) {
    lastLog = millis();
    Serial.printf("[bme] OK T=%.1f C H=%.1f %% P=%.1f hPa\n", gTemp, gHum, gPress);
  }
#endif
}

// Diagnosa lewat Serial (perintah 'd'): I2C scan + chip ID + pembacaan.
static void bmeDiagnose() {
  Serial.printf("[bme] === DIAGNOSA BME280 (SDA=%d SCL=%d) ===\n", PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf("[bme] perangkat I2C di 0x%02X\n", a); found++; }
  }
  if (!found) {
    Serial.println("[bme] TIDAK ADA perangkat I2C. Cek: SDA->GPIO21, SCL->GPIO22 (jangan tertukar), VCC 3V3, GND, solderan pin modul.");
    return;
  }
  bool ok = bmeInit();
  if (!ok) {
    Serial.println("[bme] ada perangkat I2C tetapi bukan BME280. Chip ID BMP280 = 0x56-0x58 (tanpa sensor kelembaban); BME280 harus 0x60.");
    return;
  }
  delay(100);
  float t, h;
  bool v = bmeReadOnce(t, h);
  Serial.printf("[bme] T=%.2f C  H=%.2f %%  P=%.1f hPa  %s\n", t, h, bme.readPressure() / 100.0f, v ? "(OK)" : "(TIDAK VALID)");

  // Uji berubah/tidak: 10 sampel tiap 600 ms. Hembuskan napas ke sensor selama uji: RH harus naik jelas (>5 %).
  Serial.println("[bme] uji perubahan 10 sampel (hembuskan napas ke sensor sekarang)...");
  float tMin = 1e9f, tMax = -1e9f, hMin = 1e9f, hMax = -1e9f, pMin = 1e9f, pMax = -1e9f;
  int okN = 0;
  for (int i = 0; i < 10; i++) {
    float tt, hh;
    if (bmeReadOnce(tt, hh)) {
      float pp = bme.readPressure() / 100.0f;
      okN++;
      if (tt < tMin) tMin = tt; if (tt > tMax) tMax = tt;
      if (hh < hMin) hMin = hh; if (hh > hMax) hMax = hh;
      if (pp < pMin) pMin = pp; if (pp > pMax) pMax = pp;
      Serial.printf("[bme]   #%d T=%.2f H=%.2f P=%.2f\n", i + 1, tt, hh, pp);
    }
    delay(600);
  }
  if (okN == 0) { Serial.println("[bme] semua sampel gagal dibaca -> cek kabel/solder/daya."); return; }
  bool same = (tMax == tMin) && (hMax == hMin) && (pMax == pMin);
  Serial.printf("[bme] rentang T %.2f..%.2f  H %.2f..%.2f  P %.2f..%.2f\n", tMin, tMax, hMin, hMax, pMin, pMax);
  if (same) Serial.println("[bme] HASIL: SEMUA SAMA PERSIS -> sensor beku/komunikasi bermasalah (cek solder SDA/SCL, VCC 3V3, kabel pendek, ganti modul).");
  else if (hMax - hMin < 5.0f) Serial.println("[bme] HASIL: nilai bergoyang kecil. Bila TIDAK ada napas yang terhembus, ini normal (ruangan stabil); bila ada napas tetapi RH tidak naik >5 %, sensor RH patut dicurigai.");
  else Serial.println("[bme] HASIL: RH merespons napas -> sensor HIDUP dan nilainya nyata.");
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
  if (!haveBme) return "BME ERR";
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
  int v = haveBme ? (int)roundf(gTemp * 10) : -9998;
  if (v == last) return;
  last = v;
  int x = CARD_X1, y = ROW1_Y;
  tft.fillRect(x + 6, y + 17, CARD_W - 12, 29, C_BLACK);
  char b[12];
  if (haveBme) snprintf(b, sizeof b, "%.1f", gTemp); else strcpy(b, "--.-");
  textAt(b, x + 7, y + 18, C_PALE, C_BLACK, 4);
  int tw = tft.textWidth(b, 4);
  tft.drawCircle(x + 7 + tw + 8, y + 22, 3, C_LIME);
  textAt("C", x + 7 + tw + 14, y + 18, C_LIME, C_BLACK, 4);
  drawBar(x + 7, y + 49, CARD_W - 14, haveBme ? gTemp / 60.0f : 0, C_GREEN);
}

static void drawHum() {
  static int last = -9999;
  int v = haveBme ? (int)roundf(gHum * 10) : -9998;
  if (v == last) return;
  last = v;
  int x = CARD_X2, y = ROW1_Y;
  tft.fillRect(x + 6, y + 17, CARD_W - 12, 29, C_BLACK);
  char b[12];
  if (haveBme) snprintf(b, sizeof b, "%.1f", gHum); else strcpy(b, "--.-");
  textAt(b, x + 7, y + 18, C_PALE, C_BLACK, 4);
  int tw = tft.textWidth(b, 4);
  textAt("%", x + 7 + tw + 6, y + 18, C_CYAN, C_BLACK, 4);
  drawBar(x + 7, y + 49, CARD_W - 14, haveBme ? gHum / 100.0f : 0, C_CYAN);
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
  drawGasRow(1, "CH4 (Metana)",    gCh4, C_ORANGE,  c1);
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

static bool latchAbove(bool cur, float v, float sp, float hyst) {
  if (isnan(v)) return false;
  if (v >= sp) return true;
  if (v <= sp - hyst) return false;
  return cur;
}

static bool settle(bool cur, bool want, uint32_t& onSince) {
  uint32_t now = millis();
  if (want && !cur) { onSince = now; return true; }
  if (!want && cur && now - onSince >= OUTPUT_MIN_ON_MS) return false;
  return cur;
}

static void applyControl() {
  static bool tAbove = false, cAbove = false, mAbove = false, aAbove = false, hAbove = false;
  tAbove = latchAbove(tAbove, haveBme ? gTemp : NAN, spTemp, HYST_TEMP);
  cAbove = latchAbove(cAbove, gCo2, spCo2, spCo2 * HYST_GAS_FRAC);
  mAbove = latchAbove(mAbove, gCh4, spCh4, spCh4 * HYST_GAS_FRAC);
  aAbove = latchAbove(aAbove, gAlc, spAlc, spAlc * HYST_GAS_FRAC);
#if HUM_CONTROLS_FAN
  hAbove = latchAbove(hAbove, haveBme ? gHum : NAN, spHum, HYST_HUM);
#else
  hAbove = false;
#endif
  bool wantFan = tAbove || cAbove || mAbove || aAbove || hAbove;
#if PELTIER_COOLING
  bool wantPeltier = haveBme && tAbove;
#else
  bool wantPeltier = haveBme && !tAbove;
#endif
  peltierOn = settle(peltierOn, wantPeltier, peltierOnSince);
  fanOn = settle(fanOn, wantFan || peltierOn, fanOnSince);
#if AUTO_KONTROL
  writeOut(PIN_FAN, fanOn);
  writeOut(PIN_PELTIER, peltierOn);
#endif
}

// ───────────────────────────── SETPOINT (NVS + BACKEND) ─────────────────────────────
static void loadSetpoints() {
  prefs.begin("lumbung", false);
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
static bool fetchSetpoints() {
  if (WiFi.status() != WL_CONNECTED) return false;
  ESP32ClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(12000);
  if (!http.begin(client, backendBase() + "/api/setpoints?format=text")) return false;
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
  String url = backendBase() + "/api/sensors?format=text&" + q;
  ESP32ClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(12000);
  if (!http.begin(client, url)) return false;
  http.addHeader("x-api-key", API_KEY);
  int code = http.POST("");
  bool ok = false;
  if (code == 200) {
    String body = http.getString(); body.trim();
    String f[4]; int n = splitPipe(body, f, 4);
    if (n >= 4 && f[0] == "OK") { sensorClass = (f[3] == "-") ? "" : f[3]; ok = true; }
  } else {
    Serial.printf("[sensors] HTTP %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  }
  http.end();
  if (ok) lastPushOkMs = millis();
  return ok;
}

static void wakeServer() {
  for (int i = 0; i < 3; i++) {
    ESP32ClientSecure client; client.setInsecure();
    HTTPClient http;
    http.setConnectTimeout(20000);
    http.setTimeout(30000);
    if (!http.begin(client, backendBase() + "/health")) return;
    int code = http.GET();
    http.end();
    if (code == 200) return;
    delay(1000);
  }
}

// 0 = OK; 1 = WiFi putus; 2 = server tak terjangkau; 3 = API_KEY salah (401); 4 = balasan lain.
static int checkBackend(bool quick) {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[server] WiFi belum tersambung"); return 1; }
  String base = backendBase();
  Serial.printf("[server] uji %s | IP ESP32 %s | gateway %s\n", base.c_str(),
                WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
  int code; String err;
  {
    ESP32ClientSecure client; client.setInsecure(); HTTPClient http;
    http.setConnectTimeout(quick ? 5000 : 20000); http.setTimeout(quick ? 8000 : 60000);
    if (!http.begin(client, base + "/health")) { Serial.println("[server] URL tidak valid"); return 2; }
    code = http.GET();
    if (code < 0) err = http.errorToString(code);
    http.end();
  }
  if (code != 200) {
    Serial.printf("[server] /health GAGAL code=%d %s\n", code, err.c_str());
    Serial.println("[server] cek: WiFi punya internet? Service Render berstatus Live? BACKEND_URL benar?");
    return 2;
  }
  Serial.println("[server] /health OK");
  {
    ESP32ClientSecure client; client.setInsecure(); HTTPClient http;
    http.setConnectTimeout(5000); http.setTimeout(8000);
    if (!http.begin(client, base + "/api/setpoints?format=text")) return 2;
    http.addHeader("x-api-key", API_KEY);
    code = http.GET();
    http.end();
  }
  if (code == 401) { Serial.println("[server] 401: API_KEY di sketch != SHARED_SECRET di .env"); return 3; }
  if (code != 200) { Serial.printf("[server] /api/setpoints code=%d\n", code); return 4; }
  Serial.println("[server] API_KEY cocok, backend Render terhubung");
  return 0;
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
  if (!jpegBuf) { Serial.println("[capture] ditolak: buffer JPEG tidak ada"); setStatus("HEAP ERR", 4000); return; }
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
  readGases();

  setStatus("KIRIM");
  char q[220]; sensorQuery(q, sizeof q);
  String url = backendBase() + "/api/fruit?format=full&" + q;
  if (strlen(BATCH_ID) > 0) url += String("&batch=") + BATCH_ID;

  ESP32ClientSecure client; client.setInsecure();
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
      Serial.printf("[capture] foto tersimpan di backend: GET %s (aplikasi menampilkannya)\n", PATH_IMAGE);
      setStatus("HASIL OK", 4000);
    } else {
      setStatus("BUKAN BUAH", 5000);
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
// Reed antara GPIO32 dan GND, INPUT_PULLUP: pintu tertutup (magnet dekat) = LOW, terbuka = HIGH.
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

// Cek foto terakhir di backend (GET PATH_IMAGE): tampilkan kode HTTP, ukuran, dan id foto, tanpa mengunduh isinya.
static void checkImage() {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[image] WiFi putus"); return; }
  ESP32ClientSecure client; client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(20000);
  http.setTimeout(30000);
  const char* keys[] = {"X-Image-Id", "X-Image-Time"};
  http.collectHeaders(keys, 2);
  if (!http.begin(client, backendBase() + PATH_IMAGE)) { Serial.println("[image] begin gagal"); return; }
  http.addHeader("x-api-key", API_KEY);
  int code = http.GET();
  if (code == 200) {
    Serial.printf("[image] OK %d byte, id=%s, waktu=%s\n", http.getSize(), http.header("X-Image-Id").c_str(), http.header("X-Image-Time").c_str());
  } else if (code == 404) {
    Serial.println("[image] belum ada foto di backend (ketik c untuk memotret)");
  } else {
    Serial.printf("[image] HTTP %d %s\n", code, code > 0 ? "" : http.errorToString(code).c_str());
  }
  http.end();
}

// ───────────────────────────── SERIAL ─────────────────────────────
static void printInfo() {
  Serial.printf("CO2=%.0f NH3=%.1f CH4=%.1f ALK=%.2f T=%.1f H=%.1f P=%.1f BME=%s | R0: 135=%.3f 4=%.3f 3=%.3f | kelas sensor=%s foto=%s | heap=%u\n",
                gCo2, gNh3, gCh4, gAlc, gTemp, gHum, gPress, haveBme ? "OK" : "ERR", mq135.r0, mq4.r0, mq3.r0,
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
    else if (c == 't') checkBackend(false);
    else if (c == 'd') bmeDiagnose();
    else if (c == 'g') checkImage();
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

  pinMode(PIN_REED, INPUT_PULLUP);   // GPIO32 punya pull-up internal; reed disambung ke GND
  doorOpen = (digitalRead(PIN_REED) == HIGH);
  attachInterrupt(digitalPinToInterrupt(PIN_REED), onReed, CHANGE);

  bmeInit();                     // BME280 (I2C) dinyalakan lebih awal

  tft.init();
  if (!bmeReady) bmeInit();      // coba lagi setelah TFT menyala (jaga-jaga bila pin/daya sempat terganggu)
  tft.setRotation(SCREEN_ROTATION);
  tft.fillScreen(C_BLACK);
  tft.drawRoundRect(0, 0, 320, 240, 8, C_BORDER);
  bootLine(0, "LUMBUNG CERDAS", C_LIME);

  jpegBuf = (uint8_t*)malloc(JPEG_MAX_BYTES);
  if (!jpegBuf) { bootLine(1, "ERR: heap kurang (JPEG)", C_RED); Serial.println("malloc JPEG gagal"); }

  Serial2.setRxBufferSize(8192);
  Serial2.begin(CAM_BAUD, SERIAL_8N1, PIN_CAM_RX, PIN_CAM_TX);

  loadSetpoints();

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

  {
    bootLine(4, "Uji server Render...");
    int sc = checkBackend(true);
    if (sc == 0)      bootLine(4, "Server Render: TERHUBUNG", C_GREEN);
    else if (sc == 3) bootLine(4, "Server: API_KEY SALAH", C_RED);
    else if (sc == 1) bootLine(4, "Server: tanpa WiFi", C_ORANGE);
    else              bootLine(4, "Server: belum siap (Render tidur?)", C_ORANGE);
  }

  // Pemanasan MQ; BME280 dibaca tiap 5 detik selama pemanasan.
  for (int s = WARMUP_SECONDS; s > 0; s--) {
    char b[40]; snprintf(b, sizeof b, "Pemanasan sensor: %d detik", s);
    bootLine(2, b);
    if (s % 5 == 0) { readBme(); applyControl(); }
    delay(1000);
  }
  bootLine(3, "Kalibrasi R0 (udara bersih)...");
  calibrateAll();
  bootLine(3, gasReady ? "Kalibrasi selesai" : "Kalibrasi GAGAL, cek Serial", gasReady ? C_GREEN : C_RED);
  readBme();
  if (!haveBme) {
    bootLine(5, "BME280 GAGAL (ketik d di Serial)", C_RED);
    Serial.println("[bme] pembacaan awal gagal. Ketik 'd' untuk diagnosa.");
  } else {
    bootLine(5, "BME280 OK", C_GREEN);
  }
  delay(300);

  drawStatic();
  lastSecond = -1;
  drawClock(true);
  setStatus(defaultStatus());
  refreshScreen();

  camPing();

  lastSensorMs = millis();
  lastPushMs = millis() - SENSOR_PUSH_MS + 3000;
  lastSetpointMs = millis() - SETPOINT_POLL_MS + 5000;
  lastCaptureMs = millis();
  Serial.println("Siap. Perintah: c = foto, r = kalibrasi ulang, i = info, t = uji server, d = diagnosa BME280, g = cek foto di server");
}

void loop() {
  uint32_t now = millis();

  handleSerial();
  wifiKeepAlive();
  handleReed();

  if (now - lastSensorMs >= SENSOR_READ_MS) {
    lastSensorMs = now;
    readGases();
    readBme();
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
