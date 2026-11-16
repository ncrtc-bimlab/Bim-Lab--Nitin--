import { createServer } from "node:http";
import { Kafka, logLevel, type Consumer } from "kafkajs";
import { Redis } from "ioredis";
import pg from "pg";
import pino from "pino";
import { z } from "zod";
import { processUplink, type DeviceRecord } from "./processor.js";
import type { ParsedUplink } from "./uplink.js";

const { Pool } = pg;
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const brokers = (process.env.KAFKA_BROKERS ?? "kafka:9092").split(",").map((value) => value.trim()).filter(Boolean);
if (brokers.length === 0) {
  throw new Error("KAFKA_BROKERS must contain at least one broker address");
}

const normalizedSchema = z.object({
  version: z.literal(1),
  protocol: z.enum(["lorawan", "ble"]).default("lorawan"),
  deviceId: z.string().min(1),
  model: z.string().min(1),
  ts: z.string(),
  metrics: z.record(z.string().min(1), z.number().finite()),
  signal: z
    .object({
      rssi: z.number().optional(),
      snr: z.number().optional(),
    })
    .optional(),
});

const kafka = new Kafka({
  clientId: "twin-processor",
  brokers,
  logLevel: logLevel.NOTHING,
});
const consumer: Consumer = kafka.consumer({
  groupId: process.env.KAFKA_GROUP_ID ?? "processor",
  allowAutoTopicCreation: false,
});
const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 5 });
const redis = new Redis(required("REDIS_URL"), { lazyConnect: true, maxRetriesPerRequest: 3 });
const normalizedTopic = process.env.KAFKA_NORMALIZED_TOPIC ?? "telemetry.normalized";
let ready = false;
let closing = false;

const healthServer = createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  const healthy = ready && !closing;
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "ok" : "starting" }));
});

async function start(): Promise<void> {
  healthServer.listen(3000, "0.0.0.0");
  await pool.query("SELECT 1");
  await redis.connect();
  await redis.ping();
  await consumer.connect();
  await consumer.subscribe({ topic: normalizedTopic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        if (!message.value) {
          throw new Error("Normalized Kafka message has no value");
        }
        let value: unknown;
        try {
          value = JSON.parse(message.value.toString("utf8"));
        } catch {
          throw new Error("Normalized Kafka value is not valid JSON");
        }
        const parsed = normalizedSchema.safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `Invalid normalized telemetry: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`,
          );
        }
        const timestamp = new Date(parsed.data.ts);
        if (!Number.isFinite(timestamp.getTime())) {
          throw new Error("Normalized timestamp is invalid");
        }
        const device = await pool.query<DeviceRecord>(
          `SELECT device_id, external_id, model, location, expected_interval_s
             FROM devices
            WHERE device_id = $1 AND protocol = $2 AND enabled = TRUE`,
          [parsed.data.deviceId, parsed.data.protocol],
        );
        if (!device.rows[0]) {
          throw new Error(`Normalized message references unknown or disabled device ${parsed.data.deviceId}`);
        }
        const uplink: ParsedUplink = {
          deviceEui: device.rows[0].external_id.toLowerCase(),
          timestamp,
          metrics: parsed.data.metrics,
          ignoredNumericFields: [],
          signal: parsed.data.signal,
        };
        const result = await processUplink(
          pool,
          redis,
          uplink,
          parsed.data.protocol,
          device.rows[0].external_id,
        );
        if (result === "unknown" || result === "disabled") {
          throw new Error(`Device ${parsed.data.deviceId} became ${result} while processing`);
        }
        logger.info(
          {
            deviceId: parsed.data.deviceId,
            metricNames: Object.keys(parsed.data.metrics),
            outcome: result,
            topic,
            partition,
            offset: message.offset,
          },
          "Processed normalized telemetry",
        );
      } catch (error) {
        logger.error(
          { err: error, topic, partition, offset: message.offset },
          "Processor failed; Kafka offset will not be committed",
        );
        throw error;
      }
    },
  });
  ready = true;
  logger.info({ normalizedTopic }, "TimescaleDB and Redis processor is running");
}

async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  ready = false;
  logger.info({ signal }, "Shutting down processor");
  await Promise.allSettled([
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
    consumer.stop(),
  ]);
  await Promise.allSettled([consumer.disconnect(), pool.end(), redis.quit()]);
}

redis.on("error", (error) => logger.error({ err: error }, "Redis client error"));
process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Failed to start processor");
  await Promise.allSettled([consumer.disconnect(), pool.end(), redis.quit()]);
  process.exitCode = 1;
});
