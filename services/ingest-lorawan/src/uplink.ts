import { z } from "zod";

const uplinkSchema = z
  .object({
    deviceInfo: z
      .object({
        devEui: z.string().optional(),
      })
      .passthrough()
      .optional(),
    devEui: z.string().optional(),
    time: z.string(),
    object: z.record(z.string().max(128), z.unknown()),
    rxInfo: z
      .array(
        z
          .object({
            rssi: z.number().optional(),
            snr: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const deviceStatusSchema = z
  .object({
    deviceInfo: z
      .object({
        devEui: z.string().optional(),
      })
      .passthrough()
      .optional(),
    devEui: z.string().optional(),
    time: z.string(),
    batteryLevel: z.number().finite().optional(),
    batteryLevelUnavailable: z.boolean().optional(),
  })
  .passthrough();

export interface ParsedUplink {
  deviceEui: string;
  timestamp: Date;
  metrics: Record<string, number>;
  ignoredNumericFields: string[];
  gateway?: string;
  signal?: { rssi?: number; snr?: number };
}

export interface ParsedDeviceStatus {
  deviceEui: string;
  timestamp: Date;
  batteryPercent?: number;
}

export function parseDeviceStatus(payload: Buffer, topic: string): ParsedDeviceStatus {
  if (payload.length > 1_048_576) {
    throw new Error("MQTT device status payload exceeds the 1 MiB limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("MQTT device status payload is not valid JSON");
  }

  const parsed = deviceStatusSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `Invalid ChirpStack device status: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`,
    );
  }
  const deviceEui =
    parsed.data.deviceInfo?.devEui ??
    parsed.data.devEui ??
    /^application\/[^/]+\/device\/([0-9a-f]{16})\/event\/status$/i.exec(topic)?.[1];
  if (!deviceEui || !/^[0-9a-f]{16}$/i.test(deviceEui)) {
    throw new Error("Device status does not contain a valid 16-character DevEUI");
  }

  const timestamp = new Date(parsed.data.time);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Device status time is not a valid timestamp");
  }

  let batteryPercent: number | undefined;
  if (!parsed.data.batteryLevelUnavailable && parsed.data.batteryLevel !== undefined) {
    if (parsed.data.batteryLevel < 0 || parsed.data.batteryLevel > 100) {
      throw new Error("Device status batteryLevel must be between 0 and 100");
    }
    batteryPercent = parsed.data.batteryLevel;
  }

  return {
    deviceEui: deviceEui.toLowerCase(),
    timestamp,
    batteryPercent,
  };
}

export function filterUplinkMetrics(
  uplink: ParsedUplink,
  allowedFields: Set<string> | undefined,
  metricMap: Record<string, string>,
): ParsedUplink {
  if (!allowedFields) {
    return uplink;
  }
  const allowedMetrics = new Set([...allowedFields].map((field) => metricMap[field] ?? field));
  const metrics = Object.fromEntries(
    Object.entries(uplink.metrics).filter(([metric]) => allowedMetrics.has(metric)),
  );
  if (Object.keys(metrics).length === 0) {
    throw new Error("Decoded uplink contains no finite numeric metrics allowed for this device model");
  }
  return { ...uplink, metrics };
}

export function allowedFieldsForDevice(
  model: string,
  deviceEui: string,
  defaultModel: string,
  defaultDeviceEui: string | undefined,
  defaultFields: Set<string> | undefined,
  fieldsByModel: Record<string, Set<string>>,
): Set<string> | undefined {
  const modelFields = fieldsByModel[model];
  if (modelFields) {
    return modelFields;
  }
  const normalizeModel = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isConfiguredDefault =
    normalizeModel(model) === normalizeModel(defaultModel) ||
    (defaultDeviceEui !== undefined && deviceEui.toLowerCase() === defaultDeviceEui.toLowerCase());
  return isConfiguredDefault ? defaultFields : undefined;
}

export function parseUplink(
  payload: Buffer,
  topic: string,
  metricMap: Record<string, string>,
  allowedFields?: Set<string>,
): ParsedUplink {
  if (payload.length > 1_048_576) {
    throw new Error("MQTT payload exceeds the 1 MiB limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("MQTT payload is not valid JSON");
  }

  const parsed = uplinkSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`Invalid ChirpStack uplink: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  }
  if (Object.keys(parsed.data.object).length > 100) {
    throw new Error("Decoded uplink contains more than 100 fields");
  }

  const deviceEui =
    parsed.data.deviceInfo?.devEui ??
    parsed.data.devEui ??
    topic.split("/")[3];
  if (!deviceEui || !/^[0-9a-f]{16}$/i.test(deviceEui)) {
    throw new Error("Uplink does not contain a valid 16-character DevEUI");
  }

  const timestamp = new Date(parsed.data.time);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Uplink time is not a valid timestamp");
  }

  const metrics: Record<string, number> = {};
  const ignoredNumericFields: string[] = [];
  for (const [sourceName, value] of Object.entries(parsed.data.object)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    if (allowedFields && !allowedFields.has(sourceName)) {
      ignoredNumericFields.push(sourceName);
      continue;
    }

    const metricName = metricMap[sourceName] ?? sourceName;
    if (!metricName || metricName.length > 128) {
      throw new Error(`Invalid metric name mapped from "${sourceName}"`);
    }
    if (Object.hasOwn(metrics, metricName)) {
      throw new Error(`Multiple payload fields map to metric "${metricName}"`);
    }
    metrics[metricName] = value;
  }

  if (Object.keys(metrics).length === 0) {
    throw new Error("Decoded uplink contains no finite numeric metrics");
  }

  const firstRx = parsed.data.rxInfo?.[0];
  const gateway = firstRx && "gatewayId" in firstRx && typeof firstRx.gatewayId === "string"
    ? firstRx.gatewayId
    : undefined;
  const signal =
    firstRx && (firstRx.rssi !== undefined || firstRx.snr !== undefined)
      ? { rssi: firstRx.rssi, snr: firstRx.snr }
      : undefined;

  return {
    deviceEui: deviceEui.toLowerCase(),
    timestamp,
    metrics,
    ignoredNumericFields,
    gateway,
    signal,
  };
}

export function parseMetricMap(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("LORAWAN_METRIC_MAP_JSON must be valid JSON");
  }

  const result = z.record(z.string().min(1), z.string().min(1)).safeParse(decoded);
  if (!result.success) {
    throw new Error("LORAWAN_METRIC_MAP_JSON must be an object mapping field names to metric names");
  }
  return result.data;
}

export function parseAllowedFields(value: string | undefined): Set<string> | undefined {
  if (!value || value === "[]") {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("LORAWAN_ALLOWED_FIELDS_JSON must be valid JSON");
  }
  const result = z.array(z.string().min(1).max(128)).safeParse(decoded);
  if (!result.success) {
    throw new Error("LORAWAN_ALLOWED_FIELDS_JSON must be an array of decoded field names");
  }
  return new Set(result.data);
}

export function parseAllowedFieldsByModel(
  value: string | undefined,
): Record<string, Set<string>> {
  if (!value) {
    return {};
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("LORAWAN_ALLOWED_FIELDS_BY_MODEL_JSON must be valid JSON");
  }
  const result = z.record(z.string().min(1), z.array(z.string().min(1).max(128))).safeParse(decoded);
  if (!result.success) {
    throw new Error(
      "LORAWAN_ALLOWED_FIELDS_BY_MODEL_JSON must map device model names to arrays of decoded field names",
    );
  }
  return Object.fromEntries(Object.entries(result.data).map(([model, fields]) => [model, new Set(fields)]));
}
