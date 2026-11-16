import type { Pool } from "pg";

interface ChirpStackDevice {
  device_id: string;
  external_id: string;
  model: string;
}

interface RegisteredDevice {
  device_id: string;
  external_id: string;
}

export function createDeviceId(name: string, devEui: string, usedIds: Set<string>): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  const base = slug || "device";
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  const suffix = devEui.toLowerCase();
  const uniqueId = `${base.slice(0, 63 - suffix.length - 1)}-${suffix}`;
  if (usedIds.has(uniqueId)) {
    throw new Error(`Could not create a unique telemetry ID for ChirpStack device ${name}`);
  }
  usedIds.add(uniqueId);
  return uniqueId;
}

export function planDeviceRegistrations(
  chirpStackDevices: Array<{ name: string; externalId: string; model: string }>,
  registeredDevices: RegisteredDevice[],
): ChirpStackDevice[] {
  const registeredExternalIds = new Set(
    registeredDevices.map((device) => device.external_id.toLowerCase()),
  );
  const usedIds = new Set(registeredDevices.map((device) => device.device_id.toLowerCase()));
  const newDevices: ChirpStackDevice[] = [];

  for (const device of chirpStackDevices) {
    const externalId = device.externalId.toLowerCase();
    if (registeredExternalIds.has(externalId)) {
      continue;
    }
    if (!/^[0-9a-f]{16}$/.test(externalId)) {
      throw new Error(`ChirpStack device ${device.name} has an invalid DevEUI`);
    }
    const deviceId = createDeviceId(device.name, externalId, usedIds);
    registeredExternalIds.add(externalId);
    newDevices.push({
      device_id: deviceId,
      external_id: externalId,
      model: device.model,
    });
  }
  return newDevices;
}

export async function syncChirpStackDevices(
  telemetryPool: Pool,
  chirpStackPool: Pool,
  onlyDevEui?: string,
): Promise<number> {
  const chirpStackResult = await chirpStackPool.query<{
    name: string;
    external_id: string;
    model: string;
  }>(
    `SELECT d.name,
            encode(d.dev_eui, 'hex') AS external_id,
            dp.name AS model
       FROM device d
       JOIN device_profile dp ON dp.id = d.device_profile_id
      WHERE d.is_disabled = FALSE
        AND d.dev_eui IS NOT NULL
        AND ($1::text IS NULL OR lower(encode(d.dev_eui, 'hex')) = $1)
      ORDER BY d.created_at, d.name`,
    [onlyDevEui?.toLowerCase() ?? null],
  );
  if (chirpStackResult.rows.length === 0) {
    return 0;
  }

  const client = await telemetryPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('chirpstack-device-sync'))",
    );
    const registeredResult = await client.query<RegisteredDevice>(
      "SELECT device_id, external_id FROM devices",
    );
    const registrations = planDeviceRegistrations(
      chirpStackResult.rows.map((device) => ({
        name: device.name,
        externalId: device.external_id,
        model: device.model,
      })),
      registeredResult.rows,
    );

    let added = 0;
    for (const device of registrations) {
      const inserted = await client.query(
        `INSERT INTO devices (device_id, external_id, protocol, model, enabled)
         VALUES ($1, $2, 'lorawan', $3, TRUE)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING device_id`,
        [device.device_id, device.external_id, device.model],
      );
      added += inserted.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return added;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
