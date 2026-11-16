# IoT Digital Twin

Designed by Nitin Maurya. This is the starting point of the build described in the design document.

**Build status and phase gates:** See [the build roadmap](docs/BUILD-ROADMAP.md).
Phase 1 foundation services and Phase 2 telemetry visuals are running. Phase 3
Kafka buffering and its ten-minute replay acceptance test are complete. See
[the project context](docs/PROJECT-CONTEXT.md) for the handoff and verification
record.

**Current goal:** Phase 5 BLE ingestion is enabled for three selected beacons;
Phase 4 remains in progress. Vibo is skipped until its protocol is confirmed.

The GW-001BWP is publishing JSON advertisement batches to
`ble/gateway/<gateway-mac>/advertisment` (the spelling is configured on the
gateway). BLE ingestion is enabled only for the owner-selected beacon MACs;
this prevents storing nearby unknown devices. Three selected beacons are
registered and allowlisted. The parser accepts decoded advertisements only, filters to the
BLE device registry and model-specific numeric field allowlists, and skips
raw/unrecognized beacons. See Phase 5 below to add more devices.

## What is in this folder

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | Starts Mosquitto, ChirpStack, Kafka, telemetry consumers, TimescaleDB, Redis, Grafana and the battery dashboard |
| `infra/chirpstack/` | ChirpStack settings (region IN865 only) |
| `infra/timescaledb/init/001-schema.sql` | Creates `devices`, `readings`, `events` the first time the database starts |
| `infra/mosquitto/config/` | MQTT broker settings (anonymous for the lab; hardened in phase 7) |
| `services/ingest-lorawan/` | MQTT-to-Kafka ingester, Kafka normalizer and processor, Phase 2 direct-ingest path, and tests |
| `infra/grafana/` | Provisioned TimescaleDB datasource and LoRaWAN dashboard |
| `services/battery-dashboard/` | Sensor battery dashboard, filtered `.xlsx` export, and LoRaWAN bulk device import |
| `samples/lds12-up.json`, `samples/aqs01-up.json` | Sanitized ChirpStack uplinks for LDS-12-LWB and AQS-01-L |
| `packages/` | Shared types and helpers planned for later phases |
| `docs/PROJECT-CONTEXT.md` | Phase status, architecture, key decisions, and verification handoff |

## Before you start

1. Install Docker Desktop (or Docker Engine and the Compose plugin). Check: `docker compose version`
2. Copy `.env.example` to `.env` only if you do not already have `.env`.
   Replace the Grafana admin placeholder before sharing access. Keep `.env`
   private and never commit it.
3. Find the IP address of this computer on the lab network (for example `192.168.1.50`). The gateway will send data to it. Give it a fixed address or a DHCP reservation.

## Step 1: Start everything

```bash
docker compose up -d
docker compose ps
```

Long-running services should show `running` or `healthy`; the one-shot
`kafka-init` service should show `exited (0)` after creating topics. If a
service keeps restarting, run `docker compose logs <service-name>`.
Configuration is mounted from `infra/`; when adding a service config, make
sure the Compose bind-mount path matches its actual location.

## Step 2: Check that the pieces work

```bash
# Database: you should see the tables devices, readings, events
docker compose exec timescaledb psql -U twin -d twin -c "\dt"

# MQTT: leave this running, it prints every message that reaches the broker
docker compose exec mosquitto mosquitto_sub -t '#' -v
```

`timescaledb` is the project telemetry database; `postgres` is ChirpStack's
separate internal database. If the `timescaledb` service was added to an
already existing project, run `docker compose up -d timescaledb` before the
database check above. The existing TimescaleDB data volume is named
`timescaledata` and is retained across container recreation.

Open the ChirpStack web page: http://localhost:8086  (first login: user `admin`, password `admin`). **Change the password right away** (top right menu).

## Step 3: Connect the LoRa gateway (GW-002LW)

1. In ChirpStack: **Gateways > Add gateway**.
   - Name: `gw-002lw-lab`
   - Gateway ID: the 16-character EUI printed on the gateway or shown on its web page
