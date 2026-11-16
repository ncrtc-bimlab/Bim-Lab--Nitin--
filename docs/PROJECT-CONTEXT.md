# Project context and work handoff

This file is the durable, AI-readable handoff for the IoT Digital Twin project.
Update it when a phase changes, including actual verification and outstanding
gates. The phase scope and acceptance criteria are in
[BUILD-ROADMAP.md](BUILD-ROADMAP.md); the project setup and operator commands
are in [README.md](../README.md).

## Project and workspace

- Active project: `/home/ncrtc/Desktop/Bim Lab (Nitin )`
- Deployment: Docker Compose on one Linux host; the folder is not a Git repo.
- Design: LoRaWAN/BLE IoT Digital Twin built in seven gated phases.
- Current phase: **Phase 5 — BLE ingestion enabled for three selected
  beacons; waiting for fresh advertisement readings**. Phase 3 is complete.
  Phase 4 remains in progress with additional LoRaWAN devices/models still to
  validate; the owner chose to begin Phase 5 before Phase 4's full exit gate.
- Production status: **not production-ready**. This is a single-host lab stack;
  security hardening, high availability, operations, backup/restore, API and
  role controls remain later-phase work.

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Foundation | Operational; operator check remains | ChirpStack, gateway and sensor were verified. Confirm the ChirpStack admin password is no longer its default. |
| 2. First pipeline | Complete | Direct MQTT ingestion, TimescaleDB, Redis, Grafana and live readings verified. Only `Lidar_distance` and `Bat` are allowlisted pending data-sheet validation. |
| 3. Kafka | Complete | Three-topic Kafka flow, live persistence, ten-minute outage replay and dead-letter validation verified. |
| 4. All LoRaWAN sensors | In progress | Six devices are registered and active uplinks are stored. TS-01-LS and the remaining listed LoRaWAN models still need validation; 22-LWB has a reported incorrect DevEUI. |
| 5. BLE devices | In progress | Three owner-selected beacons are registered and allowlisted. Ingestion is enabled and healthy; no new readings had arrived during the post-deploy verification window. |
| 6. Alerts | Not started | Need a real-data baseline, thresholds, channel and recipients. |
| 7. API, roles and hardening | Not started | Must complete the design document security/operations gates before production use. |

## Phase 4 requirements and current evidence

- The design inventory is LDS12-LWB, DDS45-LWB, DDS75-LS, LDS40-LWB,
  SCT-D-100/200/500, 22-LWB, TS-01-LS, AQS-01-L and Vibo 03-26-0274.
- The owner confirmed the LoRaWAN gateway is GW-002LW and will add the
  manufacturer decoders manually in ChirpStack.
- ChirpStack's IN865 configuration includes additional network channels at
  866.385 MHz, 866.785 MHz, 868.000 MHz and 868.915 MHz (DR0–DR5). The first
  two were added after uplinks at those frequencies were rejected as unknown
  channels; the 868 MHz channels were added at the owner's request. The
  gateway is using Semtech UDP, so `regions.gateway.channels` is
  Concentratord-only; custom network-server channels belong under
  `regions.network.extra_channels`. Confirm the gateway packet forwarder and
  sensor support the selected frequency, and verify local spectrum
  authorization before using these channels over the air.
- Runtime caveat: a ChirpStack log showed a device did not acknowledge the
  868.000 MHz NewChannelReq (`channel_freq_ok=false`). Adding a server-side
  channel does not make an unsupported sensor or gateway radio operate there;
  verify the radio's supported channel plan before expecting uplinks or
  downlinks at either 868 MHz channel.
- Runtime verification on ChirpStack 4.20.0: after restart, ChirpStack
  acknowledged NewChannelReq for both custom channels and accepted/published a
  fresh uplink on 866.785 MHz with `regionConfigId=in865`. No further
  `No channel found` error appeared in the post-restart logs. A separate
  `Unexpected f_type: UnconfirmedDataDown` log entry was observed; diagnose it
  independently if it recurs.
