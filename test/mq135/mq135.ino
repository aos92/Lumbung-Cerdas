// ============================================================================
// TES SENSOR MQ-135 (CO2 dan amonia) - ADC 3 = pin A2
// Board  : LGT8F328P / Pro Mini 5V (Arduino IDE 1.8.x)
// Library: MQUnifiedsensor (MQSensorsLib)
//
// Wiring : MQ-135 VCC -> 5V, GND -> GND, AOUT -> A2
// Serial Monitor: 115200 baud
// Satu sensor, dua gas: tiap siklus rumus diganti (CO2 lalu NH3).
// Kalibrasi R0 dilakukan saat start, lakukan di UDARA BERSIH setelah sensor panas.
// ============================================================================
#include <MQUnifiedsensor.h>

#define Board                ("Arduino UNO")
#define Pin                  (A2)     // ADC 3
#define Type                 ("MQ-135")
#define Voltage_Resolution   (5)
#define ADC_Bit_Resolution   (10)
#define RatioMQ135CleanAir   (3.6)    // RS/R0 di udara bersih
#define WARMUP_SECONDS       30

MQUnifiedsensor MQ135(Board, Voltage_Resolution, ADC_Bit_Resolution, Pin, Type);

void setup() {
  Serial.begin(115200);
  Serial.println(F("\n=== TES MQ-135 (A2) ==="));

  MQ135.setRegressionMethod(1);          // PPM = a * ratio^b
  MQ135.init();

  Serial.print(F("Pemanasan "));
  Serial.print(WARMUP_SECONDS);
  Serial.println(F(" detik..."));
  for (int i = 0; i < WARMUP_SECONDS; i++) {
    delay(1000);
    Serial.print('.');
  }
  Serial.println();

  Serial.print(F("Kalibrasi R0"));
  float calcR0 = 0;
  for (int i = 1; i <= 10; i++) {
    MQ135.update();
    calcR0 += MQ135.calibrate(RatioMQ135CleanAir);
    Serial.print('.');
    delay(100);
  }
  MQ135.setR0(calcR0 / 10);
  Serial.println(F(" selesai"));
  Serial.print(F("R0 = ")); Serial.println(calcR0 / 10);

  if (isinf(calcR0)) { Serial.println(F("ERROR: R0 tak hingga, kabel A2 putus / sensor tak dapat daya")); while (1); }
  if (calcR0 == 0)   { Serial.println(F("ERROR: R0 nol, A2 korslet ke GND")); while (1); }
}

void loop() {
  int raw = analogRead(Pin);

  MQ135.update();
  MQ135.setA(110.47); MQ135.setB(-2.862);   // CO2
  float co2 = MQ135.readSensor();

  MQ135.update();
  MQ135.setA(102.2);  MQ135.setB(-2.473);   // NH3 (amonia)
  float nh3 = MQ135.readSensor();

  Serial.print(F("ADC="));  Serial.print(raw);
  Serial.print(F("  V="));  Serial.print(raw * 5.0 / 1023.0, 2);
  Serial.print(F("  CO2=")); Serial.print(co2, 1);
  Serial.print(F(" ppm  NH3=")); Serial.print(nh3, 1);
  Serial.println(F(" ppm"));
  delay(500);
}
