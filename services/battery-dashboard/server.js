import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  FILTERS,
  PROTOCOLS,
  filterSensors,
  filterSensorsByStatusAndSearch,
  summarizeSensors,
  toSensorView,
} from "./battery.js";
import { createBatteryWorkbook, createDeviceImportTemplate } from "./workbook.js";
import {
  applyProfileRequirements,
  createImportedDevices,
  getChirpStackResources,
  parseDeviceWorkbook,
} from "./lorawan-import.js";

const { Pool } = pg;
const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const chirpstackDatabaseUrl = process.env.CHIRPSTACK_DATABASE_URL;
if (!chirpstackDatabaseUrl) {
  throw new Error("CHIRPSTACK_DATABASE_URL is required");
}
const chirpstackPool = new Pool({ connectionString: chirpstackDatabaseUrl, max: 3 });
const dashboardPath = fileURLToPath(new URL("./public/index.html", import.meta.url));
const sensorDetailsPath = fileURLToPath(new URL("./public/sensor.html", import.meta.url));
const bulkImportPath = fileURLToPath(new URL("./public/bulk-import.html", import.meta.url));
const chirpstackRestUrl = process.env.CHIRPSTACK_REST_URL ?? "http://chirpstack-rest-api:8090";
const chirpstackApiToken = process.env.CHIRPSTACK_API_TOKEN;
async function getChirpStackApiOptions() {
  if (!chirpstackApiToken) {
    throw new Error("Set CHIRPSTACK_API_TOKEN to load device profiles and applications.");
  }
  const segments = chirpstackApiToken.split(".");
  if (segments.length !== 3) {
    throw new Error("CHIRPSTACK_API_TOKEN is not a valid ChirpStack API key.");
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("CHIRPSTACK_API_TOKEN is not a valid ChirpStack API key.", { cause: error });
  }
  if (
    typeof claims.sub !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub)
  ) {
    throw new Error("CHIRPSTACK_API_TOKEN does not contain a valid API key ID.");
  }

  const result = await chirpstackPool.query(
    "SELECT tenant_id FROM api_key WHERE id = $1",
    [claims.sub],
  );
  const tenantId = result.rows[0]?.tenant_id;
  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("CHIRPSTACK_API_TOKEN is not an active ChirpStack API key.");
  }

  return {
    baseUrl: chirpstackRestUrl,
    token: chirpstackApiToken,
    tenantId,
    fetchImpl: fetch,
  };
}
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const HISTORY_RANGES = new Map([
  ["24h", 24],
  ["7d", 24 * 7],
  ["30d", 24 * 30],
]);

const sensorsQuery = `
  WITH last_seen AS (
    SELECT device_id, MAX(ts) AS last_seen
      FROM readings
     GROUP BY device_id
  )
  SELECT d.device_id AS sensor_name,
         d.external_id,
         d.protocol,
         d.model,
         d.location,
         d.expected_interval_s,
         ls.last_seen,
         battery.metric AS battery_metric,
         battery.value AS battery_value,
         battery.ts AS battery_ts,
         (
           ls.last_seen IS NULL OR
           ls.last_seen < now() - make_interval(
             secs => COALESCE(d.expected_interval_s, 28800)::double precision * 3
           )
         ) AS is_offline
    FROM devices d
    LEFT JOIN last_seen ls ON ls.device_id = d.device_id
    LEFT JOIN LATERAL (
      SELECT r.metric, r.value, r.ts
        FROM readings r
       WHERE r.device_id = d.device_id
         AND lower(r.metric) ~ '(^|[^a-z])(bat|batt|battery)'
       ORDER BY
         CASE
           WHEN lower(r.metric) ~ '(percent|pct|%)' THEN 0
           ELSE 1
         END,
         r.ts DESC
       LIMIT 1
    ) battery ON TRUE
   WHERE d.enabled = TRUE
   ORDER BY d.device_id
`;

async function loadSensors() {
  const result = await pool.query(sensorsQuery);
  const lorawanDevices = result.rows.filter((row) => row.protocol === "lorawan");
  const externalIds = lorawanDevices.map((row) => String(row.external_id).toLowerCase());
  const descriptions = externalIds.length
    ? await chirpstackPool.query(
      `SELECT encode(dev_eui, 'hex') AS external_id,
              description,
              battery_level,
              last_seen_at
         FROM device
        WHERE encode(dev_eui, 'hex') = ANY($1::text[])`,
      [externalIds],
    )
    : { rows: [] };
  const descriptionByExternalId = new Map(
    descriptions.rows.map((row) => [row.external_id.toLowerCase(), row]),
  );
  return result.rows.map((row) => {
    const deviceStatus = descriptionByExternalId.get(String(row.external_id).toLowerCase());
    const hasChirpStackBatteryStatus = deviceStatus?.battery_level !== null
      && deviceStatus?.battery_level !== undefined;
    return toSensorView({
      ...row,
      description: deviceStatus?.description ?? null,
      battery_metric: hasChirpStackBatteryStatus ? "battery_percent" : row.battery_metric,
      battery_value: hasChirpStackBatteryStatus ? deviceStatus.battery_level : row.battery_value,
      battery_ts: hasChirpStackBatteryStatus ? deviceStatus.last_seen_at : row.battery_ts,
    });
  });
}