- Follow-up investigation: ChirpStack receives these frames on the gateway
  `event/up` path, parses their LoRaWAN MHDR, and correctly rejects downlink
  types there. This is not a sensor decoder, registry, or channel-plan error.
  Logs show valid sensor uplinks continue to be published; the gateway bridge
  also receives genuine server downlinks separately. On 2026-11-06, a
  JoinRequest for DevEUI `a84041513c6036e5` was accepted at 08:49:56.564Z;
  ChirpStack dispatched a downlink to gateway `e43819fffe2621d6` and received
  its ACK at 08:49:56.606Z. At 08:50:01.483Z that same gateway's `event/up`
  message parsed as `JoinAccept`, which ChirpStack rejected. Its timing matches
  the join-accept receive window and strongly links the error to the join
  downlink path, rather than a sensor decoder. It does not by itself prove
  whether the gateway overheard its own transmission or another transmitter
  sent the frame. Do not hide the error or disable downlinks. If this disrupts
  joins, inspect the gateway packet-forwarder/firmware RX reporting and check
  for duplicate forwarders or gateway IDs; correlate RX metadata and TX ACK
  before concluding whether a neighboring gateway is involved.
- The owner corrected the AQS-01-L decoder in ChirpStack and reports that
  readings are now correct. Its latest sample confirms `air_pressure`, `BatV`,
  `temperature`, `humidity`, and `co2`, alongside alarm flags. Sample values:
  pressure 993.2, battery 3.6, temperature 25.13, humidity 56.4 and CO2 448.
  The earlier temperature value 267.8 is superseded. The sanitized fixture is
  `samples/aqs01-up.json`; real device and gateway identifiers are not stored.
- AQS-01-L metric fields are allowlisted separately from LDS-12-LWB fields via
  `LORAWAN_ALLOWED_FIELDS_BY_MODEL_JSON`, so adding AQS metrics does not admit
  LDS-12-LWB's unverified `TempC_DS18B20` sentinel.
- AQS-01-L is registered in the active telemetry device registry as `au001`
  using the DevEUI supplied by the owner. Its model-specific allowlist is
  `co2`, `BatV`, `air_pressure`, `temperature`, and `humidity`. The local
  `.env` setting remains private; never include its contents in logs or docs.
- Four additional devices with recent ChirpStack uplinks are now registered in
  the telemetry database: `bf002` (LDS-40-LWB), `av007-bi003` (CS01-LWB),
  `bl002` (T-68-DL IP68 Temp Sensor), and `bg001` (LHT-65S-E3 Temp & humidity).
  Their per-model allowlists use only numeric fields observed in decoded
  ChirpStack uplinks; nonnumeric flags and labels are not stored in the
  readings table. The `22-LWB` entry is not registered because its ChirpStack
  name says the DevEUI is wrong and it has no observed uplink.
- A transient TimescaleDB startup failure previously left the normalizer
  process alive but not consuming Kafka. Startup failures now close resources
  and exit nonzero so Docker Compose's restart policy can recover it. After
  rebuilding, the normalizer became healthy, both normalizer and processor
  Kafka lag returned to zero, and 23 previously dead-lettered uplinks for the
  four newly registered devices were replayed. TimescaleDB now contains
  persisted numeric readings for all four; the newest reading was observed at
  2026-11-06 10:04:50 UTC during verification.
- The sanitized AQS sample was replayed through Kafka; the normalizer emitted
  all five expected metrics, the processor stored five TimescaleDB rows for
  `au001`, consumer lag returned to zero, and Redis latest state was updated.
- The earlier LDS-12-LWB uplink is for the model already registered and sampled;
  it does not validate an additional model.
- The user did not provide a physical reference measurement and asked to skip
  the "30 S" detail; do not treat it as a metric, unit or reporting interval.
- Relevant device/metric configuration must remain administrator-changeable;
  do not hard-code device-specific mappings. Admin management UI/API belongs
  to Phase 7; current decoder configuration is in ChirpStack.
- Vibo remains excluded because its protocol and payload were not found in
  public Presage search results; per the user's instruction, skip it for now.
- Phase 5 started at the owner's request before Phase 4's full exit gate. The
  GW-001BWP now publishes JSON batches on
  `ble/gateway/e438191fd3a2/advertisment`; its batch contains a gateway record
  and individual beacon records with `TimeStamp`, `Format`, `BLEMAC`, `RSSI`,
  optional `BLEName`, raw advertisement data, and format-specific decoded
  fields. Observed decoded formats include MOKO Sensor-PIR, MK Tag, and
  BeaconX Pro. Raw/unknown nearby devices were also present, so the owner chose
  to add owned devices later rather than enroll every detected MAC.
