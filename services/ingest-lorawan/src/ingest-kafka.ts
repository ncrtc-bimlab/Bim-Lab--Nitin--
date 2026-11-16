import { createServer } from "node:http";
import { Kafka, logLevel, type Producer } from "kafkajs";
import mqttLibrary from "mqtt";
import pino from "pino";
import { z } from "zod";
import { filterBleBatchByMacs, parseBleAllowedMacs } from "./ble.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const brokers = required("KAFKA_BROKERS")
  .split(",")
  .map((broker) => broker.trim())
  .filter(Boolean);
if (brokers.length === 0) {
  throw new Error("KAFKA_BROKERS must contain at least one broker address");
}

const rawTopic = process.env.KAFKA_RAW_TOPIC ?? "telemetry.raw";
const bleMqttTopic = process.env.BLE_MQTT_TOPIC ?? "ble/gateway/+/advertisment";
const allowedBleMacs = parseBleAllowedMacs(process.env.BLE_ALLOWED_MACS_JSON);
const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? "ingest-lorawan",
  brokers,
  logLevel: logLevel.NOTHING,
});
const producer: Producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 1,
});
const mqtt = mqttLibrary.connect(required("MQTT_URL"), {
  clientId: process.env.MQTT_CLIENT_ID ?? "twin-ingest-lorawan",
  clean: false,
  reconnectPeriod: 5_000,
  connectTimeout: 30_000,
});
let ready = false;
let closing = false;

const healthServer = createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  const healthy = ready && mqtt.connected && !closing;
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "ok" : "starting" }));
});

const euiFromTopic = /^application\/[^/]+\/device\/([0-9a-f]{16})\/event\/(?:up|status)$/i;
const euiSchema = z.object({
  deviceInfo: z.object({ devEui: z.string().regex(/^[0-9a-f]{16}$/i).optional() }).optional(),
  devEui: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
});

function getDeviceEui(topic: string, payload: Buffer): string | undefined {
  const match = euiFromTopic.exec(topic);
  if (match) {
    return match[1].toLowerCase();
  }
  try {
    const parsed = euiSchema.safeParse(JSON.parse(payload.toString("utf8")));
    const eui = parsed.success ? parsed.data.deviceInfo?.devEui ?? parsed.data.devEui : undefined;
    return eui?.toLowerCase();
  } catch {
    return undefined;
  }
}

mqtt.on("connect", () => {
  logger.info("Connected to MQTT broker");
  const topics = [
    "application/+/device/+/event/up",
    "application/+/device/+/event/status",
  ];
  if (allowedBleMacs.size > 0) {
    topics.push(bleMqttTopic);
  } else {
    logger.info("BLE subscription disabled until BLE_ALLOWED_MACS_JSON contains owned device MAC addresses");
  }
  mqtt.subscribe(topics, { qos: 1 }, (error) => {
    if (error) {
      ready = false;
      logger.error({ err: error }, "Failed to subscribe to telemetry MQTT topics");
      return;
    }
    ready = true;
    logger.info({ bleEnabled: allowedBleMacs.size > 0, bleMqttTopic }, "Subscribed to telemetry MQTT topics");
  });
});
mqtt.on("reconnect", () => {
  ready = false;
  logger.warn("Reconnecting to MQTT broker");
});
mqtt.on("close", () => {
  ready = false;
});
mqtt.on("error", (error) => logger.error({ err: error }, "MQTT client error"));

mqtt.handleMessage = (packet, callback) => {
  void (async () => {
    try {
      if (!mqtt.connected || closing) {
        throw new Error("MQTT broker is disconnected");
      }
      const payload = Buffer.from(packet.payload);
      if (payload.length > 1_048_576) {
        throw new Error("MQTT payload exceeds the 1 MiB limit");
      }
      const isBle = packet.topic.startsWith("ble/");
      const filteredBlePayload = isBle ? filterBleBatchByMacs(payload, allowedBleMacs) : undefined;
      if (isBle && !filteredBlePayload) {
        callback();
        return;
      }
      const rawPayload = filteredBlePayload ?? payload;
      const deviceEui = getDeviceEui(packet.topic, payload);
      const rawRecord = {
        version: 1,
        source: isBle
          ? "ble_gateway"
          : packet.topic.endsWith("/event/status")
            ? "chirpstack_status"
            : "chirpstack",
        mqttTopic: packet.topic,
        receivedAt: new Date().toISOString(),
        deviceEui,
        payloadBase64: rawPayload.toString("base64"),
      };
      await producer.send({
        topic: rawTopic,
        acks: -1,
        messages: [
          {
            key: deviceEui ?? packet.topic,
            value: JSON.stringify(rawRecord),
            timestamp: String(Date.now()),
          },
        ],
      });
      logger.info({ deviceEui, mqttTopic: packet.topic, source: rawRecord.source }, "Forwarded telemetry to telemetry.raw");
      callback();
    } catch (error) {
      logger.error({ err: error, mqttTopic: packet.topic }, "Failed to publish raw uplink");
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  })();
};

async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  ready = false;
  logger.info({ signal }, "Shutting down MQTT ingester");
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await new Promise<void>((resolve) => mqtt.end(false, {}, () => resolve()));
  await producer.disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

async function start(): Promise<void> {
  healthServer.listen(3000, "0.0.0.0");
  await producer.connect();
  logger.info({ brokers, rawTopic }, "Connected producer to Kafka");
}

start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Failed to start MQTT ingester");
  await Promise.allSettled([producer.disconnect()]);
  process.exitCode = 1;
});
