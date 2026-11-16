import { describe, expect, it } from "vitest";
import {
  filterBleBatchByMacs,
  normalizeBleMac,
  parseBleAllowedMacs,
  parseBleBatch,
} from "../src/ble.js";

describe("BLE gateway payloads", () => {
  it("normalizes BLE MAC addresses", () => {
    expect(normalizeBleMac("C3:B3:37:E8:A4:87")).toBe("c3b337e8a487");
    expect(normalizeBleMac("c3-b3-37-e8-a4-87")).toBe("c3b337e8a487");
    expect(normalizeBleMac("invalid")).toBeUndefined();
  });

  it("filters gateway batches to explicitly allowed MAC addresses", () => {
    const payload = Buffer.from(JSON.stringify([
      { Format: "Gateway", GatewayMAC: "E4:38:19:1F:D3:A2" },
      { Format: "MK Sensor-PIR", BLEMAC: "C3B337E8A487", PIRStatus: 1 },
      { Format: "RawData", BLEMAC: "001B10B2EA27", RawData: "private-beacon-data" },
    ]));

    const filtered = filterBleBatchByMacs(payload, new Set(["c3b337e8a487"]));

    expect(JSON.parse(filtered?.toString("utf8") ?? "null")).toEqual([
      { Format: "MK Sensor-PIR", BLEMAC: "C3B337E8A487", PIRStatus: 1 },
    ]);
    expect(filterBleBatchByMacs(payload, new Set(["001122334455"]))).toBeUndefined();
  });

  it("parses decoded advertisements while excluding raw and radio-only records", () => {
    const payload = Buffer.from(JSON.stringify([
      { Format: "Gateway", GatewayMAC: "E4:38:19:1F:D3:A2" },
      { TimeStamp: "2026-11-10T05:00:00Z", Format: "RawData", BLEMAC: "C3B337E8A487", RSSI: -60, RawData: "abcd" },
      {
        TimeStamp: "2026-11-10T05:00:01Z",
        Format: "MK Sensor-PIR",
        BLEMAC: "C3:B3:37:E8:A4:87",
        RSSI: -67,
        "RSSI@1m": 0,
        PIRStatus: 1,
        BattVoltage: 3599,
        BLEName: "Sensor",
      },
    ]));

    expect(parseBleBatch(payload)).toEqual([
      {
        externalId: "c3b337e8a487",
        timestamp: new Date("2026-11-10T05:00:01Z"),
        modelFormat: "MK Sensor-PIR",
        metrics: { PIRStatus: 1, BattVoltage: 3599 },
        rssi: -67,
      },
    ]);
  });

  it("extracts only finite numeric fields from the three selected beacon formats", () => {
    const payload = Buffer.from(JSON.stringify([
      {
        TimeStamp: "2026-11-10T05:00:00Z",
        Format: "MK Sensor-PIR",
        BLEMAC: "C3B337E8A487",
        RSSI: -67,
        PIRStatus: 1,
        DoorStatus: 0,
        BattVoltage: 3599,
      },
      {
        TimeStamp: "2026-11-10T05:00:01Z",
        Format: "MK Tag-Tag info",
        BLEMAC: "F044D381A46B",
        RSSI: -78,
        HallStatus: 1,
        HallCount: 3,
        "3-axisStatus": 0,
        "3-axisCount": 0,
        "3-axisData": "raw-data",
        BattVoltage: 2955,
      },
      {
        TimeStamp: "2026-11-10T05:00:02Z",
        Format: "BeaconX Pro-Device info",
        BLEMAC: "C703BD278150",
        RSSI: -29,
        TxPower: 0,
        "RSSI@0m": -65,
        AdvInterval: 1000,
        BattVoltage: 3464,
        FirmwareVer: "2.0",
      },
    ]));

    expect(parseBleBatch(payload).map(({ externalId, metrics }) => ({ externalId, metrics }))).toEqual([
      {
        externalId: "c3b337e8a487",
        metrics: { PIRStatus: 1, DoorStatus: 0, BattVoltage: 3599 },
      },
      {
        externalId: "f044d381a46b",
        metrics: { HallStatus: 1, HallCount: 3, "3-axisStatus": 0, "3-axisCount": 0, BattVoltage: 2955 },
      },
      {
        externalId: "c703bd278150",
        metrics: { TxPower: 0, AdvInterval: 1000, BattVoltage: 3464 },
      },
    ]);
  });

  it("validates and normalizes the BLE allowlist", () => {
    expect(parseBleAllowedMacs(undefined).size).toBe(0);
    expect(parseBleAllowedMacs('["C3:B3:37:E8:A4:87"]')).toEqual(new Set(["c3b337e8a487"]));
    expect(() => parseBleAllowedMacs('["invalid"]')).toThrow("invalid BLE MAC");
  });
});
