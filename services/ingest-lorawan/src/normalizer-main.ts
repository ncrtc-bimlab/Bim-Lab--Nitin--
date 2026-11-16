import { createServer } from "node:http";
import { Kafka, logLevel, type Consumer, type Producer } from "kafkajs";
import pg from "pg";
import pino from "pino";
import { z } from "zod";
import {
  allowedFieldsForDevice,
  filterUplinkMetrics,
  parseAllowedFields,
  parseAllowedFieldsByModel,
  parseDeviceStatus,
  parseMetricMap,
  parseUplink,
} from "./uplink.js";
import { registerConfiguredDevice } from "./processor.js";
import { parseBleBatch } from "./ble.js";
import { syncChirpStackDevices } from "./chirpstack-sync.js";

const { Pool } = pg;
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
const brokers = (process.env.KAFKA_BROKERS ?? "kafka:9092").split(",").map((value) => value.trim()).filter(Boolean);
if (brokers.length === 0) {
  throw new Error("KAFKA_BROKERS must contain at least one broker address");
}

const config = {
  groupId: process.env.KAFKA_GROUP_ID ?? "normalizer",
  rawTopic: process.env.KAFKA_RAW_TOPIC ?? "telemetry.raw",
  normalizedTopic: process.env.KAFKA_NORMALIZED_TOPIC ?? "telemetry.normalized",
  deadLetterTopic: process.env.KAFKA_DEAD_LETTER_TOPIC ?? "telemetry.dead-letter",
  deviceId: process.env.LORAWAN_DEVICE_ID || undefined,
  deviceEui: process.env.LORAWAN_DEVICE_EUI || undefined,
  model: process.env.LORAWAN_DEVICE_MODEL ?? "LDS12-LWB",
  location: process.env.LORAWAN_DEVICE_LOCATION || undefined,
  expectedIntervalSeconds: process.env.LORAWAN_EXPECTED_INTERVAL_S
    ? Number(process.env.LORAWAN_EXPECTED_INTERVAL_S)
    : undefined,
  metricMap: parseMetricMap(process.env.LORAWAN_METRIC_MAP_JSON),
  allowedFields: parseAllowedFields(process.env.LORAWAN_ALLOWED_FIELDS_JSON),
  allowedFieldsByModel: parseAllowedFieldsByModel(process.env.LORAWAN_ALLOWED_FIELDS_BY_MODEL_JSON),
  bleAllowedFieldsByModel: parseAllowedFieldsByModel(process.env.BLE_ALLOWED_FIELDS_BY_MODEL_JSON),
};
const kafka = new Kafka({
  clientId: "twin-normalizer",
  brokers,
  logLevel: logLevel.NOTHING,
});
const consumer: Consumer = kafka.consumer({
  groupId: config.groupId,
  allowAutoTopicCreation: false,
});
const producer: Producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 1,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const chirpStackDatabaseUrl = process.env.CHIRPSTACK_DATABASE_URL;
if (!chirpStackDatabaseUrl) {
  throw new Error("CHIRPSTACK_DATABASE_URL is required");
}
const chirpStackPool = new Pool({ connectionString: chirpStackDatabaseUrl, max: 3 });
const deviceSyncIntervalMs = 30_000;
const rawEnvelopeSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  mqttTopic: z.string(),
  receivedAt: z.string(),
  deviceEui: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
  payloadBase64: z.string().min(1).max(1_398_104),
});

let ready = false;
let closing = false;
let deviceSyncTimer: NodeJS.Timeout | undefined;
const healthServer = createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  const healthy = ready && !closing;
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "ok" : "starting" }));
});

async function sendDeadLetter(
  producerInstance: Producer,
  key: Buffer | string | null,
  rawValue: Buffer | null,
  reason: string,
  source: { topic: string; partition: number; offset: string },
): Promise<void> {
  await producerInstance.send({
    topic: config.deadLetterTopic,
    acks: -1,
    messages: [
      {
        key,
        value: JSON.stringify({
          version: 1,
          failedAt: new Date().toISOString(),
          reason,
          source,
          raw: rawValue?.toString("utf8") ?? null,
        }),
      },
    ],
  });
}