async function loadSensorDetails(deviceId, rangeHours) {
  const sensor = (await loadSensors()).find((item) => item.deviceId === deviceId);
  if (!sensor) {
    return undefined;
  }

  const [lastDataResult, historyResult] = await Promise.all([
    pool.query(
      `WITH ranked_readings AS (
         SELECT metric,
                value,
                ts,
                row_number() OVER (PARTITION BY metric ORDER BY ts DESC) AS metric_rank
           FROM readings
          WHERE device_id = $1
       )
       SELECT metric, value, ts
         FROM ranked_readings
        WHERE metric_rank = 1
        ORDER BY ts DESC
        LIMIT 100`,
      [deviceId],
    ),
    pool.query(
      `WITH selected_metrics AS (
         SELECT metric
           FROM readings
          WHERE device_id = $1
            AND ts >= now() - ($2::integer * interval '1 hour')
          GROUP BY metric
          ORDER BY MAX(ts) DESC
          LIMIT 8
       ),
       ranked_readings AS (
         SELECT r.metric,
                r.value,
                r.ts,
                row_number() OVER (PARTITION BY r.metric ORDER BY r.ts DESC) AS point_number
           FROM readings r
           JOIN selected_metrics m ON m.metric = r.metric
          WHERE r.device_id = $1
            AND r.ts >= now() - ($2::integer * interval '1 hour')
       )
       SELECT metric, value, ts
         FROM ranked_readings
        WHERE point_number <= 120
        ORDER BY metric, ts`,
      [deviceId, rangeHours],
    ),
  ]);
  const groupedHistory = new Map();
  for (const row of historyResult.rows) {
    const points = groupedHistory.get(row.metric) ?? [];
    points.push({ ts: row.ts, value: Number(row.value) });
    groupedHistory.set(row.metric, points);
  }

  return {
    sensor,
    description: sensor.description,
    lastData: lastDataResult.rows.map((row) => ({
      metric: row.metric,
      value: Number(row.value),
      ts: row.ts,
    })),
    series: [...groupedHistory].map(([metric, points]) => ({ metric, points })),
    rangeHours,
  };
}

function requestedFilter(url) {
  const filter = url.searchParams.get("filter") ?? "all";
  if (!FILTERS.has(filter)) {
    return undefined;
  }
  return filter;
}

function requestedProtocol(url) {
  const protocol = url.searchParams.get("protocol") ?? "all";
  if (!PROTOCOLS.has(protocol)) {
    return undefined;
  }
  return protocol;
}

function requestedStatus(url) {
  const status = url.searchParams.get("status") ?? "all";
  if (!["all", "online", "offline"].includes(status)) {
    return undefined;
  }
  return status;
}

