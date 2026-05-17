import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import type { DriveSystem } from "../../platform/drive/drive-system.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import { getEventsDir } from "../../base/utils/paths.js";
import type { Logger } from "../logger.js";
import { DEFAULT_PORT } from "../port-utils.js";
import type { ApprovalBroker } from "../approval-broker.js";
import type { OutboxStore } from "../store/index.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import {
  validateOperatorHandoffSurfaceBinding,
  type OperatorHandoffResolutionBinding,
} from "../operator-handoff-surface.js";
import {
  createSurfaceActionBinding,
  createSurfaceProjection,
  findSurfaceActionBindingByToken,
  normalRuntimeGraphRef,
  normalSourceEventRef,
  validateSurfaceActionBinding,
  type SurfaceActionBinding,
  type SurfaceProjection,
} from "../surface-projection-protocol.js";
import type { Envelope } from "../types/envelope.js";
import type { SlackChannelAdapter } from "../gateway/slack-channel-adapter.js";
import { EventServerAuth } from "./server-auth.js";
import { EventServerCommandHandler } from "./server-command-handler.js";
import { EventServerFileIngestion } from "./server-file-ingestion.js";
import { isPayloadTooLargeError, readJsonBody, writeJson, writeJsonError } from "./server-http.js";
import { EventServerRouter } from "./server-router.js";
import { EventServerSnapshotReader } from "./server-snapshot-reader.js";
import { EventServerSseManager } from "./server-sse.js";
import { EventServerTriggerHandler } from "./server-trigger-handler.js";
import type {
  ActiveWorkersProvider,
  EventServerConfig,
} from "./server-types.js";

const DEFAULT_EVENT_FILE_MAX_ATTEMPTS = 3;
const DEFAULT_EVENT_FILE_RETRY_DELAY_MS = 250;

export type { EventServerConfig, EventServerSnapshot } from "./server-types.js";

