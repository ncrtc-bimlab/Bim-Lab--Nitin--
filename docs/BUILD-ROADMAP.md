# IoT Digital Twin build roadmap

This roadmap turns the design document's seven phases into session-sized work.
Complete and verify one phase before starting the next. The estimates below are
the design document's original estimates, not delivery commitments.

## Current status

**Phase 1 — Foundation: operational; one operator check remains.** The starter
contains a Compose stack, IN865 ChirpStack configuration, and the initial
TimescaleDB schema. Compose syntax passes; Mosquitto, PostgreSQL, Redis, and
TimescaleDB report healthy;
the TimescaleDB `devices`, `readings`, and `events` tables and `readings` and
`events` hypertables are present; ChirpStack and its REST API respond; and the
fresh ChirpStack database has applied its migrations. The old ChirpStack
database was backed up before its dedicated volume was reinitialized. The
gateway is registered and real decoded LDS-12-LWB uplinks arrive on MQTT. The
remaining Phase 1 check is confirming that the ChirpStack admin password was
changed from its default.

**Phase 2 — First pipeline: complete.**
The MQTT ingester, TimescaleDB persistence, Redis latest/seen state, and
provisioned Grafana dashboard are implemented and running. A sanitized real
uplink sample is saved at `samples/lds12-up.json`. Live readings from the
observed device are persisted under `be004`, Redis latest/seen state updates,
and Grafana's TimescaleDB query returns reading rows. A duplicate insert was
ignored by the database's unique key. LDS-12-LWB allows `Lidar_distance` and
`Bat`; other fields remain excluded until verified. Unit tests pass and
`npm audit` reports no vulnerabilities.

The current setup is a lab foundation, not production-ready. In particular,
Mosquitto allows anonymous access, Compose contains fallback credentials, and
the design targets one server. Phase 7 must close the security and operations
gaps before real production use. This roadmap does not claim high availability.

**Phase 3 — Add Kafka: complete.** Kafka topics, the MQTT-to-Kafka
ingester, normalizer, dead-letter path, and database/Redis processor are
implemented and running. Live uplinks reached TimescaleDB. A 20-second
processor outage accumulated three normalized messages; after restart, the
consumer caught up with zero lag and readings increased. An invalid test
envelope appeared in the dead-letter topic with a validation reason. The
required ten-minute outage test also passed: 91 normalized messages were
queued, then processed after restart; lag returned to zero, readings rose from
468 to 652, and the 11-minute query found 100 rows per metric with a maximum
interval of about 8.3 seconds. See
[the project context](PROJECT-CONTEXT.md) for architecture, commands, and the
current handoff.

**Phase 4 — All LoRaWAN sensors: in progress.** The active registry and
sanitized fixtures now cover LDS-12-LWB and AQS-01-L. The owner supplied a
corrected AQS-01-L uplink with CO2 448, temperature 25.13, humidity 56.4,
pressure 993.2 and battery 3.6; this replaces the earlier implausible
temperature sample. Their fields are configured separately so the AQS allowlist
does not broaden the LDS-12-LWB allowlist. Other design-listed models remain
unsupported until their decoded uplinks and physical reference measurements are
available. Vibo's protocol and payload could not be confirmed from available
public Presage search results, so it remains skipped.

The owner confirmed the existing LoRaWAN gateway is GW-002LW and will add
manufacturer decoders in ChirpStack. A newly supplied uplink is also
LDS-12-LWB, so it confirms the existing model but does not yet add another
sensor model. The owner wants relevant settings to remain changeable by an
administrator; do not hard-code device-specific field mappings. The user asked
to skip the earlier "30 S" detail; it is not used as a metric or interval.

The owner corrected the AQS-01-L ChirpStack decoder and confirmed its readings
are now correct. The corrected sample reports pressure 993.2, battery voltage
3.6, temperature 25.13, humidity 56.4 and CO2 448. The older temperature value
(267.8) is superseded. The sanitized sample was replayed through Kafka and all
five metrics were stored in TimescaleDB and latest state in Redis. Other
LoRaWAN models remain to be onboarded.