- BLE support is implemented but opt-in: the MQTT ingester does not subscribe
  to BLE until `BLE_ALLOWED_MACS_JSON` contains explicitly owned MAC addresses.
  It filters gateway batches to those MACs before publishing to Kafka. The
  normalizer requires a BLE registry row and
  `BLE_ALLOWED_FIELDS_BY_MODEL_JSON` allowlist, ignores raw/unrecognized
  advertisements, and emits only allowlisted finite numeric metrics. BLE
  records use the existing processor, TimescaleDB readings, and Redis state.
  The owner selected three devices: `ble-pir-001` (MAC
  `c3b337e8a487`, model `MK Sensor-PIR`), `ble-tag-001` (MAC
  `f044d381a46b`, format `MK Tag-Tag info`), and `ble-beaconx-001`
  (MAC `c703bd278150`, format `BeaconX Pro-Device info`). The local `.env`
  allowlists only these MACs and verified decoded numeric fields for those
  formats. The `22-LWB` and other unselected nearby beacons remain excluded.
- The pipeline was rebuilt and verified healthy with BLE subscription enabled;
  BLE parser/allowlist and LoRaWAN tests pass (14 total). The three registry
  entries are enabled. No BLE reading had yet appeared in TimescaleDB during
  verification; request a fresh advertisement/scan while the selected beacons
  are powered and near the gateway before claiming end-to-end persistence.

## Current Phase 3 architecture

`ChirpStack / allowlisted BLE MQTT → ingest-lorawan → Kafka telemetry.raw → normalizer →
telemetry.normalized or telemetry.dead-letter → processor → TimescaleDB and
Redis → Grafana`

- `ingest-lorawan` acknowledges the MQTT message only after the raw Kafka
  produce succeeds. It preserves the original MQTT payload as base64.
- Kafka runs as a single-node KRaft broker, internal to Compose, with a named
  persistent data volume. This is not a replicated or HA broker.
- `telemetry.raw` and `telemetry.normalized` have three partitions and seven
  days' retention; `telemetry.dead-letter` has three partitions and 30 days'
  retention. Per-device message keys preserve partition ordering.
- `normalizer` validates the raw envelope, parses ChirpStack uplinks, filters
  the configured metric allowlist, checks the enabled LoRaWAN device registry,
  then produces normalized telemetry. Invalid or unknown-device messages go
  to the dead-letter topic with a reason.
- `processor` validates normalized records, stores allowlisted metrics in
  TimescaleDB, and updates Redis latest/seen state. Failed processing throws
  rather than advancing the message offset.
- Compose uses the same telemetry image for MQTT ingester, normalizer and
  processor, each with a separate command.

## Important files

- `docker-compose.yml`: active service definitions, Kafka topics/init and
  healthchecks.
- `services/ingest-lorawan/src/ingest-kafka.ts`: MQTT-to-Kafka producer.
- `services/ingest-lorawan/src/normalizer-main.ts`: raw validation,
  normalization, device lookup and dead-letter production.
- `services/ingest-lorawan/src/processor-main.ts`: normalized consumer.
- `services/ingest-lorawan/src/processor.ts`: device registration and
  idempotent TimescaleDB / Redis persistence shared with the Phase 2 path.
- `services/ingest-lorawan/src/uplink.ts`: uplink parsing and metric filtering.
- `services/ingest-lorawan/src/main.ts`: original Phase 2 direct-MQTT path;
  Compose now runs `ingest-kafka.js` instead.
- `infra/timescaledb/init/001-schema.sql`: devices/readings/events schema.
- `infra/grafana/`: provisioned datasource and telemetry dashboard.
- `samples/lds12-up.json`: sanitized uplink fixture.
- `samples/aqs01-up.json`: sanitized AQS-01-L uplink fixture with corrected
  decoder values.
- `services/ingest-lorawan/src/uplink.ts`: shared uplink parser, per-model
  field allowlist parsing and filtering.
- `.env.example`: configuration template. The local `.env` is private,
  ignored, mode 0600; never print, share or commit it.

## Verification completed in this phase

