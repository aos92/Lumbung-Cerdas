// ============================================================================
// TES SENSOR MQ-4 (metana / CH4) - ADC 1 = pin A0
// Board  : LGT8F328P / Pro Mini 5V (Arduino IDE 1.8.x)
// Library: MQUnifiedsensor (MQSensorsLib)
//
// Wiring : MQ-4 VCC -> 5V, GND -> GND, AOUT -> A0
// Serial Monitor: 115200 baud
// Kalibrasi R0 dilakukan saat start, lakukan di UDARA BERSIH setelah sensor panas.
// ============================================================================
#include <MQUnifiedsensor.h>

#define Board               ("Arduino UNO")
#define Pin                 (A0)      // ADC 1
#define Type                ("MQ-4")
#define Voltage_Resolution  (5)
#define ADC_Bit_Resolution  (10)
#define RatioMQ4CleanAir    (4.4)     // RS/R0 di udara bersih
#define WARMUP_SECONDS      30        // waktu pemanasan sebelum kalibrasi

MQUnifiedsensor MQ4(Board, Voltage_Resolution, ADC_Bit_Resolution, Pin, Type);

void setup() {
  Serial.begin(115200);
  Serial.println(F("\n=== TES MQ-4 (A0) ==="));

  MQ4.setRegressionMethod(1);          // PPM = a * ratio^b
  MQ4.setA(1012.7); MQ4.setB(-2.786);  // gas: CH4 (metana)
  MQ4.init();

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
    MQ4.update();
    calcR0 += MQ4.calibrate(RatioMQ4CleanAir);
    Serial.print('.');
    delay(100);
  }
  MQ4.setR0(calcR0 / 10);
  Serial.println(F(" selesai"));
  Serial.print(F("R0 = ")); Serial.println(calcR0 / 10);

  if (isinf(calcR0)) { Serial.println(F("ERROR: R0 tak hingga, kabel A0 putus / sensor tak dapat daya")); while (1); }
  if (calcR0 == 0)   { Serial.println(F("ERROR: R0 nol, A0 korslet ke GND")); while (1); }
}

void loop() {
  MQ4.update();
  float ppm = MQ4.readSensor();
  int raw = analogRead(Pin);

  Serial.print(F("ADC="));  Serial.print(raw);
  Serial.print(F("  V="));  Serial.print(raw * 5.0 / 1023.0, 2);
  Serial.print(F("  CH4=")); Serial.print(ppm, 1);
  Serial.println(F(" ppm"));
  delay(500);
}
