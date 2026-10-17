// ============================================================================
// LUMBUNG CERDAS - SUB UNIT 1 (ESP32-CAM AI Thinker)
//
// Hanya mengambil foto atas perintah Central Unit lewat UART0 (GPIO1/GPIO3).
//
// Protokol (921600 baud, 8N1):
//   Central -> CAM : "CAP\n"
//   CAM -> Central : 0xAA 0x55 + panjang JPEG (4 byte, little-endian) + data JPEG
//                    gagal ambil foto = 0xAA 0x55 + 00 00 00 00
//   Central -> CAM : "PING\n"   -> CAM membalas "PONG\n" (uji koneksi, opsional)
//
// Wiring: 5V <- rail 5V, GND <- GND bersama,
//         U0T (GPIO1) -> GPIO16 Central, U0R (GPIO3) <- GPIO17 Central.
//         GPIO0 ke GND HANYA saat upload kode, lalu dilepas dan tekan RESET.
//         Lepas adaptor USB-serial saat dipasang ke Central (UART0 dipakai bersama).
//
// Arduino IDE: Board "AI Thinker ESP32-CAM", PSRAM Enabled,
//              Core Debug Level = None (log ESP-IDF tidak boleh masuk ke jalur data).
// TIDAK ADA Serial.print debug di sketch ini: UART0 adalah jalur data foto.
// ============================================================================
#include "esp_camera.h"
#include "esp_log.h"

// ───────────────────────────── KONFIGURASI ─────────────────────────────
#define CAM_BAUD          921600
#define MAX_JPEG_BYTES    60000UL      // harus <= JPEG_MAX_BYTES di central_unit
#define FRAME_SIZE        FRAMESIZE_VGA  // 640x480; naikkan ke SVGA bila foto kecil
#define START_QUALITY     12           // 10 (bagus) .. 63 (kecil); makin besar makin kecil berkas
#define CAM_VFLIP         0            // 1 bila gambar terbalik atas-bawah
#define CAM_HMIRROR       0            // 1 bila gambar tercermin
#define CHUNK_BYTES       1024

// Pin AI Thinker ESP32-CAM
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define FLASH_GPIO_NUM     4           // LED flash bawaan, dibiarkan mati

static bool camOk = false;

static bool initCamera() {
  camera_config_t c;
  memset(&c, 0, sizeof c);
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sscb_sda = SIOD_GPIO_NUM;
  c.pin_sscb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAME_SIZE;
  c.jpeg_quality = START_QUALITY;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  if (psramFound()) {
    c.fb_count = 2;
    c.grab_mode = CAMERA_GRAB_LATEST;    // selalu bingkai terbaru, bukan yang basi di antrean
  } else {
    c.fb_location = CAMERA_FB_IN_DRAM;
    c.frame_size = FRAMESIZE_QVGA;       // tanpa PSRAM hanya muat kecil
  }
  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, CAM_VFLIP);
    s->set_hmirror(s, CAM_HMIRROR);
  }
  return true;
}

static void sendFail() {
  const uint8_t h[6] = {0xAA, 0x55, 0, 0, 0, 0};
  Serial.write(h, sizeof h);
  Serial.flush();
}

static void doCapture() {
  if (!camOk) { sendFail(); return; }

  // Buang bingkai lama supaya eksposur dan white balance menyesuaikan cahaya sekitar.
  for (int i = 0; i < 3; i++) {
    camera_fb_t* d = esp_camera_fb_get();
    if (d) esp_camera_fb_return(d);
    delay(40);
  }

  sensor_t* s = esp_camera_sensor_get();
  static const int qualities[] = {START_QUALITY, 16, 20, 26, 32, 42};
  for (size_t i = 0; i < sizeof(qualities) / sizeof(qualities[0]); i++) {
    if (s) s->set_quality(s, qualities[i]);
    camera_fb_t* d = esp_camera_fb_get();     // bingkai pertama setelah ganti kualitas dibuang
    if (d) esp_camera_fb_return(d);
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) continue;
    if (fb->format != PIXFORMAT_JPEG || fb->len == 0 || fb->len > MAX_JPEG_BYTES) {
      esp_camera_fb_return(fb);
      continue;
    }
    uint32_t len = fb->len;
    uint8_t h[6] = {0xAA, 0x55, (uint8_t)len, (uint8_t)(len >> 8), (uint8_t)(len >> 16), (uint8_t)(len >> 24)};
    Serial.write(h, sizeof h);
    size_t sent = 0;
    while (sent < len) {
      size_t n = len - sent; if (n > CHUNK_BYTES) n = CHUNK_BYTES;
      Serial.write(fb->buf + sent, n);
      sent += n;
    }
    Serial.flush();
    esp_camera_fb_return(fb);
    if (s) s->set_quality(s, START_QUALITY);
    return;
  }
  if (s) s->set_quality(s, START_QUALITY);
  sendFail();
}

void setup() {
  esp_log_level_set("*", ESP_LOG_NONE);   // log ESP-IDF akan merusak aliran data
  pinMode(FLASH_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_GPIO_NUM, LOW);
  Serial.begin(CAM_BAUD);
  camOk = initCamera();
}

void loop() {
  static char buf[16];
  static uint8_t n = 0;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buf[n] = 0; n = 0;
      if (strcmp(buf, "CAP") == 0) doCapture();
      else if (strcmp(buf, "PING") == 0) { Serial.print("PONG\n"); Serial.flush(); }
      continue;
    }
    if (n < sizeof(buf) - 1) buf[n++] = ch;
    else n = 0;                       // baris terlalu panjang = sampah, buang
  }
  delay(2);
}