export class EventServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private port: number;
  private readonly eventsDir: string;
  private readonly runtimeRoot: string;
  private readonly logger?: Logger;
  private approvalBroker?: ApprovalBroker;
  private outboxStore?: OutboxStore;
  private readonly snapshotReader: EventServerSnapshotReader;
  private readonly sseManager: EventServerSseManager;
  private readonly auth: EventServerAuth;
  private readonly fileIngestion: EventServerFileIngestion;
  private readonly triggerHandler: EventServerTriggerHandler;
  private readonly commandHandler: EventServerCommandHandler;
  private readonly router: EventServerRouter;
  private readonly approvalQueue = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
      surfaceInstanceRef: string;
      surfaceProjection: SurfaceProjection;
    }
  >();
  private envelopeHook?: (eventData: Record<string, unknown>) => void | Promise<void>;
  private commandEnvelopeHook?: (envelope: Envelope) => void | Promise<void>;
  private activeWorkersProvider?: ActiveWorkersProvider;
  private slackChannelAdapter?: SlackChannelAdapter;
  private slackEventsPath = "/slack/events";

  constructor(
    private readonly driveSystem: DriveSystem,
    private readonly config?: EventServerConfig,
    logger?: Logger,
  ) {
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? DEFAULT_PORT;
    this.eventsDir = config?.eventsDir ?? getEventsDir();
    this.runtimeRoot = config?.runtimeRoot ?? path.join(path.dirname(this.eventsDir), "runtime");
    this.logger = logger;
    this.approvalBroker = config?.approvalBroker;
    this.outboxStore = config?.outboxStore;
    this.snapshotReader = new EventServerSnapshotReader(
      this.eventsDir,
      config?.runtimeRoot,
      config?.stateManager,
      config?.controlBaseDir,
    );
    this.sseManager = new EventServerSseManager(this.logger, this.approvalBroker, this.outboxStore);
    this.auth = new EventServerAuth(this.host, this.eventsDir, () => this.port, this.logger);
    this.fileIngestion = new EventServerFileIngestion(
      this.eventsDir,
      this.logger,
      Math.max(1, config?.eventFileMaxAttempts ?? DEFAULT_EVENT_FILE_MAX_ATTEMPTS),
      Math.max(0, config?.eventFileRetryDelayMs ?? DEFAULT_EVENT_FILE_RETRY_DELAY_MS),
      async (eventData) => this.dispatchEvent(eventData),
    );
    this.triggerHandler = new EventServerTriggerHandler(
      this.eventsDir,
      this.logger,
      config?.triggerMapper,
      async (eventData) => this.dispatchEvent(eventData),
    );
    this.commandHandler = new EventServerCommandHandler(
      async (eventType, data) => this.broadcast(eventType, data),
      () => this.commandEnvelopeHook,
      async (requestId, approved, binding) => this.canResolveApproval(requestId, approved, binding),
      async (requestId, approved, binding) => this.resolveApproval(requestId, approved, binding),
      () => this.slackChannelAdapter,
    );
    this.router = new EventServerRouter({
      slackEventsPath: this.slackEventsPath,
      isSlackConfigured: () => this.slackChannelAdapter !== undefined,
      authorizeRequest: (req, res) => this.auth.authorizeRequest(req, res),
      handlePostSlackEvents: async (req, res) => this.commandHandler.handlePostSlackEvents(req, res),
      handlePostEvents: async (req, res) => this.handlePostEvents(req, res),
      handlePostTriggers: async (req, res) => this.triggerHandler.handlePostTriggers(req, res),
      handleGetGoals: async (res) => this.handleGetGoals(res),
      handleGetSnapshot: async (res) => this.handleGetSnapshot(res),
      handleGetGoalById: async (res, goalId) => this.handleGetGoalById(res, goalId),
      handleStream: async (req, res, requestUrl) => this.sseManager.handleStream(req, res, requestUrl),
      readDaemonStateRaw: async () => this.snapshotReader.readDaemonStateRaw(),
      handlePostDaemonRuntimeControl: async (req, res) => this.commandHandler.handlePostDaemonRuntimeControl(req, res),
      handlePostScheduleRunNow: async (req, res, scheduleId) =>
        this.commandHandler.handlePostScheduleRunNow(req, res, scheduleId),
      handleGoalAction: async (req, res, goalId, action) =>
        this.commandHandler.handleGoalAction(req, res, goalId, action),
      readHealthStatus: () => config?.healthStatusProvider?.() ?? { status: "ok" },
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    await fsp.mkdir(this.eventsDir, { recursive: true });
    await this.approvalBroker?.start();
    const startPort = this.port;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.router.route(req, res));
      const server = this.server;
      server.listen(startPort, this.host, () => {
        void (async () => {
          try {
            await this.finishServerStartup(server);
            this.logger?.info(`EventServer listening on ${this.host}:${this.port}`);
            resolve();
          } catch (err) {
            server.close(() => reject(err));
          }
        })();
      });
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        this.server = null;
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopFileWatcher();
    await this.approvalBroker?.stop();
    this.sseManager.closeAllClients();
    return new Promise((resolve) => {
      if (!this.server) {
        void this.auth.removeAuthTokenFile().finally(() => resolve());
        return;
      }
      this.server.close(() => {
        this.server = null;
        void this.auth.removeAuthTokenFile().finally(() => resolve());
      });
    });
  }

  startFileWatcher(): void {
    this.fileIngestion.start();
  }

  stopFileWatcher(): void {
    this.fileIngestion.stop();
  }

  async broadcast(eventType: string, data: unknown): Promise<void> {
    await this.sseManager.broadcast(eventType, data);
  }

  async requestApproval(
    goalId: string,
    task: { id: string; description: string; action: string },
    options: { requestId?: string } = {}
  ): Promise<boolean> {
    if (this.approvalBroker) {
      return this.approvalBroker.requestApproval(goalId, task, undefined, options.requestId);
    }
    const requestId = options.requestId ?? `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
    const surface = projectEventServerApprovalSurface({
      requestId,
      goalId,
      task,
      createdAt,
      expiresAt,
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.approvalQueue.delete(requestId);
        void this.broadcast("approval_resolved", { requestId, goalId, approved: false, reason: "timeout" });
        resolve(false);
      }, 5 * 60 * 1000);
      this.approvalQueue.set(requestId, {
        resolve,
        timer,
        surfaceInstanceRef: surface.surfaceInstanceRef,
        surfaceProjection: surface.projection,
      });
      void this.broadcast("approval_required", {
        requestId,
        goalId,
        task,
        approval_prompt: surface.projection.approval_prompt,
        surface_projection: surface.projection,
      });
    });
  }

  async resolveApproval(
    requestId: string,
    approved: boolean,
    binding: { surfaceActionBindingId?: string; surfaceActionBindingToken?: string } = {}
  ): Promise<boolean> {
    if (this.approvalBroker) {
      const resolved = await this.approvalBroker.resolveApproval(requestId, approved, "http", binding);
      if (resolved) {
        await this.resolveOperatorHandoffApproval(requestId, approved, {
          allowAlreadyResolved: true,
          trustedUpstreamApproval: true,
        });
        return true;
      }
    }
    const entry = this.approvalQueue.get(requestId);
    if (entry) {
      if (!validateEventServerApprovalBinding(entry, approved, binding)) {
        return false;
      }
      clearTimeout(entry.timer);
      this.approvalQueue.delete(requestId);
      entry.resolve(approved);
      void this.broadcast("approval_resolved", { requestId, approved });
      await this.resolveOperatorHandoffApproval(requestId, approved, {
        allowAlreadyResolved: true,
        trustedUpstreamApproval: true,
      });
      return true;
    }
    return this.resolveOperatorHandoffApproval(requestId, approved, { binding });
  }

  private async canResolveApproval(
    requestId: string,
    approved: boolean,
    binding: OperatorHandoffResolutionBinding = {},
  ): Promise<boolean> {
    if (this.approvalBroker || this.approvalQueue.has(requestId)) return true;
    const handoff = await new RuntimeOperatorHandoffStore(this.runtimeRoot, this.controlDbOptions()).load(requestId);
    return Boolean(
      handoff?.status === "open"
      && validateOperatorHandoffSurfaceBinding(handoff, approved, binding)
    );
  }

  private async resolveOperatorHandoffApproval(
    requestId: string,
    approved: boolean,
    options: {
      allowAlreadyResolved?: boolean;
      trustedUpstreamApproval?: boolean;
      binding?: OperatorHandoffResolutionBinding;
    } = {}
  ): Promise<boolean> {
    const store = new RuntimeOperatorHandoffStore(this.runtimeRoot, this.controlDbOptions());
    const existing = await store.load(requestId);
    if (!existing) return false;
    if (existing.status !== "open") return options.allowAlreadyResolved === true;
    if (
      options.trustedUpstreamApproval !== true
      && !validateOperatorHandoffSurfaceBinding(existing, approved, options.binding ?? {})
    ) {
      return false;
    }
    const resolved = await store.resolve(requestId, approved ? "approved" : "dismissed");
    void this.broadcast("approval_resolved", {
      requestId,
      goalId: resolved.goal_id,
      approved,
      kind: "operator_handoff",
    });
    return true;
  }

  private controlDbOptions(): { controlBaseDir: string } | undefined {
    if (this.config?.controlBaseDir) return { controlBaseDir: this.config.controlBaseDir };
    const stateManager = this.config?.stateManager;
    return stateManager ? { controlBaseDir: stateManager.getBaseDir() } : undefined;
  }

  setEnvelopeHook(hook: (eventData: Record<string, unknown>) => void | Promise<void>): void {
    this.envelopeHook = hook;
  }

  setCommandEnvelopeHook(hook: (envelope: Envelope) => void | Promise<void>): void {
    this.commandEnvelopeHook = hook;
  }

  setApprovalBroker(broker: ApprovalBroker): void {
    this.approvalBroker = broker;
    this.sseManager.setApprovalBroker(broker);
  }

  setOutboxStore(store: OutboxStore): void {
    this.outboxStore = store;
    this.sseManager.setOutboxStore(store);
  }

  setActiveWorkersProvider(provider: ActiveWorkersProvider): void {
    this.activeWorkersProvider = provider;
  }

  setSlackChannelAdapter(adapter: SlackChannelAdapter, eventsPath = "/slack/events"): void {
    this.slackChannelAdapter = adapter;
    this.slackEventsPath = eventsPath.startsWith("/") ? eventsPath : `/${eventsPath}`;
    this.router.setSlackEventsPath(this.slackEventsPath);
  }

  invalidateTriggerMappingsCache(): void {
    this.triggerHandler.invalidateCache();
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  isWatching(): boolean {
    return this.fileIngestion.isWatching();
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }

  getEventsDir(): string {
    return this.eventsDir;
  }

  getAuthToken(): string {
    return this.auth.getToken();
  }

  private async dispatchEvent(eventData: Record<string, unknown>): Promise<void> {
    if (this.envelopeHook) {
      await this.envelopeHook(eventData);
      return;
    }
    await this.driveSystem.writeEvent(eventData as never);
  }

  private async handlePostEvents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const data = await readJsonBody<unknown>(req);
      const event = PulSeedEventSchema.parse(data);
      await this.dispatchEvent(event as unknown as Record<string, unknown>);
      writeJson(res, 200, { status: "accepted", event_type: event.type });
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        writeJsonError(res, 413, "Payload too large");
        return;
      }
      writeJsonError(res, 400, "Invalid event", err);
    }
  }

  private async handleGetGoals(res: http.ServerResponse): Promise<void> {
    try {
      const goals = await this.snapshotReader.readGoalSummaries();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(goals));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async handleGetGoalById(res: http.ServerResponse, goalId: string): Promise<void> {
    try {
      const goal = await this.snapshotReader.readGoalDetail(goalId);
      if (goal === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Goal not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(goal));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async handleGetSnapshot(res: http.ServerResponse): Promise<void> {
    try {
      const snapshot = await this.snapshotReader.buildSnapshot(
        this.approvalBroker?.getPendingApprovalEvents() ?? [],
        this.outboxStore,
        this.activeWorkersProvider,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async finishServerStartup(server: http.Server): Promise<void> {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      this.port = addr.port;
    }
    await this.auth.persistAuthToken();
  }
}

type EventServerApprovalTask = { id: string; description: string; action: string };

function projectEventServerApprovalSurface(input: {
  requestId: string;
  goalId: string;
  task: EventServerApprovalTask;
  createdAt: string;
  expiresAt: string;
}): { projection: SurfaceProjection; surfaceInstanceRef: string } {
  const issuanceReplayKey = eventServerApprovalIssuanceReplayKey(input.requestId, input.createdAt);
  const surfaceInstanceRef = `approval:event:${input.requestId}:issued:${input.createdAt}`;
  const projectionId = `surface:${issuanceReplayKey}`;
  const sourceEventRefs = [
    normalSourceEventRef({
      kind: "approval_request",
      ref: input.requestId,
      event_type: "approval_required",
      occurred_at: input.createdAt,
      replay_key: issuanceReplayKey,
    }),
  ];
  const runtimeGraphRefs = [
    normalRuntimeGraphRef({
      kind: "approval",
      ref: input.requestId,
      role: "target",
    }),
    normalRuntimeGraphRef({
      kind: "goal",
      ref: input.goalId,
      role: "source",
    }),
  ];
  const approveBinding = createEventServerApprovalBinding({
    requestId: input.requestId,
    actionKind: "approve",
    projectionId,
    surfaceInstanceRef,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  const rejectBinding = createEventServerApprovalBinding({
    requestId: input.requestId,
    actionKind: "reject",
    projectionId,
    surfaceInstanceRef,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  return {
    surfaceInstanceRef,
    projection: createSurfaceProjection({
      projection_id: projectionId,
      surface: "approval",
      view: "normal",
      purpose: "Project an event-server approval request into the current user-visible surface.",
      redaction_class: "normal_safe",
      projected_at: input.createdAt,
      replay_key: issuanceReplayKey,
      source_event_refs: sourceEventRefs,
      runtime_graph_refs: runtimeGraphRefs,
      approval_prompt: {
        approval_id: input.requestId,
        prompt: `Approval required: ${input.task.description || input.task.action || input.task.id}`,
        action: input.task.action || "unknown",
        target_summary: input.task.description || input.task.id || "Approval required",
        expires_at: input.expiresAt,
        approve_binding_id: approveBinding.binding_id,
        reject_binding_id: rejectBinding.binding_id,
      },
      actions: [
        {
          action_id: `${issuanceReplayKey}:approve`,
          kind: "approve",
          label: "Approve",
          style: "primary",
          binding_id: approveBinding.binding_id,
        },
        {
          action_id: `${issuanceReplayKey}:reject`,
          kind: "reject",
          label: "Reject",
          style: "danger",
          binding_id: rejectBinding.binding_id,
        },
      ],
      action_bindings: [approveBinding, rejectBinding],
    }),
  };
}

function createEventServerApprovalBinding(input: {
  requestId: string;
  actionKind: "approve" | "reject";
  projectionId: string;
  surfaceInstanceRef: string;
  createdAt: string;
  expiresAt: string;
  sourceEventRefs: ReturnType<typeof normalSourceEventRef>[];
  runtimeGraphRefs: ReturnType<typeof normalRuntimeGraphRef>[];
}): SurfaceActionBinding {
  return createSurfaceActionBinding({
    action_kind: input.actionKind,
    surface: "approval",
    surface_instance_ref: input.surfaceInstanceRef,
    target: {
      kind: "approval",
      ref: input.requestId,
      surface_instance_ref: input.surfaceInstanceRef,
    },
    source_projection_id: input.projectionId,
    source_event_refs: input.sourceEventRefs,
    runtime_graph_refs: input.runtimeGraphRefs,
    replay_key: `${eventServerApprovalIssuanceReplayKey(input.requestId, input.createdAt)}:${input.actionKind}:event`,
    redaction_class: "normal_safe",
    created_at: input.createdAt,
    expires_at: input.expiresAt,
  });
}

function eventServerApprovalIssuanceReplayKey(requestId: string, createdAt: string): string {
  return `approval:${requestId}:issued:${createdAt}`;
}

function validateEventServerApprovalBinding(
  entry: {
    surfaceInstanceRef: string;
    surfaceProjection: SurfaceProjection;
  },
  approved: boolean,
  bindingInput: { surfaceActionBindingId?: string; surfaceActionBindingToken?: string },
): boolean {
  const expectedAction = approved ? "approve" : "reject";
  const expectedBindingId = entry.surfaceProjection.actions.find((action) =>
    action.kind === expectedAction
  )?.binding_id;
  const inputRef = bindingInput.surfaceActionBindingId ?? bindingInput.surfaceActionBindingToken;
  if (!expectedBindingId || !inputRef) {
    return false;
  }
  const binding = findSurfaceActionBindingByToken(entry.surfaceProjection.action_bindings, inputRef);
  if (!binding || binding.binding_id !== expectedBindingId) {
    return false;
  }
  const validation = validateSurfaceActionBinding({
    binding,
    surface: "approval",
    surfaceInstanceRef: entry.surfaceInstanceRef,
    actionKind: expectedAction,
    now: new Date().toISOString(),
  });
  return validation.status === "accepted";
}