Four more active ChirpStack devices were found and registered in the telemetry
database: LDS-40-LWB (`bf002`), CS01-LWB (`av007-bi003`), T-68-DL IP68 Temp
Sensor (`bl002`), and LHT-65S-E3 Temp & humidity (`bg001`). Their
model-specific allowlists include the numeric decoded fields observed in
ChirpStack. The `22-LWB` entry is excluded for now because its device name
indicates an incorrect DevEUI and it has not sent an uplink. A transient
TimescaleDB startup failure left the normalizer inactive; its startup failure
handling was fixed to exit cleanly for Compose restart recovery. After rebuild,
the normalizer was healthy and both normalizer and processor lag reached zero.
Twenty-three previously dead-lettered uplinks for the four new devices were
replayed, and TimescaleDB readings were verified for each. The newest reading
seen during verification was at 2026-11-06 10:04:50 UTC.

**Phase 5 — BLE devices: ingestion enabled; first readings pending.** The
GW-001BWP is connected and publishes JSON batches on
`ble/gateway/e438191fd3a2/advertisment`. The payload contains a gateway record
and beacon records, including decoded MOKO sensor formats. Allowlisted BLE
ingestion, normalization, registry lookup, storage and tests are implemented.
The owner selected and registered `ble-pir-001` (`c3b337e8a487`,
`MK Sensor-PIR`), `ble-tag-001` (`f044d381a46b`, `MK Tag-Tag info`), and
`ble-beaconx-001` (`c703bd278150`, `BeaconX Pro-Device info`). Only those
MACs and their observed decoded numeric fields are allowlisted. Build and 14
focused tests pass; the services are healthy and BLE subscription is enabled.
No new readings arrived during immediate post-deploy verification, so trigger
a fresh scan with the selected beacons powered and nearby to validate
end-to-end storage. This phase started before Phase 4's full exit gate at the
owner's request.

The IN865 region configuration includes custom channels 866.385 and 866.785
MHz (DR0–DR5). On ChirpStack 4.20.0, both NewChannelReq commands were
acknowledged and a fresh 866.785 MHz uplink was accepted and published after
restart. At the owner's request, 868.000 MHz (DR0–DR5) was also added as a
network channel, followed by 868.915 MHz (DR0–DR5). Confirm the device and
gateway support each selected frequency and verify local spectrum authorization
before using them over the air. Runtime logs showed a device rejected the
868.000 MHz NewChannelReq (`channel_freq_ok=false`), so server configuration
alone does not confirm that the sensor or gateway can use it. One separate
"Unexpected f_type: UnconfirmedDataDown" log entry was seen and should be
investigated independently if it recurs. On 2026-11-06, a JoinRequest for
DevEUI `a84041513c6036e5` was followed by a ChirpStack downlink sent to gateway
`e43819fffe2621d6`; about five seconds later, that gateway's `event/up` frame
was parsed as `JoinAccept` and rejected. The timing matches the join-accept
receive window and ties this error to the join downlink path, not to decoder
fields. The exact RF transmitter is unconfirmed; if joins fail, inspect gateway
packet-forwarder/firmware RX reporting and duplicate forwarders or gateway IDs.

## Phases and exit gates

### 1. Foundation — days 1–5

**Scope:** Validate Docker Compose, Mosquitto, ChirpStack, TimescaleDB and Redis;
confirm GW-002LW's supported forwarder protocol and configure IN865; register
one LDS12-LWB device with its manufacturer decoder.

**Exit gate:** All expected containers are healthy; the ChirpStack default
password is changed; the gateway is recently seen; the LDS12 joins; its decoded
uplink appears in ChirpStack and on MQTT; save a real uplink sample for Phase 2.

**External inputs:** Gateway model/protocol and settings access, sensor DevEUI
and AppKey, and the manufacturer's payload decoder. Never commit device keys or
other secrets.

### 2. First pipeline — days 6–12 — complete

**Scope:** Add the TypeScript LoRaWAN MQTT ingester and processor, persist device
readings in TimescaleDB, maintain latest/last-seen state in Redis, seed the
device registry, and add a Grafana distance chart.

**Exit gate:** A real LDS12 uplink is stored once, updates Redis, and appears on
a live-updating Grafana chart; verify duplicate delivery is harmless.

**Evidence:** Real MQTT uplinks were stored in `readings`; Redis `latest:be004`
and `seen:be004` were checked; the Grafana datasource query returned real rows;
and a duplicate insert returned `INSERT 0 0`.

### 3. Add Kafka — days 13–18 — complete