function requestedSearch(url) {
  const search = (url.searchParams.get("search") ?? "").trim();
  if (search.length > 100) {
    return undefined;
  }
  return search;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function sendWorkbook(response, sensors, filter) {
  const content = await createBatteryWorkbook(sensors);
  const date = new Date().toISOString().slice(0, 10);
  response.writeHead(200, {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="sensor-battery-${filter}-${date}.xlsx"`,
    "content-length": content.byteLength,
    "cache-control": "no-store",
  });
  response.end(content);
}

function sendHtml(response, path) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(response);
}

function readUploadBuffer(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("The spreadsheet must be 5 MB or smaller."));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readImportWorkbook(request) {
  const contentType = request.headers["content-type"]?.split(";")[0].trim();
  if (
    contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    && contentType !== "application/octet-stream"
  ) {
    throw new Error("Upload the spreadsheet as an .xlsx file.");
  }
  return parseDeviceWorkbook(await readUploadBuffer(request));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      if (request.method === "POST" && (
        url.pathname === "/api/lorawan-import/preview"
        || url.pathname === "/api/lorawan-import/import"
      )) {
        let parsed;
        try {
          parsed = await readImportWorkbook(request);
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        const deviceProfileId = url.searchParams.get("deviceProfileId");
        const applicationId = url.searchParams.get("applicationId");
        if (!deviceProfileId || !applicationId) {
          sendJson(response, 400, { error: "Choose a device profile and application first." });
          return;
        }
        if (url.pathname.endsWith("/preview")) {
          let resources;
          try {
            resources = await getChirpStackResources(await getChirpStackApiOptions());
          } catch (error) {
            sendJson(response, chirpstackApiToken ? 502 : 503, {
              error: error instanceof Error ? error.message : "Unable to load ChirpStack options.",
            });
            return;
          }
          const profile = resources.deviceProfiles.find((item) => item.id === deviceProfileId);
          if (!profile || !resources.applications.some((item) => item.id === applicationId)) {
            sendJson(response, 400, { error: "The selected device profile or application is no longer available." });
            return;
          }
          applyProfileRequirements(parsed, profile);
          sendJson(response, 200, {
            validCount: parsed.validCount,
            invalidCount: parsed.invalidCount,
            rows: parsed.rows.map((device) => ({
              rowNumber: device.rowNumber,
              assetId: device.name,
              devEui: device.devEui,
              description: device.description,
              errors: device.errors,
            })),
          });
          return;
        }
        try {
          const result = await createImportedDevices(
            parsed,
            { deviceProfileId, applicationId },
            await getChirpStackApiOptions(),
          );
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, chirpstackApiToken ? 502 : 503, {
            error: error instanceof Error ? error.message : "Unable to connect to ChirpStack.",
          });
        }
        return;
      }
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/healthz") {
      await Promise.all([pool.query("SELECT 1"), chirpstackPool.query("SELECT 1")]);
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (url.pathname === "/") {
      sendHtml(response, dashboardPath);
      return;
    }

    if (url.pathname === "/bulk-import") {
      sendHtml(response, bulkImportPath);
      return;
    }

    if (url.pathname === "/api/lorawan-import/options") {
      try {
        const resources = await getChirpStackResources(await getChirpStackApiOptions());
        sendJson(response, 200, {
          deviceProfiles: resources.deviceProfiles.map(({ id, name }) => ({ id, name })),
          applications: resources.applications.map(({ id, name }) => ({ id, name })),
        });
      } catch (error) {
        sendJson(response, chirpstackApiToken ? 502 : 503, {
          error: error instanceof Error ? error.message : "Unable to load ChirpStack options.",
        });
      }
      return;
    }

    if (url.pathname === "/api/lorawan-import/template.xlsx") {
      const content = await createDeviceImportTemplate();
      response.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="lorawan-sensor-import-template.xlsx"',
        "content-length": content.byteLength,
        "cache-control": "no-store",
      });
      response.end(content);
      return;
    }

    if (/^\/sensors\/[^/]+$/.test(url.pathname)) {
      sendHtml(response, sensorDetailsPath);
      return;
    }

    if (url.pathname.startsWith("/api/sensors/")) {
      let deviceId;
      try {
        deviceId = decodeURIComponent(url.pathname.slice("/api/sensors/".length));
      } catch {
        sendJson(response, 400, { error: "Asset ID is not a valid URL value" });
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(deviceId)) {
        sendJson(response, 400, { error: "Asset ID is invalid" });
        return;
      }
      const requestedRange = url.searchParams.get("range") ?? "24h";
      const rangeHours = HISTORY_RANGES.get(requestedRange);
      if (rangeHours === undefined) {
        sendJson(response, 400, { error: "range must be 24h, 7d, or 30d" });
        return;
      }
      const details = await loadSensorDetails(deviceId, rangeHours);
      if (!details) {
        sendJson(response, 404, { error: "Sensor asset was not found or is disabled" });
        return;
      }
      sendJson(response, 200, details);
      return;
    }

    if (url.pathname !== "/api/sensors" && url.pathname !== "/api/export.xlsx") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const filter = requestedFilter(url);
    const protocol = requestedProtocol(url);
    const status = requestedStatus(url);
    const search = requestedSearch(url);
    if (!filter || !protocol || !status || search === undefined) {
      sendJson(response, 400, {
        error: "Invalid filter, protocol, connection status, or search query",
      });
      return;
    }

    const sensors = await loadSensors();
    const protocolSensors = filterSensors(sensors, "all", protocol);
    const filteredSensors = filterSensors(protocolSensors, filter);
    const visibleSensors = filterSensorsByStatusAndSearch(filteredSensors, status, search);
    if (url.pathname === "/api/export.xlsx") {
      await sendWorkbook(response, visibleSensors, `${filter}-${protocol}-${status}`);
      return;
    }

    sendJson(response, 200, {
      sensors: visibleSensors,
      summary: summarizeSensors(protocolSensors),
      filter,
      protocol,
      status,
      search,
    });
  } catch (error) {
    console.error("Battery dashboard request failed:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Unable to load sensor battery data" });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info(`Battery dashboard listening on port ${port}`);
});

async function shutdown(signal) {
  console.info(`Shutting down after ${signal}`);
  server.close(async (error) => {
    if (error) {
      console.error("Failed to close battery dashboard server:", error);
      process.exitCode = 1;
    }
    await pool.end();
    await chirpstackPool.end();
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
