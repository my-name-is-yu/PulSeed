import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProcessPid, signalProcessPid } from "../process-pid.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("process PID helpers", () => {
  it("parses only positive safe integer PID tokens", () => {
    expect(parseProcessPid("123")).toBe(123);
    expect(parseProcessPid(" 123\n")).toBe(123);
    expect(parseProcessPid("0")).toBeNull();
    expect(parseProcessPid("-1")).toBeNull();
    expect(parseProcessPid("1.5")).toBeNull();
    expect(parseProcessPid(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  it("signals safe PID values", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(signalProcessPid(123, "SIGTERM")).toEqual({ status: "sent", pid: 123 });
    expect(killSpy).toHaveBeenCalledWith(123, "SIGTERM");
  });

  it("does not signal unsafe PID values", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(signalProcessPid(Number.MAX_SAFE_INTEGER + 1, "SIGTERM")).toEqual({ status: "unsafe_pid" });
    expect(signalProcessPid("123", "SIGTERM")).toEqual({ status: "unsafe_pid" });
    expect(signalProcessPid(null, "SIGTERM")).toEqual({ status: "unsafe_pid" });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("reports missing processes without throwing", () => {
    const err = new Error("no such process") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });

    expect(signalProcessPid(123, "SIGTERM")).toEqual({ status: "missing_process", pid: 123 });
  });

  it("rethrows non-ESRCH signal errors", () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EPERM";
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });

    expect(() => signalProcessPid(123, "SIGTERM")).toThrow("permission denied");
  });
});
