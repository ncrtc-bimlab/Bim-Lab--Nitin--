import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  allowedFieldsForDevice,
  filterUplinkMetrics,
  parseAllowedFields,
  parseAllowedFieldsByModel,
  parseDeviceStatus,
  parseMetricMap,
  parseUplink,
} from "../src/uplink.js";

const topic = "application/distance/device/0123456789ABCDEF/event/up";

describe("allowedFieldsForDevice", () => {
  const defaultFields = new Set(["Bat"]);
  const modelFields = { "LDS-40-LWB": new Set(["Bat", "Lidar_distance"]) };

  it("uses an explicitly configured model allowlist", () => {
    expect(
      allowedFieldsForDevice(
        "LDS-40-LWB",
        "a840414b356036a2",
        "LDS12-LWB",
        undefined,
        defaultFields,
        modelFields,
      ),
    ).toBe(modelFields["LDS-40-LWB"]);
  });

  it("uses the shared allowlist for the configured default model", () => {
    expect(
      allowedFieldsForDevice(
        "LDS-12-LWB",
        "a84041196b6036a5",
        "LDS12-LWB",
        undefined,
        defaultFields,
        modelFields,
      ),
    ).toBe(defaultFields);
  });

  it("accepts finite numeric fields for newly added, unconfigured models", () => {
    expect(
      allowedFieldsForDevice(
        "AN-TS-010-LWB Structure Tilt Sensor",
        "a840412ae160369f",
        "LDS12-LWB",
        undefined,
        defaultFields,
        modelFields,
      ),
    ).toBeUndefined();
  });
});

describe("parseUplink", () => {
  it("extracts numeric decoded fields without inventing field names", () => {
    const uplink = parseUplink(
      Buffer.from(
        JSON.stringify({
          deviceInfo: { devEui: "0123456789ABCDEF" },
          time: "2026-11-05T10:00:00Z",
          object: { distance: 412, battery: 3.6, status: "ok" },
          rxInfo: [{ rssi: -92, snr: 7 }],
        }),
      ),
      topic,
      { distance: "distance_mm", battery: "battery_v" },
    );

    expect(uplink.deviceEui).toBe("0123456789abcdef");
    expect(uplink.timestamp.toISOString()).toBe("2026-11-05T10:00:00.000Z");
    expect(uplink.metrics).toEqual({ distance_mm: 412, battery_v: 3.6 });
    expect(uplink.signal).toEqual({ rssi: -92, snr: 7 });
  });

  it("uses the DevEUI from the topic when deviceInfo is absent", () => {
    const uplink = parseUplink(
      Buffer.from(
        JSON.stringify({
          time: "2026-11-05T10:00:00Z",
          object: { distance_mm: 100 },
        }),
      ),
      topic,
      {},
    );

    expect(uplink.deviceEui).toBe("0123456789abcdef");
  });

  it("rejects malformed, stale-shape, or metric-less payloads", () => {
    expect(() => parseUplink(Buffer.from("{"), topic, {})).toThrow("not valid JSON");
    expect(() => parseUplink(Buffer.from("{}"), topic, {})).toThrow("Invalid ChirpStack uplink");
    expect(() =>
      parseUplink(
        Buffer.from(
          JSON.stringify({
            time: "2026-11-05T10:00:00Z",
            object: { status: "ok" },
          }),
        ),
        topic,
        {},
      ),
    ).toThrow("no finite numeric metrics");
  });

  it("rejects multiple decoded fields mapped to the same metric", () => {
    expect(() =>
      parseUplink(
        Buffer.from(
          JSON.stringify({
            time: "2026-11-05T10:00:00Z",
            object: { distance: 412, range: 413 },
          }),
        ),
        topic,
        { distance: "distance_mm", range: "distance_mm" },
      ),
    ).toThrow("Multiple payload fields map");
  });

  it("can allowlist verified decoded fields and reports excluded numeric fields", () => {
    const uplink = parseUplink(
      Buffer.from(
        JSON.stringify({
          time: "2026-11-05T10:00:00Z",
          object: { Lidar_distance: 230, TempC_DS18B20: 3276.7, Interrupt_flag: "FALSE" },
        }),
      ),
      topic,
      {},
      new Set(["Lidar_distance"]),
    );

    expect(uplink.metrics).toEqual({ Lidar_distance: 230 });
    expect(uplink.ignoredNumericFields).toEqual(["TempC_DS18B20"]);
  });

  it("parses the sanitized AQS-01-L sample using its verified numeric fields", () => {
    const sample = readFileSync(new URL("../../../samples/aqs01-up.json", import.meta.url));
    const uplink = parseUplink(
      sample,
      "application/sample/device/0123456789abcdef/event/up",
      {},
      new Set(["co2", "BatV", "air_pressure", "temperature", "humidity"]),
    );

    expect(uplink.metrics).toEqual({
      co2: 448,
      BatV: 3.6,
      air_pressure: 993.2,
      temperature: 25.13,
      humidity: 56.4,
    });
    expect(uplink.ignoredNumericFields).toEqual([]);
    expect(
      filterUplinkMetrics(
        uplink,
        new Set(["co2", "BatV", "air_pressure", "temperature", "humidity"]),
        {},
      ).metrics,
    ).toEqual(uplink.metrics);
    expect(filterUplinkMetrics(uplink, new Set(["co2"]), {}).metrics).toEqual({ co2: 448 });
  });
});

