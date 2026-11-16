-- Runs once, the first time the timescaledb container starts with an empty data volume.
-- Phase 1 schema: device registry, readings (time-series) and events.
-- alert_rules, alerts and users are added in later phases.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Device registry: adding a sensor = adding a row, never changing code.
CREATE TABLE IF NOT EXISTS devices (
  device_id           TEXT PRIMARY KEY,            -- our stable name, e.g. lds12-001
  external_id         TEXT NOT NULL UNIQUE,        -- DevEUI (LoRaWAN) or MAC address (BLE)
  protocol            TEXT NOT NULL CHECK (protocol IN ('lorawan', 'ble')),
  model               TEXT NOT NULL,               -- e.g. LDS12-LWB
  location            TEXT,
  device_group        TEXT,                        -- used later for role-based dashboards
  expected_interval_s INTEGER,                     -- how often it should report (offline alerts)
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per device, metric and time. The primary key makes duplicate messages harmless.
CREATE TABLE IF NOT EXISTS readings (
  ts         TIMESTAMPTZ      NOT NULL,
  device_id  TEXT             NOT NULL,
  metric     TEXT             NOT NULL,             -- e.g. distance_mm, current_a, temp_c
  value      DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (device_id, metric, ts)
);
SELECT create_hypertable('readings', 'ts', if_not_exists => TRUE);

-- One-off events: button press, motion, and similar.
CREATE TABLE IF NOT EXISTS events (
  ts         TIMESTAMPTZ NOT NULL,
  device_id  TEXT        NOT NULL,
  event      TEXT        NOT NULL,                  -- e.g. button_press, motion
  PRIMARY KEY (device_id, event, ts)
);
SELECT create_hypertable('events', 'ts', if_not_exists => TRUE);
