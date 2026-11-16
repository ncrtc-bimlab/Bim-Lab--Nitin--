export const FILTERS = new Set(["all", "under50", "under20", "offline"]);
export const PROTOCOLS = new Set(["all", "lorawan", "ble"]);
export const CONNECTION_STATUSES = new Set(["all", "online", "offline"]);

export function isPercentageMetric(metric) {
  if (typeof metric !== "string") {
    return false;
  }
  const normalized = metric.toLowerCase().replace(/[^a-z0-9%]/g, "");
  return normalized.includes("%") || normalized.includes("percent") || normalized.includes("pct");
}

export function toSensorView(row) {
  const batteryValue = row.battery_value === null || row.battery_value === undefined
    ? null
    : Number(row.battery_value);
  const isOffline = row.is_offline === true;
  const isReportedPercentage =
    isPercentageMetric(row.battery_metric) &&
    batteryValue !== null &&
    Number.isFinite(batteryValue) &&
    batteryValue >= 0 &&
    batteryValue <= 100;
  const batteryPercent = isOffline ? 0 : isReportedPercentage ? batteryValue : null;

  let status = "Online";
  if (isOffline) {
    status = "Not answering";
  } else if (row.battery_metric === null || row.battery_metric === undefined) {
    status = "No battery reading";
  } else if (isPercentageMetric(row.battery_metric) && !isReportedPercentage) {
    status = "Invalid percentage reading";
  } else if (!isReportedPercentage) {
    status = "Percent not reported";
  }

  return {
    deviceId: row.sensor_name,
    sensorName: typeof row.sensor_name === "string" ? row.sensor_name.toUpperCase() : row.sensor_name,
    protocol: row.protocol,
    model: row.model,
    description: row.description ?? null,
    location: row.location,
    expectedIntervalSeconds: row.expected_interval_s === null || row.expected_interval_s === undefined
      ? null
      : Number(row.expected_interval_s),
    batteryPercent,
    batteryMetric: row.battery_metric,
    batteryValue,
    batteryTs: row.battery_ts,
    lastSeen: row.last_seen,
    isOffline,
    status,
  };
}

export function filterSensors(sensors, filter, protocol = "all") {
  if (!FILTERS.has(filter)) {
    throw new Error(`Unknown battery filter: ${filter}`);
  }
  if (!PROTOCOLS.has(protocol)) {
    throw new Error(`Unknown sensor protocol: ${protocol}`);
  }
  const protocolSensors = protocol === "all"
    ? sensors
    : sensors.filter((sensor) => sensor.protocol === protocol);
  switch (filter) {
    case "under50":
      return protocolSensors.filter(
        (sensor) => !sensor.isOffline && sensor.batteryPercent !== null && sensor.batteryPercent < 50,
      );
    case "under20":
      return protocolSensors.filter(
        (sensor) => !sensor.isOffline && sensor.batteryPercent !== null && sensor.batteryPercent < 20,
      );
    case "offline":
      return protocolSensors.filter((sensor) => sensor.isOffline);
    default:
      return protocolSensors;
  }
}

export function filterSensorsByStatusAndSearch(sensors, status, search = "") {
  if (!CONNECTION_STATUSES.has(status)) {
    throw new Error(`Unknown connection status: ${status}`);
  }
  const query = search.trim().toLowerCase();
  return sensors.filter((sensor) => {
    if (status === "online" && sensor.isOffline) {
      return false;
    }
    if (status === "offline" && !sensor.isOffline) {
      return false;
    }
    if (!query) {
      return true;
    }
    return [sensor.sensorName, sensor.model]
      .some((value) => typeof value === "string" && value.toLowerCase().includes(query));
  });
}

export function summarizeSensors(sensors) {
  return {
    total: sensors.length,
    under50: sensors.filter(
      (sensor) => !sensor.isOffline && sensor.batteryPercent !== null && sensor.batteryPercent < 50,
    ).length,
    under20: sensors.filter(
      (sensor) => !sensor.isOffline && sensor.batteryPercent !== null && sensor.batteryPercent < 20,
    ).length,
    offline: sensors.filter((sensor) => sensor.isOffline).length,
  };
}
