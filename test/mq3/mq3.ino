// ============================================================================
// TES SENSOR MQ-3 (alkohol / etanol) - ADC 2 = pin A1
// Board  : LGT8F328P / Pro Mini 5V (Arduino IDE 1.8.x)
// Library: MQUnifiedsensor (MQSensorsLib)
//
// Wiring : MQ-3 VCC -> 5V, GND -> GND, AOUT -> A1
// Serial Monitor: 115200 baud
// Kalibrasi R0 dilakukan saat start, lakukan di UDARA BERSIH setelah sensor panas.
// ============================================================================
#include <MQUnifiedsensor.h>

#define Board               ("Arduino UNO")
#define Pin                 (A1)      // ADC 2
#define Type                ("MQ-3")
#define Voltage_Resolution  (5)
#define ADC_Bit_Resolution  (10)
#define RatioMQ3CleanAir    (60)      // RS/R0 di udara bersih
#define WARMUP_SECONDS      30

MQUnifiedsensor MQ3(Board, Voltage_Resolution, ADC_Bit_Resolution, Pin, Type);

void setup() {
  Serial.begin(115200);
  Serial.println(F("\n=== TES MQ-3 (A1) ==="));

  MQ3.setRegressionMethod(1);            // PPM = a * ratio^b
  MQ3.setA(0.3934); MQ3.setB(-1.504);    // gas: alkohol
  MQ3.init();

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
    MQ3.update();
    calcR0 += MQ3.calibrate(RatioMQ3CleanAir);
    Serial.print('.');
    delay(100);
  }
  MQ3.setR0(calcR0 / 10);
  Serial.println(F(" selesai"));
  Serial.print(F("R0 = ")); Serial.println(calcR0 / 10);

  if (isinf(calcR0)) { Serial.println(F("ERROR: R0 tak hingga, kabel A1 putus / sensor tak dapat daya")); while (1); }
  if (calcR0 == 0)   { Serial.println(F("ERROR: R0 nol, A1 korslet ke GND")); while (1); }
}

void loop() {
  MQ3.update();
  float ppm = MQ3.readSensor();
  int raw = analogRead(Pin);

  Serial.print(F("ADC="));  Serial.print(raw);
  Serial.print(F("  V="));  Serial.print(raw * 5.0 / 1023.0, 2);
  Serial.print(F("  Alkohol=")); Serial.print(ppm, 2);
  Serial.println(F(" ppm"));
  delay(500);
}
