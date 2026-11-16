import { z } from "zod";

const BLE_BATCH_LIMIT = 100;
const bleRecordSchema = z.record(z.string(), z.unknown());
const radioFields = new Set(["RSSI", "AdvType", "BLEMAC", "BLEName", "Format", "TimeStamp", "GatewayMAC"]);

export interface ParsedBleAdvertisement {
  externalId: string;
  timestamp: Date;
  modelFormat?: string;
  metrics: Record<string, number>;
  rssi?: number;
}

export function normalizeBleMac(value: string): string | undefined {
  const normalized = value.replace(/[:-]/g, "").toLowerCase();
  return /^[0-9a-f]{12}$/.test(normalized) ? normalized : undefined;
}

function decodeBleBatch(payload: Buffer): unknown[] {
  if (payload.length > 1_048_576) {
    throw new Error("BLE MQTT payload exceeds the 1 MiB limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("BLE MQTT payload is not valid JSON");
  }
  if (!Array.isArray(decoded) || decoded.length > BLE_BATCH_LIMIT) {
    throw new Error(`BLE payload must be an array of at most ${BLE_BATCH_LIMIT} advertisements`);
  }
  return decoded;
}

export function filterBleBatchByMacs(payload: Buffer, allowedMacs: Set<string>): Buffer | undefined {
  const records = decodeBleBatch(payload);
  const filtered = records.filter((value) => {
    const result = bleRecordSchema.safeParse(value);
    if (!result.success || typeof result.data.BLEMAC !== "string") {
      return false;
    }
    const mac = normalizeBleMac(result.data.BLEMAC);
    return mac !== undefined && allowedMacs.has(mac);
  });
  return filtered.length ? Buffer.from(JSON.stringify(filtered)) : undefined;
}

export function parseBleBatch(payload: Buffer): ParsedBleAdvertisement[] {
  const records = decodeBleBatch(payload);
  const parsed: ParsedBleAdvertisement[] = [];

  for (const value of records) {
    const result = bleRecordSchema.safeParse(value);
    if (!result.success) {
      continue;
    }
    const record = result.data;
    if (typeof record.BLEMAC !== "string") {
      continue;
    }
    const externalId = normalizeBleMac(record.BLEMAC);
    if (!externalId) {
      continue;
    }
    if (typeof record.Format !== "string" || record.Format === "RawData" || record.Format === "Gateway") {
      continue;
    }
    if (typeof record.TimeStamp !== "string") {
      throw new Error(`BLE advertisement for ${externalId} has no timestamp`);
    }
    const timestamp = new Date(record.TimeStamp);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error(`BLE advertisement for ${externalId} has an invalid timestamp`);
    }

    const metrics: Record<string, number> = {};
    for (const [field, fieldValue] of Object.entries(record)) {
      if (radioFields.has(field) || field.startsWith("RSSI@")) {
        continue;
      }
      if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
        metrics[field] = fieldValue;
      }
    }
    if (Object.keys(metrics).length === 0) {
      continue;
    }

    parsed.push({
      externalId,
      timestamp,
      modelFormat: record.Format,
      metrics,
      rssi: typeof record.RSSI === "number" && Number.isFinite(record.RSSI) ? record.RSSI : undefined,
    });
  }
  return parsed;
}

export function parseBleAllowedMacs(value: string | undefined): Set<string> {
  if (!value || value === "[]") {
    return new Set();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("BLE_ALLOWED_MACS_JSON must be valid JSON");
  }
  const result = z.array(z.string().min(1).max(17)).safeParse(decoded);
  if (!result.success) {
    throw new Error("BLE_ALLOWED_MACS_JSON must be an array of BLE MAC addresses");
  }
  const macs = result.data.map(normalizeBleMac);
  if (macs.some((mac) => !mac)) {
    throw new Error("BLE_ALLOWED_MACS_JSON contains an invalid BLE MAC address");
  }
  return new Set(macs.filter((mac): mac is string => mac !== undefined));
}