2. Open the gateway's own settings page in a browser. Find the LoRaWAN or packet forwarder section and set:
   - Server address: the IP of this computer
   - Server port (up and down): `1700`
   - Protocol: Semtech UDP packet forwarder
   - Frequency plan or region: IN865
3. Within a minute the gateway in ChirpStack should show a recent "last seen" time. The MQTT window from step 2 should print messages on topics starting with `in865/gateway/`.

The GW-002LW protocol is confirmed as Semtech UDP, so the Basic Station service
is intentionally not started. If the gateway's settings page does not match
Semtech UDP, check its manual before changing the deployment.

## Step 4: Add the first sensor (LDS12-LWB)

1. **Device profiles > Add device profile**
   - Name: `LDS12-LWB`
   - Region: IN865, MAC version and regional parameters revision: take them from the sensor's manual (usually LoRaWAN 1.0.3, RP002-1.0.x)
   - Join (OTAA/ABP): enable OTAA
   - Codec tab: choose **JavaScript functions** and paste the payload decoder from the manufacturer. Save a copy of it as `infra/codecs/lds12-lwb.js` in this project.
2. **Applications > Add application**: name it `Distance`.
3. In that application: **Add device**
   - Name: `lds12-001`
   - Device EUI: from the sensor label
   - Device profile: `LDS12-LWB`
   - On the keys tab, enter the **Application key** (AppKey) from the sensor label or the manufacturer's setup.
4. Power on the sensor, or press its activation button according to its manual, so it joins the network.
5. Open the device's **Events** tab. You should see a `join` event, then `up` events with decoded values.
6. In the MQTT window you should see a topic like `application/<id>/device/<dev-eui>/event/up` with JSON that contains an `object` field (the decoded values).

## Phase 1 is done when

- [ ] `docker compose ps` shows all services running
- [ ] The ChirpStack admin password is changed
- [ ] GW-002LW shows as recently seen in ChirpStack
- [ ] LDS12-LWB joined and its uplinks are visible in ChirpStack
- [ ] The same uplinks are visible in the `mosquitto_sub` window

Save one real uplink JSON message as `samples/lds12-up.json`. Phase 2 uses it to write and test the Node.js code.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No message from the gateway | Server IP and port 1700 on the gateway; computer firewall allows UDP 1700; same network |
| `Connection refused` from ChirpStack | Check that `mosquitto`, `postgres`, and `redis` are healthy; inspect `docker compose logs chirpstack mosquitto postgres`; confirm Compose mounts the files under `infra/` |
| ChirpStack runs but reports missing database relations | Check `docker compose logs chirpstack postgres` and inspect the database before resetting volumes; do not use `docker compose down -v` if you need to preserve data |
| Gateway packets arrive but ChirpStack says the gateway ID does not exist | Add that gateway in ChirpStack using the gateway's exact 16-character EUI, then check its last-seen status |
| Gateway seen but sensor does not join | Region must be IN865 everywhere; DevEUI and AppKey typed exactly; sensor in range; wait for its next join attempt |
| Join works but values look wrong | The payload decoder pasted in the device profile; test it in the device's Events tab |
| `chirpstack` keeps restarting | `docker compose logs chirpstack`; usually a wrong database password in `.env` after the data volume was already created (reset with `docker compose down -v` only if you have nothing to keep) |

## Phase 2: First pipeline

The `ingest-lorawan` service subscribes to
ChirpStack's uplink topic, stores allowlisted numeric decoded fields in
TimescaleDB, and keeps each device's latest reading and last-seen timestamp in
Redis. The provisioned Grafana dashboard is available at
http://localhost:3001 (default lab login: `admin` / `change-me-before-use`).
Change the Grafana password before sharing access. Grafana is bound to
localhost only.

The separate sensor battery dashboard is available at http://localhost:3002.
It lists each enabled sensor by its assigned asset ID (`device_id`), with model,
the device description configured in ChirpStack for LoRaWAN devices, protocol,
latest response battery metric, and last response. Asset IDs
are shown in uppercase. Choose all devices, LoRaWAN, or BLE independently from
the battery status filter. Filter by online/offline state, search asset IDs or
models, and choose 10, 20, or 50 rows per page. These filters also apply to the
**Export filtered Excel file** button. Exports are real `.xlsx` workbooks.
Click an asset ID to open its sensor detail page, with its ChirpStack device
description, latest stored value for each metric, connection and battery status, and recent
per-metric graphs. Graphs support 24-hour, 7-day, and 30-day ranges and use only
stored telemetry.