**Scope:** Add Kafka, raw and normalized topics, a normalizer, validation,
dead-letter handling, and replay-capable service consumers.

**Exit gate:** Stop the processor for ten minutes, restart it, and verify that
all messages retained by Kafka are processed without a history gap. Verify
invalid messages reach the dead-letter topic with a reason.

**Evidence:** The required ten-minute processor outage accumulated 91
normalized messages. Restart drained consumer lag to zero; readings increased
from 468 to 652. Over the 11-minute verification window, both metrics had 100
readings and the maximum observed interval was about 8.3 seconds, indicating no
history gap. An invalid raw envelope also reached `telemetry.dead-letter` with
an explicit validation reason.

### 4. All LoRaWAN sensors — days 19–25 — in progress (inputs required)

**Scope:** Add manufacturer codecs, captured fixtures, tested mappers, registry
entries and group dashboards for the remaining LoRaWAN sensor models. Confirm
whether the Vibo device is LoRaWAN and obtain its payload specification.

**Exit gate:** Each supported sensor's decoded metric agrees with a physical
reference measurement; unsupported or unconfirmed payloads remain explicitly
blocked rather than guessed.

**Current evidence/blocker:** The design lists LDS12-LWB, DDS45-LWB, DDS75-LS,
LDS40-LWB, SCT-D-100/200/500, 22-LWB, TS-01-LS, AQS-01-L and Vibo 03-26-0274.
The registry and repository sample currently cover only LDS-12-LWB. The owner
will add manufacturer decoders through ChirpStack. Provide a sanitized decoded
uplink and a physical reference reading for each additional model before
implementing or enabling its metric mapping. Vibo remains excluded until its
protocol and payload are confirmed.

### 5. BLE devices — days 26–32

**Scope:** Confirm GW-001BWP's message format, topic and filtering behavior;
capture sample advertisements; add BLE ingestion, device lookup, model decoders,
deduplication, and presence/event dashboards.

**Exit gate:** A real button press and PIR motion event appear on the dashboard
within seconds, and repeated advertisements do not create noisy duplicate
events.

### 6. Alerts — days 33–38

**Scope:** Add editable alert rules and alert history, Redis lifecycle/cooldown
state, offline detection, alert evaluation, and one agreed notification
channel. Use a one-week real-data baseline before choosing thresholds.

**Exit gate:** Threshold, offline, rate-of-change, event, and low-battery rules
each raise once and resolve once under a repeatable test. Confirm recipients and
notification channel with the lab team before sending real notifications.

### 7. API, roles and hardening — days 39–45

**Scope:** Add authenticated REST/WebSocket access, role and device-scope
enforcement, device/rule management, TLS, restricted network exposure, secret
management, audit logging, backups, restore procedures, load/recovery tests,
and deployment documentation.

**Exit gate:** Every acceptance item in section 17.3 of the design document
passes, all security checklist items in section 13.1 pass, and a database
backup has been restored successfully. Production sign-off must also document
the accepted single-server failure risk or separately fund/design redundancy.

## Session workflow

1. At the start of a work session, check this status, the phase exit gate, and
   any external inputs still outstanding.
2. Work only on the current phase and its blockers. Keep each change focused and
   validate it with the narrowest applicable test.
3. Record what changed, the commands/tests and their results, remaining blockers,
   and any design decisions in the project documentation or build log.
4. Mark a phase complete only when its exit gate has evidence. Do not start the
   next phase before then.
5. Commit and tag phase completion once this folder is under Git; it currently
   has no Git repository, so version history and phase tags are not yet
   available.

## Open decisions and dependencies

- **Phase 1:** Confirm GW-002LW forwarder protocol (Semtech UDP or Basic
  Station) and the device's actual region/configuration requirements.
- **Phase 2:** Provide a real decoded LDS12 uplink sample and confirm its metric
  fields and units.
- **Phase 4 (in progress):** After adding each decoder in ChirpStack, provide a
  sanitized decoded uplink and physical reference reading for each remaining
  model. Keep Vibo excluded until its protocol and payload are documented.
- **Phase 5 (in progress):** Provide GW-001BWP configuration details and
  captured BLE samples before implementing its parser.
- **Phase 6:** Agree alert thresholds after baseline measurements, notification
  channel, and recipients.
- **Phase 7:** Agree role-to-device/group assignments and deployment/backup
  ownership.
