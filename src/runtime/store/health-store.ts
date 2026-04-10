import { RuntimeJournal } from "./runtime-journal.js";
import {
  RuntimeComponentsHealthSchema,
  RuntimeDaemonHealthSchema,
  RuntimeHealthSnapshotSchema,
  summarizeRuntimeHealthStatus,
  RuntimeHealthStatusSchema,
  type RuntimeComponentsHealth,
  type RuntimeDaemonHealth,
  type RuntimeHealthSnapshot,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";

export class RuntimeHealthStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
  }

  async loadDaemonHealth(): Promise<RuntimeDaemonHealth | null> {
    return this.journal.load(this.paths.daemonHealthPath, RuntimeDaemonHealthSchema);
  }

  async saveDaemonHealth(health: RuntimeDaemonHealth): Promise<RuntimeDaemonHealth> {
    const parsed = RuntimeDaemonHealthSchema.parse(health);
    await this.journal.save(this.paths.daemonHealthPath, RuntimeDaemonHealthSchema, parsed);
    return parsed;
  }

  async loadComponentsHealth(): Promise<RuntimeComponentsHealth | null> {
    return this.journal.load(this.paths.componentsHealthPath, RuntimeComponentsHealthSchema);
  }

  async saveComponentsHealth(health: RuntimeComponentsHealth): Promise<RuntimeComponentsHealth> {
    const parsed = RuntimeComponentsHealthSchema.parse(health);
    await this.journal.save(this.paths.componentsHealthPath, RuntimeComponentsHealthSchema, parsed);
    return parsed;
  }

  async loadSnapshot(): Promise<RuntimeHealthSnapshot | null> {
    const [daemon, components] = await Promise.all([
      this.loadDaemonHealth(),
      this.loadComponentsHealth(),
    ]);
    if (daemon === null || components === null) return null;
    return RuntimeHealthSnapshotSchema.parse({
      status: daemon.status,
      leader: daemon.leader,
      checked_at: Math.max(daemon.checked_at, components.checked_at),
      components: components.components,
      details: daemon.details,
    });
  }

  async saveSnapshot(snapshot: RuntimeHealthSnapshot): Promise<RuntimeHealthSnapshot> {
    const parsed = RuntimeHealthSnapshotSchema.parse(snapshot);
    await Promise.all([
      this.saveDaemonHealth({
        status: parsed.status,
        leader: parsed.leader,
        checked_at: parsed.checked_at,
        details: parsed.details,
      }),
      this.saveComponentsHealth({
        checked_at: parsed.checked_at,
        components: parsed.components,
      }),
    ]);
    return parsed;
  }

  async reconcile(now = Date.now()): Promise<RuntimeHealthSnapshot> {
    const [daemon, components] = await Promise.all([
      this.loadDaemonHealth(),
      this.loadComponentsHealth(),
    ]);

    if (daemon !== null && components !== null) {
      const snapshot = await this.loadSnapshot();
      if (snapshot !== null) {
        return snapshot;
      }
      return RuntimeHealthSnapshotSchema.parse({
        status: daemon.status,
        leader: daemon.leader,
        checked_at: Math.max(daemon.checked_at, components.checked_at),
        components: components.components,
        details: daemon.details,
      });
    }

    const degradedComponents: RuntimeComponentsHealth = {
      checked_at: now,
      components: {
        gateway: "degraded",
        queue: "degraded",
        leases: "degraded",
        approval: "degraded",
        outbox: "degraded",
        supervisor: "degraded",
      },
    };

    if (daemon !== null && components === null) {
      const degradedSnapshot = RuntimeHealthSnapshotSchema.parse({
        status: "degraded",
        leader: daemon.leader,
        checked_at: now,
        components: degradedComponents.components,
        details: {
          ...daemon.details,
          repaired: true,
          recovered_from: "missing_components_health",
          previous_status: daemon.status,
        },
      });
      await Promise.all([
        this.saveComponentsHealth(degradedComponents),
        this.saveDaemonHealth({
          status: "degraded",
          leader: daemon.leader,
          checked_at: now,
          details: degradedSnapshot.details,
        }),
      ]);
      return degradedSnapshot;
    }

    if (daemon === null && components !== null) {
      const status = summarizeRuntimeHealthStatus(components.components);
      const repairedDaemon: RuntimeDaemonHealth = {
        status,
        leader: false,
        checked_at: now,
        details: {
          repaired: true,
          recovered_from: "missing_daemon_health",
        },
      };
      await this.saveDaemonHealth(repairedDaemon);
      return RuntimeHealthSnapshotSchema.parse({
        status,
        leader: repairedDaemon.leader,
        checked_at: Math.max(now, components.checked_at),
        components: components.components,
        details: repairedDaemon.details,
      });
    }

    const repairedSnapshot = RuntimeHealthSnapshotSchema.parse({
      status: "degraded",
      leader: false,
      checked_at: now,
      components: degradedComponents.components,
      details: {
        repaired: true,
        recovered_from: "missing_health_snapshot",
        previous_status: RuntimeHealthStatusSchema.parse("degraded"),
      },
    });
    await this.saveSnapshot(repairedSnapshot);
    return repairedSnapshot;
  }

  summarizeStatus(components: Record<string, RuntimeHealthSnapshot["status"]>): RuntimeHealthSnapshot["status"] {
    return summarizeRuntimeHealthStatus(components);
  }
}
