import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  applyProfileRequirements,
  createImportedDevices,
  getChirpStackResources,
  parseDeviceWorkbook,
} from "../lorawan-import.js";
import { createDeviceImportTemplate } from "../workbook.js";

const headings = ["DevEUI", "JoinEUI", "App Key", "Asset ID/Name", "Description", "NwkKey"];

async function workbookBuffer(rows, columns = headings) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sensors");
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("parses the LoRaWAN import columns and preserves key text", async () => {
  const parsed = await parseDeviceWorkbook(await workbookBuffer([
    ["0011223344556677", "8899AABBCCDDEEFF", "0123456789ABCDEF0123456789ABCDEF", "Sensor A", "North room", ""],
  ]));

  assert.equal(parsed.validCount, 1);
  assert.equal(parsed.rows[0].name, "Sensor A");
  assert.equal(parsed.rows[0].devEui, "0011223344556677");
  assert.equal(parsed.rows[0].joinEui, "8899AABBCCDDEEFF");
  assert.equal(parsed.rows[0].appKey, "0123456789ABCDEF0123456789ABCDEF");
  assert.equal(parsed.rows[0].description, "North room");
  assert.equal(parsed.rows[0].errors.length, 0);
});

test("rejects malformed, numeric, and duplicate identifiers", async () => {
  const parsed = await parseDeviceWorkbook(await workbookBuffer([
    [11223344556677, "", "0123456789ABCDEF0123456789ABCDEF", "Sensor A", "", ""],
    ["0011223344556677", "", "0123456789ABCDEF0123456789ABCDEF", "Sensor B", "", ""],
    ["0011223344556677", "", "0123456789ABCDEF0123456789ABCDEF", "Sensor C", "", ""],
  ]));

  assert.equal(parsed.validCount, 0);
  assert.equal(parsed.invalidCount, 3);
  assert.match(parsed.rows[0].errors.join(" "), /DevEUI must be/);
  assert.match(parsed.rows[1].errors.join(" "), /duplicated/);
  assert.match(parsed.rows[2].errors.join(" "), /duplicated/);
});

test("requires a separate network key for LoRaWAN 1.1 profiles", async () => {
  const parsed = await parseDeviceWorkbook(await workbookBuffer([
    ["0011223344556677", "", "0123456789ABCDEF0123456789ABCDEF", "Sensor A", "", ""],
  ]));

  applyProfileRequirements(parsed, { macVersion: "LORAWAN_1_1_0" });
  assert.equal(parsed.validCount, 0);
  assert.match(parsed.rows[0].errors.join(" "), /NwkKey is required/);

  parsed.rows[0].nwkKey = "FEDCBA9876543210FEDCBA9876543210";
  parsed.rows[0].errors = [];
  applyProfileRequirements(parsed, { macVersion: "LORAWAN_1_1_0" });
  assert.equal(parsed.validCount, 1);
});

test("creates a device and sets its LoRaWAN keys using the selected ChirpStack app and profile", async () => {
  const parsed = await parseDeviceWorkbook(await workbookBuffer([
    ["0011223344556677", "", "0123456789ABCDEF0123456789ABCDEF", "Sensor A", "North room", ""],
  ]));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST") return new Response(null, { status: 200 });
    if (options.method === "POST" && String(url).endsWith("/keys")) return new Response(null, { status: 200 });
    if (String(url).includes("device-profiles")) {
      return Response.json({ result: [{ id: "profile-1", name: "Sensor profile", macVersion: "LORAWAN_1_0_3" }] });
    }
    return Response.json({ result: [{ id: "application-1", name: "Sensors" }] });
  };

  const result = await createImportedDevices(
    parsed,
    { deviceProfileId: "profile-1", applicationId: "application-1" },
    { baseUrl: "http://chirpstack.local", token: "test-token", tenantId: "tenant-1", fetchImpl },
  );

  assert.deepEqual(
    { createdCount: result.createdCount, failedCount: result.failedCount, skippedCount: result.skippedCount },
    { createdCount: 1, failedCount: 0, skippedCount: 0 },
  );
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[2].options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[2].options.body).device, {
    devEui: "0011223344556677",
    name: "Sensor A",
    description: "North room",
    applicationId: "application-1",
    deviceProfileId: "profile-1",
    skipFcntCheck: false,
  });
  assert.equal(calls[3].options.method, "POST");
  assert.equal(new URL(calls[0].url).searchParams.get("tenantId"), "tenant-1");
  assert.equal(new URL(calls[1].url).searchParams.get("tenantId"), "tenant-1");
  assert.deepEqual(JSON.parse(calls[3].options.body).deviceKeys, {
    devEui: "0011223344556677",
    nwkKey: "0123456789abcdef0123456789abcdef",
    appKey: "0123456789abcdef0123456789abcdef",
  });
});

test("removes a newly created device if setting its keys fails", async () => {
  const parsed = await parseDeviceWorkbook(await workbookBuffer([
    ["0011223344556677", "", "0123456789ABCDEF0123456789ABCDEF", "Sensor A", "", ""],
  ]));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST" && String(url).endsWith("/keys")) return Response.json({ message: "key write failed" }, { status: 500 });
    if (options.method === "POST") return new Response(null, { status: 200 });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).includes("device-profiles")) {
      return Response.json({ result: [{ id: "profile-1", name: "Sensor profile" }] });
    }
    return Response.json({ result: [{ id: "application-1", name: "Sensors" }] });
  };

  const result = await createImportedDevices(
    parsed,
    { deviceProfileId: "profile-1", applicationId: "application-1" },
    { baseUrl: "http://chirpstack.local", token: "test-token", tenantId: "tenant-1", fetchImpl },
  );

  assert.equal(result.failedCount, 1);
  assert.match(result.results[0].error, /key write failed/);
  assert.equal(calls[4].options.method, "DELETE");
});

test("provides a blank template with the requested columns", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createDeviceImportTemplate());
  const sheet = workbook.getWorksheet("LoRaWAN sensors");

  assert.deepEqual(
    sheet.getRow(1).values.slice(1, 7),
    ["DevEUI", "JoinEUI", "App Key", "Asset ID/Name", "Description", "NwkKey"],
  );
  assert.equal(sheet.rowCount, 1);
});

test("reports a useful message when ChirpStack rejects the API token", async () => {
  await assert.rejects(
    getChirpStackResources({
      baseUrl: "http://chirpstack.local",
      token: "rejected-token",
      tenantId: "tenant-1",
      fetchImpl: async () => Response.json({ code: 16, message: "" }, { status: 401 }),
    }),
    /ChirpStack rejected the API token/,
  );
});
