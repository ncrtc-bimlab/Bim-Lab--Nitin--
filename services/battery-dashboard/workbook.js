import ExcelJS from "exceljs";

export async function createBatteryWorkbook(sensors) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "IoT Digital Twin";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Sensor batteries");
  sheet.columns = [
    { header: "Assigned Asset Id", key: "sensorName", width: 25 },
    { header: "Protocol", key: "protocol", width: 14 },
    { header: "Model", key: "model", width: 24 },
    { header: "Description", key: "description", width: 42 },
    { header: "Battery (%)", key: "batteryPercent", width: 15 },
    { header: "Last saved battery metric", key: "batteryMetric", width: 26 },
    { header: "Last saved battery value", key: "batteryValue", width: 22 },
    { header: "Battery reading time", key: "batteryTs", width: 25 },
    { header: "Last sensor response", key: "lastSeen", width: 25 },
    { header: "Status", key: "status", width: 28 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const sensor of sensors) {
    sheet.addRow({
      ...sensor,
      batteryTs: sensor.batteryTs ? new Date(sensor.batteryTs) : null,
      lastSeen: sensor.lastSeen ? new Date(sensor.lastSeen) : null,
    });
  }
  sheet.autoFilter = `A1:J${Math.max(1, sheet.rowCount)}`;
  sheet.getColumn(5).numFmt = '0.0"%"';
  sheet.getColumn(8).numFmt = "yyyy-mm-dd hh:mm:ss";
  sheet.getColumn(9).numFmt = "yyyy-mm-dd hh:mm:ss";
  return workbook.xlsx.writeBuffer();
}

export async function createDeviceImportTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "IoT Digital Twin";
  const sheet = workbook.addWorksheet("LoRaWAN sensors");
  sheet.columns = [
    { header: "DevEUI", key: "devEui", width: 22, style: { numFmt: "@" } },
    { header: "JoinEUI", key: "joinEui", width: 22, style: { numFmt: "@" } },
    { header: "App Key", key: "appKey", width: 38, style: { numFmt: "@" } },
    { header: "Asset ID/Name", key: "name", width: 26 },
    { header: "Description", key: "description", width: 40 },
    { header: "NwkKey", key: "nwkKey", width: 38, style: { numFmt: "@" } },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return workbook.xlsx.writeBuffer();
}