- `npm install` in `services/ingest-lorawan` updated the lockfile for KafkaJS.
- `npm run build`: passed.
- `npm test`: passed, 8 tests.
- `npm audit`: zero vulnerabilities reported.
- `docker compose config --quiet`: passed.
- `docker compose up -d --build --wait`: completed; Kafka, ingester,
  normalizer, processor and existing telemetry services reported healthy.
- Kafka topics were confirmed with three partitions each; raw and normalized
  retention was 7 days and dead-letter retention was 30 days.
- Live LoRaWAN messages were logged by the normalizer and written to
  TimescaleDB. Kafka consumer lag was zero before the outage test.
- With the processor stopped for 20 seconds, three normalized messages
  accumulated. After restart, lag returned to zero and readings increased from
  420 to 434.
- The full outage test ran from 2026-11-05 16:15:58 to 16:25:59 (+05:30), a
  ten-minute-one-second processor outage. The normalized topic had 91 queued
  messages when the processor was restarted. Consumer lag drained to zero;
  readings increased from 468 to 652. Over the 11-minute verification window,
  both allowlisted metrics had 100 readings and the maximum inter-reading
  interval was 8.329 seconds, so no history gap was observed.
- A deliberately invalid raw envelope was observed in the dead-letter topic
  with an explicit validation reason. One test record remains in that topic.
- `.env` permissions were checked as `0600`; no secrets belong in this file.

The compose stack is expected to show `kafka-init` as `exited (0)` after topic
creation; this is a successful one-shot task, not a failed service. Some old,
unused containers may also appear as exited in `docker compose ps --all`;
distinguish them from the active Compose services.

## Next steps

1. Owner adds the manufacturer decoder in ChirpStack for each remaining
   LoRaWAN sensor model, then shares a sanitized decoded MQTT uplink and a
   physical reference reading for that model. AQS-01-L's uplink is available;
   verify its temperature interpretation and reference values before enabling
   any AQS metrics.
2. The design inventory is LDS12-LWB, DDS45-LWB, DDS75-LS, LDS40-LWB,
   SCT-D-100/200/500, 22-LWB, TS-01-LS, AQS-01-L and Vibo 03-26-0274.
3. Implement and test administrator-changeable metric mappings only from
   observed decoded fields; compare readings with physical reference
   measurements before enabling their metrics.
4. Vibo's protocol and payload were not found in the available public Presage
   search results; per the user's instruction, skip Vibo for now and leave it
   unsupported.
5. Keep unsupported devices and fields blocked until their payload
   specifications and readings are verified. Follow the Phase 4 scope and exit
   gate in `BUILD-ROADMAP.md`.

The user mentioned `ANGW-002LW` as a Dragino LoRaWAN gateway. The design
document calls the existing LoRaWAN gateway `GW-002LW`; gateway onboarding is
not a Phase 4 sensor-decoder task, so confirm the exact hardware label if this
is a different/new gateway.

## Useful commands

Run these from the project directory:

```bash
docker compose ps --all
docker compose logs --tail=100 ingest-lorawan normalizer processor
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server kafka:9092 --describe
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 --all-groups --describe
docker compose exec timescaledb psql -U twin -d twin -c \
  "SELECT ts, device_id, metric, value FROM readings ORDER BY ts DESC LIMIT 20"
docker compose exec redis redis-cli GET latest:be004
```

To run code validation:

```bash
cd services/ingest-lorawan
npm run build
npm test
npm audit
cd ../..
docker compose config --quiet
```

## Data-quality and operational decisions

- The LDS-12-LWB fields `Lidar_distance` and `Bat` are currently the only
  allowed fields. Do not infer units or expose other decoded values until the
  manufacturer documentation and physical measurements confirm them.
- `TempC_DS18B20` in the captured decoder output was `3276.7`, treated as an
  unverified sentinel/invalid value and excluded.
- Existing TimescaleDB and Kafka named volumes contain state. Do not run
  `docker compose down -v`, delete volumes, or reset databases as a routine
  troubleshooting step.
- The raw Kafka retention window is finite (seven days); it is not a backup.
  Phase 7 still needs documented backup/restore and retention policies.
- Mosquitto remains anonymous in this lab configuration; Compose still has
  fallback credentials. Bindings, authentication, TLS, secret handling,
  auditing, monitoring and restore testing are not complete.
- ChirpStack's database is the separate `postgres` service. Telemetry queries
  use the `timescaledb` service. Do not confuse their databases or reset one
  while diagnosing the other.