Battery percentage uses the latest saved ChirpStack battery status for LoRaWAN
devices, or the latest explicitly reported percentage metric (`percent`, `pct`,
or `%`) for other devices. It remains visible across later uplinks that omit
battery status, until the next status is stored. Raw voltage values are not
converted without model-specific calibration. A sensor with no readings, or no
response for three times its configured interval, is shown as 0% /
**Not answering**.
When no interval is configured, the dashboard uses 24 hours as the expected
interval before applying that three-times rule. This dashboard is bound to
localhost, like Grafana.

LoRaWAN uplinks for the configured default model use its optional shared
allowlist; explicitly configured model allowlists take precedence. Newly added
models without their own allowlist store all finite numeric fields from the
decoded ChirpStack object, so adding a device does not silently limit its
detail view to battery fields. Review the decoded values and add a model-specific
allowlist when validation or model-specific filtering is needed.

The dashboard also includes a **Bulk add LoRaWAN sensors** page. To use it,
create a ChirpStack API key with permission to list applications and device
profiles, create devices, and set device keys. Put the key in the local `.env`
as `CHIRPSTACK_API_TOKEN` (never in an Excel file or source control), then run:

```bash
docker compose up -d --build battery-dashboard
```

Open the dashboard and select **Bulk add LoRaWAN sensors**. Select a ChirpStack
device profile first, then the application that will own the devices. Download
the `.xlsx` template and fill its `DevEUI`, `JoinEUI`, `App Key`,
`Asset ID/Name`, and `Description` columns. `JoinEUI` and `Description` may be
blank; DevEUI, JoinEUI, and keys must be entered as text to preserve leading
zeroes. For LoRaWAN 1.1 profiles, also fill the `NwkKey` column.
Review the rows before confirming the import. The importer accepts up to 500
devices per workbook and reports individual failures; it never includes App
Keys in the preview.

## Phase 4: finish LoRaWAN sensor onboarding

The telemetry registry currently has six LoRaWAN devices: LDS-12-LWB (`be004`),
AQS-01-L (`au001`), LDS-40-LWB (`bf002`), CS01-LWB (`av007-bi003`), T-68-DL
(`bl002`), and LHT-65S-E3 (`bg001`). Their uplinks are being stored. Finish
validating these devices and onboard any other models you intend to use:

1. **Check the ChirpStack inventory.** In the application's Devices tab, verify
   each device name, DevEUI, and device profile against the physical sensor
   label/manual. In particular, correct the `22-LWB` device whose ChirpStack
   name says its DevEUI is wrong. Confirm the TS-01-LS device and its exact
   DevEUI/profile; do not infer identity from a join/error log.
2. **Get one fresh uplink per device.** Power/wake the sensor as its manual
   requires. Open its ChirpStack Events tab and wait for an `up` event. Confirm
   the decoded `object` has fields and values, not just raw `data`. If it is
   missing or implausible, fix/test the manufacturer's decoder in ChirpStack
   before proceeding.
3. **Record the decoded sample.** For each model, note the device name, model /
   profile, field names, example values, and timestamp. Share a sanitized
   decoded `object`; never share AppKeys, join keys, or passwords.
4. **Check the physical reading at the same time.** Compare every field you
   want to use with a real reference measurement and record its unit. For
   example, compare the sensor temperature to a thermometer. Do not allowlist
   uncertain fields, status flags, or implausible sentinel values.
5. **Add the device in ChirpStack.** Enabled LoRaWAN devices with a device
   profile are synchronized into the telemetry registry automatically at
   normalizer startup and every 30 seconds. Their lowercase device name becomes
   the dashboard asset ID, with the DevEUI appended if that ID already exists.
   The dashboard refreshes automatically every 30 seconds. Existing registry
   entries retain their configured IDs and settings. The model's decoded fields
   still need validation and an appropriate model allowlist before relying on
   the stored telemetry.
