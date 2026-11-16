import test from "node:test";
import assert from "node:assert/strict";
import {
  filterSensors,
  filterSensorsByStatusAndSearch,
  isPercentageMetric,
  summarizeSensors,
  toSensorView,
} from "../battery.js";
import ExcelJS from "exceljs";
import { createBatteryWorkbook } from "../workbook.js";

test("recognizes explicit percentage metric names without guessing raw voltage units", () => {
  assert.equal(isPercentageMetric("battery_percent"), true);
  assert.equal(isPercentageMetric("BattPct"), true);
  assert.equal(isPercentageMetric("battery%"), true);
  assert.equal(isPercentageMetric("BatV"), false);
  assert.equal(isPercentageMetric("BattVoltage"), false);
  assert.equal(isPercentageMetric("Bat"), false);
});

test("keeps the last stored battery percentage when raw battery readings arrive later", () => {
  const sensor = toSensorView({
    sensor_name: "be002",
    protocol: "lorawan",
    model: "LDS-12-LWB",
    is_offline: false,
    battery_metric: "battery_percent",
    battery_value: 98.4252,
    battery_ts: "2026-11-16T07:08:20.887Z",
    last_seen: "2026-11-16T07:28:20.244Z",
  });

  assert.equal(sensor.batteryPercent, 98.4252);
  assert.equal(sensor.batteryMetric, "battery_percent");
  assert.equal(sensor.batteryTs, "2026-11-16T07:08:20.887Z");
  assert.equal(sensor.lastSeen, "2026-11-16T07:28:20.244Z");
});

test("capitalizes assigned names, marks offline devices zero, and leaves raw voltage unconverted", () => {
  const offline = toSensorView({
    sensor_name: "be004",
    protocol: "lorawan",
    model: "model-a",
    description: "Sensor in the north water tank",
    expected_interval_s: 30,
    is_offline: true,
    battery_metric: "BatV",
    battery_value: 3.6,
  });
  const voltageOnly = toSensorView({
    sensor_name: "ble-tag-001",
    protocol: "ble",
    model: "model-b",
    is_offline: false,
    battery_metric: "BattVoltage",
    battery_value: 3599,
  });

  assert.equal(offline.batteryPercent, 0);
  assert.equal(offline.sensorName, "BE004");
  assert.equal(offline.deviceId, "be004");
  assert.equal(offline.expectedIntervalSeconds, 30);
  assert.equal(offline.description, "Sensor in the north water tank");
  assert.equal(offline.status, "Not answering");
  assert.equal(voltageOnly.batteryPercent, null);
  assert.equal(voltageOnly.sensorName, "BLE-TAG-001");
  assert.equal(voltageOnly.batteryValue, 3599);
  assert.equal(voltageOnly.status, "Percent not reported");
});

test("applies percentage filters and summary counts to explicit percentages and offline sensors", () => {
  const sensors = [
    { batteryPercent: 49, isOffline: false, protocol: "lorawan" },
    { batteryPercent: 19, isOffline: false, protocol: "ble" },
    { batteryPercent: 0, isOffline: true, protocol: "lorawan" },
    { batteryPercent: null, isOffline: false, protocol: "ble" },
  ];

  assert.equal(filterSensors(sensors, "under50").length, 2);
  assert.equal(filterSensors(sensors, "under20").length, 1);
  assert.equal(filterSensors(sensors, "offline").length, 1);
  assert.deepEqual(filterSensors(sensors, "all", "ble"), [sensors[1], sensors[3]]);
  assert.deepEqual(filterSensors(sensors, "under50", "lorawan"), [sensors[0]]);
  assert.throws(() => filterSensors(sensors, "all", "unknown"), /Unknown sensor protocol/);
  assert.deepEqual(summarizeSensors(sensors), { total: 4, under50: 2, under20: 1, offline: 1 });
});

test("filters sensors by online status and asset ID or model search", () => {
  const sensors = [
    { sensorName: "BE002", model: "LDS-12-LWB", isOffline: false },
    { sensorName: "BB004", model: "DDS-45-LWB Distance Sensor", isOffline: true },
    { sensorName: "BN001", model: "AN-TS-010", isOffline: false },
  ];

  assert.deepEqual(filterSensorsByStatusAndSearch(sensors, "online"), [sensors[0], sensors[2]]);
  assert.deepEqual(filterSensorsByStatusAndSearch(sensors, "offline"), [sensors[1]]);
  assert.deepEqual(filterSensorsByStatusAndSearch(sensors, "all", " bb00 "), [sensors[1]]);
  assert.deepEqual(filterSensorsByStatusAndSearch(sensors, "online", "lds-12"), [sensors[0]]);
  assert.throws(() => filterSensorsByStatusAndSearch(sensors, "unknown"), /Unknown connection status/);
});

test("creates an Excel workbook with the supplied filtered sensor rows", async () => {
  const buffer = await createBatteryWorkbook([
    {
      sensorName: "SENSOR-A",
      protocol: "lorawan",
      model: "model-a",
      description: "Sensor in the north water tank",
      location: "Room 1",
      batteryPercent: 42,
      batteryMetric: "battery_percent",
      batteryValue: 42,
      batteryTs: "2026-11-16T05:30:00.000Z",
      lastSeen: "2026-11-16T05:30:00.000Z",
      status: "Online",
    },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Sensor batteries");

  assert.ok(sheet);
  assert.equal(sheet.getCell("A1").value, "Assigned Asset Id");
  assert.equal(sheet.getCell("E2").value, 42);
  assert.equal(sheet.getCell("A2").value, "SENSOR-A");
  assert.equal(sheet.getCell("B2").value, "lorawan");
  assert.equal(sheet.getCell("D1").value, "Description");
  assert.equal(sheet.getCell("D2").value, "Sensor in the north water tank");
});
