import { describe, expect, it } from "vitest";
import { createDeviceId, planDeviceRegistrations } from "../src/chirpstack-sync.js";

describe("ChirpStack device registration planning", () => {
  it("uses a safe lowercase asset ID based on the ChirpStack device name", () => {
    expect(createDeviceId("BB004", "a84041989a6036ac", new Set())).toBe("bb004");
  });

  it("adds a DevEUI suffix when the generated asset ID is already in use", () => {
    expect(
      createDeviceId("BB004", "a84041989a6036ac", new Set(["bb004"])),
    ).toBe("bb004-a84041989a6036ac");
  });

  it("plans only unregistered enabled devices and preserves existing asset IDs", () => {
    const planned = planDeviceRegistrations(
      [
        { name: "BE002", externalId: "A84041196B6036A5", model: "LDS-12-LWB" },
        { name: "BB004", externalId: "A84041989A6036AC", model: "DDS-45-LWB" },
      ],
      [{ device_id: "be002", external_id: "a84041196b6036a5" }],
    );

    expect(planned).toEqual([
      {
        device_id: "bb004",
        external_id: "a84041989a6036ac",
        model: "DDS-45-LWB",
      },
    ]);
  });

  it("rejects invalid DevEUIs instead of creating unusable registry rows", () => {
    expect(() =>
      planDeviceRegistrations(
        [{ name: "Invalid device", externalId: "not-an-eui", model: "Unknown" }],
        [],
      ),
    ).toThrow("invalid DevEUI");
  });
});