6. **Verify storage after the next uplink.** Run:

   ```bash
   docker compose exec timescaledb psql -U twin -d twin -c \
     "SELECT d.device_id, d.model, r.metric, r.value, r.ts FROM devices d JOIN readings r USING (device_id) WHERE d.protocol = 'lorawan' ORDER BY r.ts DESC LIMIT 50"
   ```

   Confirm the expected device, metric names, plausible values, and recent
   timestamps. If ChirpStack shows an uplink but this query does not, send the
   device name/model and timestamp so the ingestion/dead-letter path can be
   checked.
7. **Finish the inventory deliberately.** Repeat steps 1–6 for each model you
   intend to support from the design inventory. Leave devices with wrong IDs,
   missing decoders, or unverified payloads disabled/excluded and document
   them. Vibo stays excluded until its protocol and payload are confirmed.

**Phase 4 exit check:** Every in-scope sensor has the correct registry identity,
decoded uplink, verified field meaning/unit and reference measurement, and
readings visible in TimescaleDB. Anything not confirmed is explicitly
excluded—not guessed.

## Phase 5: BLE gateway

The GW-001BWP publishes JSON arrays on the observed MQTT topic
`ble/gateway/+/advertisment`. The current `BLE_ALLOWED_MACS_JSON` contains only
the three owner-selected beacons below; nearby devices not on this list are
not ingested.

| Device ID | BLE MAC | Model format | Numeric fields currently allowed |
| --- | --- | --- | --- |
| `ble-pir-001` | `c3b337e8a487` | `MK Sensor-PIR` | `DoorStatus`, `PIRStatus`, `Major`, `Minor`, `BattVoltage`, `TxPower` |
| `ble-tag-001` | `f044d381a46b` | `MK Tag-Tag info` | `HallStatus`, `HallCount`, `3-axisStatus`, `3-axisCount`, `BattVoltage` |
| `ble-beaconx-001` | `c703bd278150` | `BeaconX Pro-Device info` | `TxPower`, `AdvInterval`, `BattVoltage` |

No persisted reading was seen immediately after enabling these devices. Keep
each beacon powered and near the gateway, then verify that advertisements
arrive:

```bash
docker compose exec mosquitto mosquitto_sub -h 127.0.0.1 -p 1883 \
  -t 'ble/gateway/+/advertisment' -F '%I %t'
docker compose exec timescaledb psql -U twin -d twin -c \
  "SELECT d.device_id, r.metric, r.value, r.ts FROM devices d JOIN readings r USING (device_id) WHERE d.protocol = 'ble' ORDER BY r.ts DESC LIMIT 20"
```

To finish the current BLE onboarding:

1. Keep the GW-001BWP connected to Wi-Fi/MQTT. Keep only the three selected
   beacon MACs in `BLE_ALLOWED_MACS_JSON`; nearby phones/earbuds/unknown beacons
   must remain excluded.
2. Power/wake each selected beacon and place it near the gateway. Trigger its
   documented action one at a time (PIR motion, tag/contact change, or beacon
   advertisement). The current observed MQTT topic is
   `ble/gateway/<gateway-mac>/advertisment`.
3. Check that the topic watcher prints fresh messages. Then run the TimescaleDB
   query above and confirm the matching `ble-*` device has recent readings.
   The gateway sends periodic advertisements, so keep it running long enough
   for a new scan batch after starting the watcher.
4. Compare decoded values with the beacon's physical/action state and manual.
   For example, verify `PIRStatus` changes when motion is triggered. Send the
   action, approximate time, device ID, and observed field/value if a metric
   does not change or is unclear.
5. Repeat for the other selected beacons. Do not interpret raw advertisement
   bytes, RSSI, battery units, or vendor-specific numeric fields without their
   documented meanings.
6. Once readings are confirmed, the remaining software gate is to add and
   verify event mapping/deduplication and dashboard behavior for actual button,
   contact, or PIR events. Repeated BLE advertisements should not become noisy
   duplicate events.

