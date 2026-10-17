# Mengompilasi di ArduinoDroid (Android)

Central Unit memakai `WiFiClientSecure` dan `HTTPClient` bawaan core ESP32, jadi tidak perlu library HTTPS tambahan.

## Library yang dibutuhkan

| Sketch | Library |
|---|---|
| `central_unit` | TFT_eSPI, DHT sensor library (Adafruit), Adafruit Unified Sensor |
| `sub_unit_1` | tidak ada (`esp_camera` sudah ada di core ESP32) |

TFT_eSPI: `User_Setup.h` di folder library-nya harus sesuai pin di `esp32/README.md` (ILI9341, CS15 RST4 DC2 MOSI23 SCK18 MISO19, font GLCD/FONT2/FONT4).

## Papan

- Central Unit: "ESP32 Dev Module" (WROOM-32D).
- Sub Unit 1: "AI Thinker ESP32-CAM", PSRAM Enabled, Core Debug Level = None.
- Core ESP32 versi 2.x atau 3.x; bila memakai 3.x pastikan TFT_eSPI minimal 2.5.43.

## Bila gagal compile

Kirim pesan error lengkapnya; error dari ArduinoDroid dan Arduino IDE bisa berbeda.
