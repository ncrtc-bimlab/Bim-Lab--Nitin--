import mqttLibrary from "mqtt";
import { createServer } from "node:http";
import { Redis } from "ioredis";
import pg from "pg";
import pino from "pino";
import { parseAllowedFields, parseMetricMap, parseUplink } from "./uplink.js";
import { processUplink, registerConfiguredDevice } from "./processor.js";

const { Pool } = pg;
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const config = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  mqttUrl: required("MQTT_URL"),
  mqttClientId: process.env.MQTT_CLIENT_ID ?? "twin-ingest-lorawan",
  deviceId: process.env.LORAWAN_DEVICE_ID || undefined,
  deviceEui: process.env.LORAWAN_DEVICE_EUI || undefined,
  model: process.env.LORAWAN_DEVICE_MODEL ?? "LDS12-LWB",
  location: process.env.LORAWAN_DEVICE_LOCATION || undefined,
  expectedIntervalSeconds: optionalPositiveInteger("LORAWAN_EXPECTED_INTERVAL_S"),
  metricMap: parseMetricMap(process.env.LORAWAN_METRIC_MAP_JSON),
  allowedFields: parseAllowedFields(process.env.LORAWAN_ALLOWED_FIELDS_JSON),
};

const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
const mqtt = mqttLibrary.connect(config.mqttUrl, {
  clientId: config.mqttClientId,
  clean: false,
  reconnectPeriod: 5_000,
  connectTimeout: 30_000,
  resubscribe: true,
});
let shuttingDown = false;
let dependenciesReady = false;
let brokerConnected = false;
const mqttConnected = new Promise<void>((resolve) => {
  mqtt.once("connect", () => resolve());
});
const healthServer = createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  const healthy = dependenciesReady && brokerConnected && !shuttingDown;
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "ok" : "starting" }));
});

mqtt.on("connect", () => {
  brokerConnected = true;
  logger.info("Connected to MQTT broker");
  mqtt.subscribe("application/+/device/+/event/up", { qos: 1 }, (error) => {
    if (error) {
      logger.error({ err: error }, "Failed to subscribe to ChirpStack uplinks");
    } else {
      logger.info("Subscribed to ChirpStack uplinks");
    }
  });
});
mqtt.on("reconnect", () => {
  brokerConnected = false;
  logger.warn("Reconnecting to MQTT broker");
});
mqtt.on("close", () => {
  brokerConnected = false;
});
mqtt.on("error", (error) => logger.error({ err: error }, "MQTT client error"));
redis.on("error", (error) => logger.error({ err: error }, "Redis client error"));

mqtt.handleMessage = (packet, callback) => {
  void (async () => {
    try {
      if (!dependenciesReady) {
        throw new Error("Database and Redis initialization is not complete");
      }
      const topic = packet.topic;
      const uplink = parseUplink(
        Buffer.from(packet.payload),
        topic,
        config.metricMap,
        config.allowedFields,
      );
      const outcome = await processUplink(pool, redis, uplink);
      if (outcome === "unknown") {
        logger.warn({ devEui: uplink.deviceEui, topic }, "Ignoring unregistered device");
      } else if (outcome === "disabled") {
        logger.warn({ devEui: uplink.deviceEui, topic }, "Ignoring disabled device");
      } else {
        logger.info(
          {
            devEui: uplink.deviceEui,
            timestamp: uplink.timestamp.toISOString(),
            metricNames: Object.keys(uplink.metrics),
            ignoredNumericFields: uplink.ignoredNumericFields,
            outcome,
          },
          "Processed LoRaWAN uplink",
        );
      }
      callback();
    } catch (error) {
      logger.error({ err: error, topic: packet.topic }, "Failed to process LoRaWAN uplink");
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  })();
};

async function start(): Promise<void> {
  healthServer.listen(3000, "0.0.0.0");
  await pool.query("SELECT 1");
  await redis.connect();
  await redis.ping();
  await registerConfiguredDevice(pool, {
    deviceId: config.deviceId,
    deviceEui: config.deviceEui,
    model: config.model,
    location: config.location,
    expectedIntervalSeconds: config.expectedIntervalSeconds,
  });
  if (!config.deviceEui) {
    logger.warn("No device configured; set LORAWAN_DEVICE_ID and LORAWAN_DEVICE_EUI to register one");
  }
  dependenciesReady = true;
  await mqttConnected;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  dependenciesReady = false;
  logger.info({ signal }, "Shutting down");
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await new Promise<void>((resolve) =>
    mqtt.end(false, {}, (error) => {
      if (error) {
        logger.error({ err: error }, "Error closing MQTT client");
      }
      resolve();
    }),
  );
  await Promise.all([pool.end(), redis.quit()]);
}

process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Failed to start LoRaWAN ingester");
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exitCode = 1;
});
