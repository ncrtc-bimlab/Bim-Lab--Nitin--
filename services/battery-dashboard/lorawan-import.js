import ExcelJS from "exceljs";

const MAX_DEVICES_PER_IMPORT = 500;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const EUI_PATTERN = /^[0-9a-f]{16}$/i;
const KEY_PATTERN = /^[0-9a-f]{32}$/i;

function normalizedHeader(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellText(cell, allowNumbers = false) {
  const value = cell.value;
  if (typeof value === "string") return value.trim();
  if (allowNumbers && typeof value === "number") return String(value);
  return "";
}

function getColumnIndexes(sheet) {
  const columns = new Map();
  sheet.getRow(1).eachCell((cell, column) => {
    const header = normalizedHeader(cell.value);
    if (header) columns.set(header, column);
  });
  const aliases = {
    name: ["name", "devicename", "assetidname", "assetid", "assetname", "asssetidname"],
    devEui: ["deveui", "deviceeui"],
    description: ["description"],
    joinEui: ["joineui", "appeui"],
    appKey: ["appkey"],
    nwkKey: ["nwkkey"],
  };
  const indexes = {};
  for (const [field, names] of Object.entries(aliases)) {
    indexes[field] = names.map((name) => columns.get(name)).find((index) => index !== undefined);
  }
  const missing = ["name", "devEui", "appKey"].filter((field) => indexes[field] === undefined);
  if (missing.length) {
    throw new Error(`Spreadsheet is missing required columns: ${missing.join(", ")}.`);
  }
  return indexes;
}

export async function parseDeviceWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Choose a non-empty .xlsx file.");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("The spreadsheet must be 5 MB or smaller.");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw new Error("Could not read the spreadsheet. Upload a valid .xlsx file.", { cause: error });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The spreadsheet does not contain a worksheet.");
  const indexes = getColumnIndexes(sheet);
  const rows = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = {};
    for (const [field, column] of Object.entries(indexes)) {
      if (column !== undefined) {
        values[field] = cellText(row.getCell(column), field === "name" || field === "description");
      }
    }
    if (Object.values(values).every((value) => !value)) continue;

    const device = {
      rowNumber,
      name: values.name ?? "",
      devEui: values.devEui ?? "",
      description: values.description ?? "",
      joinEui: values.joinEui ?? "",
      appKey: values.appKey ?? "",
      nwkKey: values.nwkKey ?? "",
      errors: [],
    };
    if (!device.name) device.errors.push("Name is required.");
    if (device.name.length > 100) device.errors.push("Name must be 100 characters or fewer.");
    if (!EUI_PATTERN.test(device.devEui)) {
      device.errors.push("DevEUI must be 16 hexadecimal characters stored as text.");
    }
    if (device.joinEui && !EUI_PATTERN.test(device.joinEui)) {
      device.errors.push("JoinEUI must be 16 hexadecimal characters stored as text.");
    }
    if (!KEY_PATTERN.test(device.appKey)) {
      device.errors.push("AppKey must be 32 hexadecimal characters stored as text.");
    }
    if (device.nwkKey && !KEY_PATTERN.test(device.nwkKey)) {
      device.errors.push("NwkKey must be 32 hexadecimal characters stored as text.");
    }
    if (device.description.length > 2000) {
      device.errors.push("Description must be 2,000 characters or fewer.");
    }
    rows.push(device);
  }

  if (rows.length === 0) throw new Error("The worksheet does not contain any sensor rows.");
  if (rows.length > MAX_DEVICES_PER_IMPORT) {
    throw new Error(`A spreadsheet can contain at most ${MAX_DEVICES_PER_IMPORT} sensors.`);
  }

  const deviceIndexesByEui = new Map();
  rows.forEach((device, index) => {
    const eui = device.devEui.toLowerCase();
    if (!EUI_PATTERN.test(eui)) return;
    const earlierIndex = deviceIndexesByEui.get(eui);
    if (earlierIndex === undefined) {
      deviceIndexesByEui.set(eui, index);
      return;
    }
    device.errors.push("DevEUI is duplicated in this spreadsheet.");
    rows[earlierIndex].errors.push("DevEUI is duplicated in this spreadsheet.");
  });

  return {
    rows,
    validCount: rows.filter((device) => device.errors.length === 0).length,
    invalidCount: rows.filter((device) => device.errors.length > 0).length,
  };
}

async function chirpStackRequest(path, { baseUrl, token, fetchImpl }) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let result = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch (error) {
      if (response.ok) throw new Error("ChirpStack returned an invalid response.", { cause: error });
      result = {};
    }
  }
  if (!response.ok) {
    const message = [result.message, result.error].find(
      (value) => typeof value === "string" && value.trim(),
    );
    throw new Error(
      message
      ?? (response.status === 401
        ? "ChirpStack rejected the API token. Create a new API key and update CHIRPSTACK_API_TOKEN."
        : `ChirpStack request failed (${response.status}).`),
    );
  }
  return result;
}