**Phase 5 exit check:** Real owned beacon data is stored for each in-scope
device; decoded fields are checked against the device action/manual; the agreed
button/contact and PIR events appear on the dashboard within seconds; and
repeated advertisements do not create noisy duplicate events.

When onboarding another owned beacon:

1. Add its BLE MAC address in normalized 12-hex-character form and its model
   name to the TimescaleDB device registry, for example:

   ```sql
   INSERT INTO devices (device_id, external_id, protocol, model)
   VALUES ('ble-new-001', '001122334455', 'ble', 'Your Beacon Model');
   ```

2. Set `BLE_ALLOWED_MACS_JSON` to a JSON array containing only owned device
   MACs, e.g. `["00:11:22:33:44:55"]`.
3. Set `BLE_ALLOWED_FIELDS_BY_MODEL_JSON` to verified decoded numeric fields
   per model, e.g. `{"MK Sensor-PIR":["PIRStatus","DoorStatus","BattVoltage"]}`.
   Confirm field meanings and units against the sensor manual before relying on
   the readings.
4. Restart the ingester and normalizer with `docker compose up -d --build
   ingest-lorawan normalizer`. The processor handles registered BLE readings
   in the same TimescaleDB/Redis pipeline as LoRaWAN.

The gateway may see unrelated nearby beacons. Do not remove the MAC allowlist
or ingest all scan results; raw advertisements are not persisted by the Twin.

The current local `.env` registers the observed LDS-12-LWB device as `be004`.
Its field allowlist includes the verified `Lidar_distance` and `Bat` metrics.
The captured LDS-12-LWB sample also reports `TempC_DS18B20: 3276.7`, which
remains excluded as an unverified sentinel/invalid value. AQS-01-L now has a
separate allowlist for `co2`, `BatV`, `air_pressure`, `temperature`, and
`humidity`; its corrected decoder sample reports 25.13 for temperature.
Grafana retains decoded field names until units and metric naming are agreed.
Do not commit `.env`, device keys, or real uplink identifiers.

Useful Phase 2 checks:

```bash
docker compose ps
docker compose logs --tail=100 ingest-lorawan
docker compose exec timescaledb psql -U twin -d twin -c \
  "SELECT ts, device_id, metric, value FROM readings ORDER BY ts DESC LIMIT 20"
docker compose exec redis redis-cli GET latest:be004
```

Changing the device or metric mapping requires updating the local `.env` and
recreating the relevant service:

```bash
docker compose up -d --build --force-recreate ingest-lorawan normalizer
```

Phase 2 was verified with live uplinks stored once in TimescaleDB, Redis latest
state updated, and the Grafana datasource query returning real reading rows.
`Lidar_distance` has not been renamed to `distance_mm` because the unit is not
verified yet.

## Phase 3: Kafka buffering and replay

The active path is MQTT → `telemetry.raw` → normalizer →
`telemetry.normalized` (or `telemetry.dead-letter`) → processor →
TimescaleDB/Redis. Kafka uses three partitions per topic, persistent local
storage, and per-device keys for ordering. Raw and normalized records are
retained for seven days; dead letters are retained for 30 days. Kafka is
internal to the Compose network and is not published to a host port.

The local Phase 3 build has been compiled and started. Live uplinks were
observed in normalized-topic logs and persisted to TimescaleDB. The full
ten-minute processor outage test accumulated 91 normalized messages; after
restart, the consumer lag returned to zero and readings increased from 468 to
652. Both allowlisted metrics had 100 readings in the 11-minute verification
window, with a maximum observed interval of about 8.3 seconds. A deliberately
invalid raw envelope was observed in the dead-letter topic with a validation
reason. Phase 3's defined exit gate passed. This remains a single-broker,
single-host lab deployment, not a production HA system.

Useful Phase 3 checks:

```bash
docker compose ps --all
docker compose logs --tail=100 ingest-lorawan normalizer processor
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka:9092 --describe
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 --all-groups --describe
```

Kafka and all services in this Compose file are a single-host lab deployment,
not a production high-availability setup. See
[the project context](docs/PROJECT-CONTEXT.md) and
[the roadmap](docs/BUILD-ROADMAP.md) before extending it.
