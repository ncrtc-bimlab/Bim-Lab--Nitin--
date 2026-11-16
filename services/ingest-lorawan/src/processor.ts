import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { ParsedUplink } from "./uplink.js";

export interface DeviceConfig {
  deviceId?: string;
  deviceEui?: string;
  model: string;
  location?: string;
  expectedIntervalSeconds?: number;
}

export interface DeviceRecord {
  device_id: string;
  external_id: string;
  model: string;
  location: string | null;
  expected_interval_s: number | null;
}

export async function registerConfiguredDevice(pool: Pool, config: DeviceConfig): Promise<void> {
  if (!config.deviceId && !config.deviceEui) {
    return;
  }
  if (!config.deviceId || !config.deviceEui) {
    throw new Error("Set both LORAWAN_DEVICE_ID and LORAWAN_DEVICE_EUI, or leave both empty");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.deviceId)) {
    throw new Error("LORAWAN_DEVICE_ID must be lowercase letters, numbers, and hyphens");
  }
  if (!/^[0-9a-f]{16}$/i.test(config.deviceEui)) {
    throw new Error("LORAWAN_DEVICE_EUI must be a 16-character hexadecimal DevEUI");
  }
  if (
    config.expectedIntervalSeconds !== undefined &&
    (!Number.isInteger(config.expectedIntervalSeconds) || config.expectedIntervalSeconds <= 0)
  ) {
    throw new Error("LORAWAN_EXPECTED_INTERVAL_S must be a positive integer");
  }

  const result = await pool.query(
    `INSERT INTO devices
       (device_id, external_id, protocol, model, location, expected_interval_s, enabled)
     VALUES ($1, $2, 'lorawan', $3, $4, $5, TRUE)
     ON CONFLICT (device_id) DO UPDATE SET
       model = EXCLUDED.model,
       location = EXCLUDED.location,
       expected_interval_s = EXCLUDED.expected_interval_s
     WHERE devices.external_id = EXCLUDED.external_id
       AND devices.protocol = 'lorawan'
     RETURNING device_id`,
    [
      config.deviceId,
      config.deviceEui.toLowerCase(),
      config.model,
      config.location ?? null,
      config.expectedIntervalSeconds ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Device ID ${config.deviceId} already exists with a different protocol or external ID`,
    );
  }
}

export async function processUplink(
  pool: Pool,
  redis: Redis,
  uplink: ParsedUplink,
  protocol: "lorawan" | "ble" = "lorawan",
  externalId = uplink.deviceEui,
): Promise<"stored" | "duplicate" | "unknown" | "disabled"> {
  const deviceResult = await pool.query<DeviceRecord>(
    `SELECT device_id, external_id, model, location, expected_interval_s
       FROM devices
      WHERE protocol = $1 AND lower(regexp_replace(external_id, '[:-]', '', 'g')) = $2 AND enabled = TRUE`,
    [protocol, externalId],
  );
  const device = deviceResult.rows[0];
  if (!device) {
    const exists = await pool.query(
      `SELECT 1 FROM devices WHERE protocol = $1 AND lower(regexp_replace(external_id, '[:-]', '', 'g')) = $2`,
      [protocol, externalId],
    );
    return exists.rowCount ? "disabled" : "unknown";
  }

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const [metric, value] of Object.entries(uplink.metrics)) {
      const result = await client.query(
        `INSERT INTO readings (ts, device_id, metric, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (device_id, metric, ts) DO NOTHING`,
        [uplink.timestamp, device.device_id, metric, value],
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const latest = {
    deviceId: device.device_id,
    model: device.model,
    location: device.location,
    ts: uplink.timestamp.toISOString(),
    metrics: uplink.metrics,
    signal: uplink.signal,
  };
  const pipeline = redis.pipeline().set(`latest:${device.device_id}`, JSON.stringify(latest));
  if (device.expected_interval_s) {
    pipeline.set(
      `seen:${device.device_id}`,
      uplink.timestamp.toISOString(),
      "EX",
      Math.max(device.expected_interval_s * 3, 60),
    );
  } else {
    pipeline.set(`seen:${device.device_id}`, uplink.timestamp.toISOString());
  }
  const results = await pipeline.exec();
  const failed = results?.find(([error]) => error);
  if (failed?.[0]) {
    throw failed[0];
  }

  return inserted > 0 ? "stored" : "duplicate";
}
