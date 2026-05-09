import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../daemon.js";

describe("DaemonConfigSchema", () => {
  it("bounds the event server port to the valid TCP port range", () => {
    expect(DaemonConfigSchema.safeParse({ event_server_port: 0 }).success).toBe(true);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 65_535 }).success).toBe(true);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 65_536 }).success).toBe(false);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 70_000 }).success).toBe(false);
  });
});