describe("parseDeviceStatus", () => {
  const statusTopic = "application/distance/device/0123456789ABCDEF/event/status";

  it("extracts a reported ChirpStack battery percentage", () => {
    const status = parseDeviceStatus(
      Buffer.from(
        JSON.stringify({
          deviceInfo: { devEui: "0123456789ABCDEF" },
          time: "2026-11-16T06:48:20Z",
          batteryLevelUnavailable: false,
          batteryLevel: 98.8189,
        }),
      ),
      statusTopic,
    );

    expect(status).toEqual({
      deviceEui: "0123456789abcdef",
      timestamp: new Date("2026-11-16T06:48:20Z"),
      batteryPercent: 98.8189,
    });
  });

  it("does not invent a battery percentage when ChirpStack marks it unavailable", () => {
    const status = parseDeviceStatus(
      Buffer.from(
        JSON.stringify({
          time: "2026-11-16T06:48:20Z",
          batteryLevelUnavailable: true,
          batteryLevel: 0,
        }),
      ),
      statusTopic,
    );

    expect(status.batteryPercent).toBeUndefined();
  });

  it("rejects malformed or out-of-range battery status values", () => {
    expect(() => parseDeviceStatus(Buffer.from("{"), statusTopic)).toThrow("not valid JSON");
    expect(() =>
      parseDeviceStatus(
        Buffer.from(
          JSON.stringify({
            time: "2026-11-16T06:48:20Z",
            batteryLevel: 101,
          }),
        ),
        statusTopic,
      ),
    ).toThrow("between 0 and 100");
  });
});

describe("parseMetricMap", () => {
  it("parses a JSON field mapping", () => {
    expect(parseMetricMap('{"distance":"distance_mm"}')).toEqual({
      distance: "distance_mm",
    });
  });

  it("reports invalid JSON or mapping shapes", () => {
    expect(() => parseMetricMap("{")).toThrow("valid JSON");
    expect(() => parseMetricMap('{"distance":3}')).toThrow("object mapping");
  });

  it("parses an allowlist and reports malformed values", () => {
    expect(parseAllowedFields('["distance"]')).toEqual(new Set(["distance"]));
    expect(parseAllowedFieldsByModel('{"AQS-01-L":["co2","temperature"]}')).toEqual({
      "AQS-01-L": new Set(["co2", "temperature"]),
    });
    expect(() => parseAllowedFields("{")).toThrow("valid JSON");
    expect(() => parseAllowedFields('{"distance":true}')).toThrow("array");
    expect(() => parseAllowedFieldsByModel("{")).toThrow("valid JSON");
    expect(() => parseAllowedFieldsByModel('{"AQS-01-L":"co2"}')).toThrow("map device model");
  });
});