async function listResources(resource, options) {
  const query = new URLSearchParams({
    limit: "1000",
    offset: "0",
    tenantId: options.tenantId,
  });
  const result = await chirpStackRequest(`/api/${resource}?${query}`, options);
  if (!Array.isArray(result.result)) {
    throw new Error(`ChirpStack returned an invalid ${resource} list.`);
  }
  return result.result;
}

export async function getChirpStackResources(options) {
  if (!options.token) throw new Error("Set CHIRPSTACK_API_TOKEN to load device profiles and applications.");
  const [deviceProfiles, applications] = await Promise.all([
    listResources("device-profiles", options),
    listResources("applications", options),
  ]);
  return { deviceProfiles, applications };
}

export function applyProfileRequirements(parsed, profile) {
  const isLoRaWan11 = /1[._]1/.test(String(profile.macVersion ?? ""));
  if (isLoRaWan11) {
    for (const device of parsed.rows) {
      if (!device.nwkKey && !device.errors.includes("NwkKey is required for this LoRaWAN 1.1 device profile.")) {
        device.errors.push("NwkKey is required for this LoRaWAN 1.1 device profile.");
      }
    }
  }
  parsed.validCount = parsed.rows.filter((device) => device.errors.length === 0).length;
  parsed.invalidCount = parsed.rows.filter((device) => device.errors.length > 0).length;
}

export async function createImportedDevices(parsed, selection, options) {
  if (!options.token) throw new Error("Set CHIRPSTACK_API_TOKEN before importing sensors.");
  const { deviceProfiles, applications } = await getChirpStackResources(options);
  const profile = deviceProfiles.find((item) => item.id === selection.deviceProfileId);
  if (!profile) {
    throw new Error("The selected device profile is no longer available.");
  }
  if (!applications.some((application) => application.id === selection.applicationId)) {
    throw new Error("The selected application is no longer available.");
  }
  applyProfileRequirements(parsed, profile);

  const results = [];
  for (const device of parsed.rows) {
    if (device.errors.length) {
      results.push({ rowNumber: device.rowNumber, devEui: device.devEui, status: "skipped", error: device.errors.join(" ") });
      continue;
    }
    let deviceCreated = false;
    try {
      const createResponse = await options.fetchImpl(new URL("/api/devices", options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device: {
            devEui: device.devEui.toLowerCase(),
            ...(device.joinEui ? { joinEui: device.joinEui.toLowerCase() } : {}),
            name: device.name,
            description: device.description,
            applicationId: selection.applicationId,
            deviceProfileId: selection.deviceProfileId,
            skipFcntCheck: false,
          },
        }),
      });
      await assertChirpStackSuccess(createResponse);
      deviceCreated = true;

      if (device.appKey) {
        const keyResponse = await options.fetchImpl(
          new URL(`/api/devices/${encodeURIComponent(device.devEui.toLowerCase())}/keys`, options.baseUrl),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              deviceKeys: {
                devEui: device.devEui.toLowerCase(),
                nwkKey: (device.nwkKey || device.appKey).toLowerCase(),
                appKey: device.appKey.toLowerCase(),
              },
            }),
          },
        );
        await assertChirpStackSuccess(keyResponse);
      }
      results.push({ rowNumber: device.rowNumber, devEui: device.devEui, status: "created" });
    } catch (error) {
      let detail = error instanceof Error ? error.message : "ChirpStack request failed.";
      if (deviceCreated) {
        try {
          const deleteResponse = await options.fetchImpl(
            new URL(`/api/devices/${encodeURIComponent(device.devEui.toLowerCase())}`, options.baseUrl),
            {
              method: "DELETE",
              headers: { authorization: `Bearer ${options.token}` },
            },
          );
          await assertChirpStackSuccess(deleteResponse);
        } catch (cleanupError) {
          const cleanupDetail = cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error.";
          detail = `Device was created, but key setup failed and cleanup also failed: ${detail} ${cleanupDetail}`;
        }
      }
      results.push({
        rowNumber: device.rowNumber,
        devEui: device.devEui,
        status: "failed",
        error: detail,
      });
    }
  }

  return {
    createdCount: results.filter((result) => result.status === "created").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    results,
  };
}

async function assertChirpStackSuccess(response) {
  if (response.ok) return;
  const text = await response.text();
  let result = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = {};
  }
  throw new Error(result.message ?? result.error ?? `ChirpStack request failed (${response.status}).`);
}