async function start(): Promise<void> {
  healthServer.listen(3000, "0.0.0.0");
  await Promise.all([pool.query("SELECT 1"), chirpStackPool.query("SELECT 1")]);
  await registerConfiguredDevice(pool, {
    deviceId: config.deviceId,
    deviceEui: config.deviceEui,
    model: config.model,
    location: config.location,
    expectedIntervalSeconds: config.expectedIntervalSeconds,
  });
  const syncedAtStartup = await syncChirpStackDevices(pool, chirpStackPool);
  logger.info({ addedDevices: syncedAtStartup }, "Synchronized ChirpStack device registry");
  deviceSyncTimer = setInterval(() => {
    void syncChirpStackDevices(pool, chirpStackPool)
      .then((addedDevices) => {
        if (addedDevices > 0) {
          logger.info({ addedDevices }, "Registered new ChirpStack devices");
        }
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "Failed to synchronize ChirpStack devices");
      });
  }, deviceSyncIntervalMs);
  if (!config.deviceEui) {
    logger.info("No single device configured; LoRaWAN devices are synchronized from ChirpStack");
  }
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: config.rawTopic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const source = { topic, partition, offset: message.offset };
      try {
        if (!message.value) {
          await sendDeadLetter(producer, message.key, message.value, "Kafka message has no value", source);
          return;
        }

        let envelopeValue: unknown;
        try {
          envelopeValue = JSON.parse(message.value.toString("utf8"));
        } catch {
          await sendDeadLetter(producer, message.key, message.value, "Raw envelope is not valid JSON", source);
          return;
        }
        const envelopeResult = rawEnvelopeSchema.safeParse(envelopeValue);
        if (!envelopeResult.success) {
          await sendDeadLetter(
            producer,
            message.key,
            message.value,
            `Invalid raw envelope: ${envelopeResult.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`,
            source,
          );
          return;
        }
        const envelope = envelopeResult.data;

        if (envelope.source === "chirpstack_status") {
          let deviceStatus;
          try {
            deviceStatus = parseDeviceStatus(
              Buffer.from(envelope.payloadBase64, "base64"),
              envelope.mqttTopic,
            );
          } catch (error) {
            await sendDeadLetter(
              producer,
              message.key,
              message.value,
              error instanceof Error ? error.message : String(error),
              source,
            );
            return;
          }

          if (envelope.deviceEui && deviceStatus.deviceEui !== envelope.deviceEui.toLowerCase()) {
            await sendDeadLetter(
              producer,
              message.key,
              message.value,
              "Envelope DevEUI does not match device status DevEUI",
              source,
            );
            return;
          }
          if (deviceStatus.batteryPercent === undefined) {
            logger.info(
              { deviceEui: deviceStatus.deviceEui },
              "Ignoring ChirpStack device status without an available battery level",
            );
            return;
          }

          const deviceResult = await pool.query<{
            device_id: string;
            model: string;
            location: string | null;
            expected_interval_s: number | null;
          }>(
            `SELECT device_id, model, location, expected_interval_s
               FROM devices
              WHERE protocol = 'lorawan' AND lower(external_id) = $1 AND enabled = TRUE`,
            [deviceStatus.deviceEui],
          );
          if (!deviceResult.rows[0]) {
            await syncChirpStackDevices(pool, chirpStackPool, deviceStatus.deviceEui);
          }
          const device = deviceResult.rows[0] ?? (await pool.query<{
            device_id: string;
            model: string;
            location: string | null;
            expected_interval_s: number | null;
          }>(
            `SELECT device_id, model, location, expected_interval_s
               FROM devices
              WHERE protocol = 'lorawan' AND lower(external_id) = $1 AND enabled = TRUE`,
            [deviceStatus.deviceEui],
          )).rows[0];
          if (!device) {
            await sendDeadLetter(
              producer,
              message.key,
              message.value,
              `Unknown or disabled LoRaWAN device ${deviceStatus.deviceEui}`,
              source,
            );
            return;
          }

          const normalized = {
            version: 1,
            deviceId: device.device_id,
            deviceType: device.model.toLowerCase(),
            model: device.model,
            protocol: "lorawan",
            location: device.location,
            expectedIntervalSeconds: device.expected_interval_s,
            ts: deviceStatus.timestamp.toISOString(),
            metrics: { battery_percent: deviceStatus.batteryPercent },
            source: {
              mqttTopic: envelope.mqttTopic,
              receivedAt: envelope.receivedAt,
              kafkaTopic: topic,
              kafkaPartition: partition,
              kafkaOffset: message.offset,
            },
          };
          await producer.send({
            topic: config.normalizedTopic,
            acks: -1,
            messages: [{ key: device.device_id, value: JSON.stringify(normalized) }],
          });
          logger.info(
            { deviceId: device.device_id, batteryPercent: deviceStatus.batteryPercent },
            "Published normalized ChirpStack battery status",
          );
          return;
        }

        if (envelope.source === "ble_gateway") {
          let advertisements;
          try {
            advertisements = parseBleBatch(Buffer.from(envelope.payloadBase64, "base64"));
          } catch (error) {
            await sendDeadLetter(
              producer,
              message.key,
              message.value,
              error instanceof Error ? error.message : String(error),
              source,
            );
            return;
          }

          for (const advertisement of advertisements) {
            const deviceResult = await pool.query<{
              device_id: string;
              model: string;
              location: string | null;
              expected_interval_s: number | null;
            }>(
              `SELECT device_id, model, location, expected_interval_s
                 FROM devices
                WHERE protocol = 'ble' AND lower(regexp_replace(external_id, '[:-]', '', 'g')) = $1 AND enabled = TRUE`,
              [advertisement.externalId],
            );
            const device = deviceResult.rows[0];
            if (!device) {
              logger.debug({ externalId: advertisement.externalId }, "Ignoring unregistered BLE advertisement");
              continue;
            }
            const allowedFields = config.bleAllowedFieldsByModel[device.model];
            if (!allowedFields) {
              logger.warn({ deviceId: device.device_id, model: device.model }, "Ignoring BLE device without a model field allowlist");
              continue;
            }
            const metrics = Object.fromEntries(
              Object.entries(advertisement.metrics).filter(([field]) => allowedFields.has(field)),
            );
            if (Object.keys(metrics).length === 0) {
              logger.warn({ deviceId: device.device_id, model: device.model }, "Ignoring BLE advertisement without allowed numeric metrics");
              continue;
            }
            const normalized = {
              version: 1,
              deviceId: device.device_id,
              deviceType: device.model.toLowerCase(),
              model: device.model,
              protocol: "ble",
              gateway: undefined,
              location: device.location,
              expectedIntervalSeconds: device.expected_interval_s,
              ts: advertisement.timestamp.toISOString(),
              metrics,
              signal: advertisement.rssi === undefined ? undefined : { rssi: advertisement.rssi },
              source: {
                mqttTopic: envelope.mqttTopic,
                receivedAt: envelope.receivedAt,
                bleFormat: advertisement.modelFormat,
                kafkaTopic: topic,
                kafkaPartition: partition,
                kafkaOffset: message.offset,
              },
            };
            await producer.send({
              topic: config.normalizedTopic,
              acks: -1,
              messages: [{ key: device.device_id, value: JSON.stringify(normalized) }],
            });
            logger.info(
              { deviceId: device.device_id, metricNames: Object.keys(metrics), bleFormat: advertisement.modelFormat },
              "Published normalized BLE telemetry",
            );
          }
          return;
        }

        let parsedUplink;
        try {
          parsedUplink = parseUplink(
            Buffer.from(envelope.payloadBase64, "base64"),
            envelope.mqttTopic,
            config.metricMap,
          );
        } catch (error) {
          await sendDeadLetter(
            producer,
            message.key,
            message.value,
            error instanceof Error ? error.message : String(error),
            source,
          );
          return;
        }

        if (envelope.deviceEui && parsedUplink.deviceEui !== envelope.deviceEui.toLowerCase()) {
          await sendDeadLetter(producer, message.key, message.value, "Envelope DevEUI does not match uplink DevEUI", source);
          return;
        }

        const deviceResult = await pool.query<{
          device_id: string;
          model: string;
          location: string | null;
          expected_interval_s: number | null;
        }>(
          `SELECT device_id, model, location, expected_interval_s
             FROM devices
            WHERE protocol = 'lorawan' AND lower(external_id) = $1 AND enabled = TRUE`,
          [parsedUplink.deviceEui],
        );
        if (!deviceResult.rows[0]) {
          await syncChirpStackDevices(pool, chirpStackPool, parsedUplink.deviceEui);
        }
        const device = deviceResult.rows[0] ?? (await pool.query<{
          device_id: string;
          model: string;
          location: string | null;
          expected_interval_s: number | null;
        }>(
          `SELECT device_id, model, location, expected_interval_s
             FROM devices
            WHERE protocol = 'lorawan' AND lower(external_id) = $1 AND enabled = TRUE`,
          [parsedUplink.deviceEui],
        )).rows[0];
        if (!device) {
          await sendDeadLetter(
            producer,
            message.key,
            message.value,
            `Unknown or disabled LoRaWAN device ${parsedUplink.deviceEui}`,
            source,
          );
          return;
        }

        try {
          parsedUplink = filterUplinkMetrics(
            parsedUplink,
            allowedFieldsForDevice(
              device.model,
              parsedUplink.deviceEui,
              config.model,
              config.deviceEui,
              config.allowedFields,
              config.allowedFieldsByModel,
            ),
            config.metricMap,
          );
        } catch (error) {
          await sendDeadLetter(
            producer,
            message.key,
            message.value,
            error instanceof Error ? error.message : String(error),
            source,
          );
          return;
        }

        const normalized = {
          version: 1,
          deviceId: device.device_id,
          deviceType: device.model.toLowerCase(),
          model: device.model,
          protocol: "lorawan",
          gateway: parsedUplink.gateway,
          location: device.location,
          expectedIntervalSeconds: device.expected_interval_s,
          ts: parsedUplink.timestamp.toISOString(),
          metrics: parsedUplink.metrics,
          signal: parsedUplink.signal,
          source: {
            mqttTopic: envelope.mqttTopic,
            receivedAt: envelope.receivedAt,
            kafkaTopic: topic,
            kafkaPartition: partition,
            kafkaOffset: message.offset,
          },
        };
        await producer.send({
          topic: config.normalizedTopic,
          acks: -1,
          messages: [{ key: device.device_id, value: JSON.stringify(normalized) }],
        });
        logger.info(
          {
            deviceId: device.device_id,
            deviceEui: parsedUplink.deviceEui,
            metricNames: Object.keys(parsedUplink.metrics),
          },
          "Published normalized telemetry",
        );
      } catch (error) {
        logger.error({ err: error, ...source }, "Normalizer failed; Kafka offset will not be committed");
        throw error;
      }
    },
  });
  ready = true;
  logger.info(
    { rawTopic: config.rawTopic, normalizedTopic: config.normalizedTopic, deadLetterTopic: config.deadLetterTopic },
    "Normalizer is running",
  );
}

async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  ready = false;
  logger.info({ signal }, "Shutting down normalizer");
  if (deviceSyncTimer) {
    clearInterval(deviceSyncTimer);
  }
  await Promise.allSettled([
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
    consumer.stop(),
  ]);
  await Promise.allSettled([
    consumer.disconnect(),
    producer.disconnect(),
    pool.end(),
    chirpStackPool.end(),
  ]);
}

process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Failed to start normalizer");
  await Promise.allSettled([
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
    consumer.disconnect(),
    producer.disconnect(),
    pool.end(),
  ]);
  process.exit(1);
});
