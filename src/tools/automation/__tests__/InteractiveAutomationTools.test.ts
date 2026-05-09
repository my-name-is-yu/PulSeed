import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyController } from "../../concurrency.js";
import { ToolExecutor } from "../../executor.js";
import { ToolPermissionManager } from "../../permission.js";
import { ToolRegistry } from "../../registry.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import type { ToolCallContext } from "../../types.js";
import { createBuiltinTools } from "../../builtin/index.js";
import {
  BrowserSessionStore,
  InteractiveAutomationRegistry,
  RuntimeAuthHandoffStore,
  type InteractiveAutomationProvider,
} from "../../../runtime/interactive-automation/index.js";
import {
  BackpressureController,
  CircuitBreakerController,
  GuardrailStore,
} from "../../../runtime/guardrails/index.js";
import {
  BrowserRunWorkflowTool,
  BrowserGetStateTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../index.js";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-automation-tools-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
  }
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeRegistry(): InteractiveAutomationRegistry {
  const registry = new InteractiveAutomationRegistry({
    defaultProviders: {
      desktop: "desktop-test",
      research: "research-test",
      browser: "browser-test",
    },
  });
  const desktopProvider: InteractiveAutomationProvider = {
    id: "desktop-test",
    family: "desktop",
    capabilities: ["desktop_state", "desktop_input"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "desktop-test",
      family: "desktop",
      capabilities: ["desktop_state", "desktop_input"],
      available: true,
    }),
    listApps: async () => [{ name: "Notes" }],
    getAppState: async (input) => ({ app: input.app, title: "Note" }),
    click: async () => ({ success: true, summary: "clicked" }),
    typeText: async () => ({ success: true, summary: "typed" }),
  };
  const researchProvider: InteractiveAutomationProvider = {
    id: "research-test",
    family: "research",
    capabilities: ["web_research"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "research-test",
      family: "research",
      capabilities: ["web_research"],
      available: true,
    }),
    researchWeb: async (input) => ({
      query: input.query,
      results: [{ title: "Result", url: "https://example.com" }],
      citations: ["https://example.com"],
    }),
    answerWithSources: async () => ({
      answer: "Answer",
      citations: ["https://example.com"],
    }),
  };
  const browserProvider: InteractiveAutomationProvider = {
    id: "browser-test",
    family: "browser",
    capabilities: ["browser_control", "agentic_workflow"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "browser-test",
      family: "browser",
      capabilities: ["browser_control", "agentic_workflow"],
      available: true,
    }),
    runBrowserWorkflow: async () => ({ success: true, summary: "workflow done", sessionId: "s1" }),
    getBrowserState: async () => ({ success: true, summary: "state read", sessionId: "s1" }),
  };
  registry.register(desktopProvider);
  registry.register(researchProvider);
  registry.register(browserProvider);
  return registry;
}

describe("interactive automation tools", () => {
  it("reads desktop app lists and app state through the configured provider", async () => {
    const registry = makeRegistry();
    const listTool = new DesktopListAppsTool(registry);
    const stateTool = new DesktopGetAppStateTool(registry);

    await expect(listTool.call({}, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", apps: [{ name: "Notes" }] },
    });
    await expect(stateTool.call({ app: "Notes" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", state: { title: "Note" } },
    });
  });

  it("marks desktop mutation tools as approval-gated and non-concurrency-safe", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry);
    const typeTool = new DesktopTypeTextTool(registry);

    expect(clickTool.metadata.isReadOnly).toBe(false);
    expect(clickTool.metadata.permissionLevel).toBe("execute");
    await expect(clickTool.checkPermissions({ app: "Notes", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(typeTool.checkPermissions({ app: "Notes", text: "secret" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    expect(clickTool.isConcurrencySafe({ app: "Notes", button: "left", clickCount: 1 })).toBe(false);
  });

  it("denies desktop mutation tools for configured protected apps", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry, {
      requireApproval: "always",
      deniedApps: ["System Settings"],
    });

    await expect(clickTool.checkPermissions({ app: "System Settings", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "denied",
      reason: expect.stringContaining("protected app"),
    });
  });

  it("requires semantic approval before executing desktop mutation tools", async () => {
    const registry = makeRegistry();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new DesktopClickTool(registry));
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const approvalFn = vi.fn().mockResolvedValue(false);

    const result = await executor.execute(
      "desktop_click",
      { app: "Notes", x: 10, y: 20 },
      makeContext({ approvalFn }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("User denied approval");
    expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "desktop_click",
      reason: expect.stringContaining("requires approval"),
    }));
  });

  it("rejects invalid desktop click numeric controls before provider execution", async () => {
    const click = vi.fn().mockResolvedValue({ success: true, summary: "clicked" });
    const registry = new InteractiveAutomationRegistry({
      defaultProviders: { desktop: "desktop-invalid-input" },
    });
    registry.register({
      id: "desktop-invalid-input",
      family: "desktop",
      capabilities: ["desktop_state", "desktop_input"],
      isAvailable: async () => ({ available: true }),
      describeEnvironment: async () => ({
        providerId: "desktop-invalid-input",
        family: "desktop",
        capabilities: ["desktop_state", "desktop_input"],
        available: true,
      }),
      click,
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new DesktopClickTool(registry));
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    for (const input of [
      { app: "Notes", x: Number.POSITIVE_INFINITY },
      { app: "Notes", y: Number.MAX_SAFE_INTEGER + 1 },
      { app: "Notes", clickCount: 0 },
      { app: "Notes", clickCount: 11 },
      { app: "Notes", clickCount: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const result = await executor.execute("desktop_click", input, makeContext({
        approvalFn: vi.fn().mockResolvedValue(true),
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Input validation failed");
    }
    expect(click).not.toHaveBeenCalled();
  });

  it("exports desktop click numeric bounds to the model-facing tool schema", () => {
    const parameters = toToolDefinition(new DesktopClickTool(makeRegistry())).function.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(parameters.properties?.x).toMatchObject({
      type: "number",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(parameters.properties?.y).toMatchObject({
      type: "number",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(parameters.properties?.clickCount).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10,
      default: 1,
    });
  });

  it("runs research tools as read-only provider calls", async () => {
    const registry = makeRegistry();
    const webTool = new ResearchWebTool(registry);
    const answerTool = new ResearchAnswerWithSourcesTool(registry);

    expect(webTool.metadata.isReadOnly).toBe(true);
    await expect(webTool.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        results: [{ title: "Result", url: "https://example.com" }],
      },
    });
    await expect(answerTool.call({ question: "What is PulSeed?" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        answer: "Answer",
        citations: ["https://example.com"],
      },
    });
  });

  it("approval-gates browser workflows", async () => {
    const registry = makeRegistry();
    const tool = new BrowserRunWorkflowTool(registry);

    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.permissionLevel).toBe("write_remote");
    await expect(tool.checkPermissions({ task: "Submit the form" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(tool.call({ task: "Open the dashboard" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "browser-test", result: { sessionId: "s1" } },
    });
  });

  it("records auth handoff requests for browser workflows that need login", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-auth-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-auth" },
      });
      registry.register({
        id: "browser-auth",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-auth",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow: async () => ({
          success: false,
          summary: "login required",
          error: "login required",
          sessionId: "sess-auth",
          authRequired: true,
          failureCode: "auth_required",
        }),
      });
      const store = new BrowserSessionStore(tmpRuntime);
      const handoffStore = new RuntimeAuthHandoffStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
        authHandoffStore: handoffStore,
        circuitBreaker: new CircuitBreakerController(new GuardrailStore(tmpRuntime)),
        backpressure: new BackpressureController(new GuardrailStore(tmpRuntime)),
      });
      const approvalFn = vi.fn().mockResolvedValue(true);

      const result = await tool.call(
        { task: "Check dashboard", startUrl: "https://mail.google.com" },
        makeContext({ approvalFn, conversationSessionId: "chat-1" }),
      );

      expect(result.success).toBe(true);
      expect(result.summary).toContain("Authentication handoff recorded");
      expect(result.data).toEqual(expect.objectContaining({
        status: "auth_handoff_pending",
        sessionId: "sess-auth",
        serviceKey: "mail.google.com",
      }));
      expect(result.contextModifier).toContain("Do not retry this browser workflow");
      expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.stringContaining("Authentication handoff required"),
      }));
      await expect(store.listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "sess-auth",
          provider_id: "browser-auth",
          service_key: "mail.google.com",
          actor_key: "chat-1",
          state: "auth_required",
        }),
      ]);
      await expect(handoffStore.listActive()).resolves.toEqual([
        expect.objectContaining({
          schema_version: "runtime-auth-handoff-v1",
          provider_id: "browser-auth",
          service_key: "mail.google.com",
          actor_key: "chat-1",
          state: "pending_operator",
          browser_session_id: "sess-auth",
          resumable_session_id: "sess-auth",
          failure_code: "auth_required",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("records auth handoff requests even when the provider has no resumable session id yet", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-auth-no-session-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-auth-no-session" },
      });
      registry.register({
        id: "browser-auth-no-session",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-auth-no-session",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow: async () => ({
          success: false,
          summary: "login required before session starts",
          error: "login required before session starts",
          authRequired: true,
          failureCode: "auth_required",
        }),
      });
      const store = new BrowserSessionStore(tmpRuntime);
      const handoffStore = new RuntimeAuthHandoffStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
        authHandoffStore: handoffStore,
      });

      const result = await tool.call(
        { task: "Open billing", startUrl: "https://billing.example.com" },
        makeContext({ approvalFn: vi.fn().mockResolvedValue(true), conversationSessionId: "chat-no-session" }),
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({
        status: "auth_handoff_pending",
        sessionId: "auth-handoff:browser-auth-no-session:billing.example.com:chat-no-session",
        resumableSessionId: undefined,
      }));
      await expect(store.listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "auth-handoff:browser-auth-no-session:billing.example.com:chat-no-session",
          provider_id: "browser-auth-no-session",
          service_key: "billing.example.com",
          actor_key: "chat-no-session",
          state: "auth_required",
          metadata: expect.objectContaining({
            resumable_session: null,
          }),
        }),
      ]);
      const persistedHandoffs = await new RuntimeAuthHandoffStore(tmpRuntime).listActive();
      expect(persistedHandoffs).toEqual([
        expect.objectContaining({
          provider_id: "browser-auth-no-session",
          service_key: "billing.example.com",
          actor_key: "chat-no-session",
          state: "pending_operator",
          browser_session_id: "auth-handoff:browser-auth-no-session:billing.example.com:chat-no-session",
          resumable_session_id: null,
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("cancels the durable auth handoff when operator approval is denied", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-auth-denied-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-auth-denied" },
      });
      registry.register({
        id: "browser-auth-denied",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-auth-denied",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow: async () => ({
          success: false,
          summary: "login required",
          error: "login required",
          sessionId: "sess-denied",
          authRequired: true,
          failureCode: "auth_required",
        }),
      });
      const handoffStore = new RuntimeAuthHandoffStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: new BrowserSessionStore(tmpRuntime),
        authHandoffStore: handoffStore,
      });

      const result = await tool.call(
        { task: "Open dashboard", startUrl: "https://denied.example.com" },
        makeContext({ approvalFn: vi.fn().mockResolvedValue(false), conversationSessionId: "chat-denied" }),
      );

      expect(result.success).toBe(false);
      await expect(handoffStore.listActive()).resolves.toEqual([]);
      await expect(handoffStore.list()).resolves.toEqual([
        expect.objectContaining({
          state: "cancelled",
          failure_code: "approval_denied",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("completes the latest pending handoff when a later workflow succeeds for the same scope", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-auth-complete-"));
    try {
      const handoffStore = new RuntimeAuthHandoffStore(tmpRuntime);
      await handoffStore.createPending({
        providerId: "browser-complete",
        serviceKey: "complete.example.com",
        workspace: "/tmp",
        actorKey: "chat-complete",
        browserSessionId: "sess-complete",
        resumableSessionId: "sess-complete",
        taskSummary: "Open dashboard",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-complete" },
      });
      registry.register({
        id: "browser-complete",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-complete",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow: async () => ({
          success: true,
          summary: "workflow done",
          sessionId: "sess-complete",
        }),
      });
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: new BrowserSessionStore(tmpRuntime),
        authHandoffStore: handoffStore,
      });

      const result = await tool.call(
        { task: "Open dashboard", startUrl: "https://complete.example.com" },
        makeContext({ conversationSessionId: "chat-complete" }),
      );

      expect(result.success).toBe(true);
      await expect(handoffStore.listActive()).resolves.toEqual([]);
      await expect(handoffStore.list()).resolves.toEqual([
        expect.objectContaining({
          state: "completed",
          browser_session_id: "sess-complete",
          completed_at: expect.any(String),
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("reuses the latest authenticated browser session and ignores auth_required stale sessions", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-session-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-good",
        providerId: "browser-reuse",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-2",
      });
      await store.recordAuthRequired({
        sessionId: "sess-stale",
        providerId: "browser-reuse",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-2",
        failureCode: "auth_required",
        failureMessage: "login again",
      });

      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: true,
        summary: "workflow done",
        sessionId: "sess-good",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-reuse" },
      });
      registry.register({
        id: "browser-reuse",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-reuse",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });

      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
      });

      await expect(
        tool.call(
          { task: "Resume app", startUrl: "https://app.example.com/home" },
          makeContext({ conversationSessionId: "chat-2" }),
        ),
      ).resolves.toMatchObject({
        success: true,
        data: { result: { sessionId: "sess-good" } },
      });
      expect(runBrowserWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-good",
      }));
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("does not reuse authenticated browser sessions whose expires_at is already stale", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-session-expired-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-expired",
        providerId: "browser-expired",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-expired",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      await store.recordAuthenticated({
        sessionId: "sess-fresh",
        providerId: "browser-expired",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-expired",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });

      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: true,
        summary: "workflow done",
        sessionId: "sess-fresh",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-expired" },
      });
      registry.register({
        id: "browser-expired",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-expired",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });

      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
      });

      await tool.call(
        { task: "Resume app", startUrl: "https://app.example.com/home" },
        makeContext({ conversationSessionId: "chat-expired" }),
      );

      expect(runBrowserWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-fresh",
      }));
      expect(runBrowserWorkflow).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-expired",
      }));
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("rejects explicit stale browser_run_workflow sessions before calling the provider", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-workflow-stale-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthRequired({
        sessionId: "sess-workflow-stale",
        providerId: "browser-workflow-stale",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-workflow-stale",
        failureCode: "auth_required",
        failureMessage: "login required",
      });
      const runBrowserWorkflow = vi.fn();
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-workflow-stale" },
      });
      registry.register({
        id: "browser-workflow-stale",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-workflow-stale",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });
      const tool = new BrowserRunWorkflowTool(registry, undefined, { browserSessionStore: store });

      const result = await tool.call(
        {
          task: "Resume app",
          startUrl: "https://app.example.com/home",
          sessionId: "sess-workflow-stale",
        },
        makeContext({ conversationSessionId: "chat-workflow-stale" }),
      );

      expect(result.success).toBe(false);
      expect(result.data).toEqual(expect.objectContaining({
        status: "browser_session_not_executed",
        code: "browser_session_stale",
        sessionId: "sess-workflow-stale",
      }));
      expect(runBrowserWorkflow).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("rejects explicit browser_run_workflow sessions that do not match the current browser scope", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-workflow-mismatch-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-workflow-other-scope",
        providerId: "browser-workflow-mismatch",
        serviceKey: "other.example.com",
        workspace: "/tmp",
        actorKey: "chat-other",
      });
      const runBrowserWorkflow = vi.fn();
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-workflow-mismatch" },
      });
      registry.register({
        id: "browser-workflow-mismatch",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-workflow-mismatch",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });
      const tool = new BrowserRunWorkflowTool(registry, undefined, { browserSessionStore: store });

      const result = await tool.call(
        {
          task: "Resume app",
          startUrl: "https://app.example.com/home",
          sessionId: "sess-workflow-other-scope",
        },
        makeContext({ conversationSessionId: "chat-workflow-mismatch" }),
      );

      expect(result.success).toBe(false);
      expect(result.data).toEqual(expect.objectContaining({
        status: "browser_session_not_executed",
        code: "browser_session_scope_mismatch",
        sessionId: "sess-workflow-other-scope",
      }));
      expect(runBrowserWorkflow).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("uses explicit serviceKey for browser_run_workflow scoped resume without startUrl", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-workflow-service-key-"));
    try {
      const handoffStore = new RuntimeAuthHandoffStore(tmpRuntime);
      await handoffStore.createPending({
        providerId: "browser-workflow-service",
        serviceKey: "service.example.com",
        workspace: "/tmp",
        actorKey: "chat-workflow-service",
        browserSessionId: "sess-service",
        resumableSessionId: "sess-service",
        taskSummary: "Resume app",
      });
      await new BrowserSessionStore(tmpRuntime).recordAuthenticated({
        sessionId: "sess-service",
        providerId: "browser-workflow-service",
        serviceKey: "service.example.com",
        workspace: "/tmp",
        actorKey: "chat-workflow-service",
      });
      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: true,
        summary: "workflow done",
        sessionId: "sess-service",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-workflow-service" },
      });
      registry.register({
        id: "browser-workflow-service",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-workflow-service",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: new BrowserSessionStore(tmpRuntime),
        authHandoffStore: handoffStore,
      });

      const result = await tool.call(
        {
          task: "Resume app",
          serviceKey: "service.example.com",
          sessionId: "sess-service",
        },
        makeContext({ conversationSessionId: "chat-workflow-service" }),
      );

      expect(result.success).toBe(true);
      await expect(handoffStore.listActive()).resolves.toEqual([]);
      await expect(handoffStore.list()).resolves.toEqual([
        expect.objectContaining({
          service_key: "service.example.com",
          state: "completed",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("reuses the latest authenticated browser session for browser_get_state when service scope is explicit", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-state-reuse-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-state",
        providerId: "browser-state-reuse",
        serviceKey: "state.example.com",
        workspace: "/tmp",
        actorKey: "chat-state",
      });
      const getBrowserState = vi.fn().mockResolvedValue({
        success: true,
        summary: "state read",
        sessionId: "sess-state",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-state-reuse" },
      });
      registry.register({
        id: "browser-state-reuse",
        family: "browser",
        capabilities: ["browser_control"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-state-reuse",
          family: "browser",
          capabilities: ["browser_control"],
          available: true,
        }),
        getBrowserState,
      });
      const tool = new BrowserGetStateTool(registry, undefined, { browserSessionStore: store });

      await expect(
        tool.call(
          { startUrl: "https://state.example.com/home" },
          makeContext({ conversationSessionId: "chat-state" }),
        ),
      ).resolves.toMatchObject({
        success: true,
        data: { result: { sessionId: "sess-state" } },
      });
      expect(getBrowserState).toHaveBeenCalledWith({ sessionId: "sess-state" });
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("fails closed for browser_get_state without session id or explicit service scope", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-state-no-scope-"));
    try {
      const getBrowserState = vi.fn();
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-state-no-scope" },
      });
      registry.register({
        id: "browser-state-no-scope",
        family: "browser",
        capabilities: ["browser_control"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-state-no-scope",
          family: "browser",
          capabilities: ["browser_control"],
          available: true,
        }),
        getBrowserState,
      });
      const tool = new BrowserGetStateTool(registry, undefined, {
        browserSessionStore: new BrowserSessionStore(tmpRuntime),
      });

      const result = await tool.call({}, makeContext({ conversationSessionId: "chat-state" }));

      expect(result.success).toBe(false);
      expect(result.data).toEqual(expect.objectContaining({
        status: "browser_session_not_executed",
        code: "browser_session_scope_required",
      }));
      expect(getBrowserState).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("rejects explicit stale browser_get_state sessions without falling back to latest", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-state-stale-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-fresh-state",
        providerId: "browser-state-stale",
        serviceKey: "state.example.com",
        workspace: "/tmp",
        actorKey: "chat-state",
      });
      await store.recordAuthRequired({
        sessionId: "sess-stale-state",
        providerId: "browser-state-stale",
        serviceKey: "state.example.com",
        workspace: "/tmp",
        actorKey: "chat-state",
        failureCode: "auth_required",
        failureMessage: "login required",
      });
      const getBrowserState = vi.fn();
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-state-stale" },
      });
      registry.register({
        id: "browser-state-stale",
        family: "browser",
        capabilities: ["browser_control"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-state-stale",
          family: "browser",
          capabilities: ["browser_control"],
          available: true,
        }),
        getBrowserState,
      });
      const tool = new BrowserGetStateTool(registry, undefined, { browserSessionStore: store });

      const result = await tool.call(
        {
          sessionId: "sess-stale-state",
          startUrl: "https://state.example.com/home",
        },
        makeContext({ conversationSessionId: "chat-state" }),
      );

      expect(result.success).toBe(false);
      expect(result.data).toEqual(expect.objectContaining({
        status: "browser_session_not_executed",
        code: "browser_session_stale",
        sessionId: "sess-stale-state",
      }));
      expect(getBrowserState).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("opens a circuit breaker after repeated rate limit failures", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-breaker-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-breaker" },
      });
      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: false,
        summary: "rate limited",
        error: "rate limited",
        failureCode: "rate_limited",
      });
      registry.register({
        id: "browser-breaker",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-breaker",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });
      const guardrailStore = new GuardrailStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        circuitBreaker: new CircuitBreakerController(guardrailStore),
      });

      await tool.call({ task: "Try once", startUrl: "https://api.example.com" }, makeContext());
      await tool.call({ task: "Try twice", startUrl: "https://api.example.com" }, makeContext());
      const blocked = await tool.call({ task: "Try thrice", startUrl: "https://api.example.com" }, makeContext());

      expect(blocked.success).toBe(false);
      expect(blocked.error).toContain("circuit breaker open");
      expect(runBrowserWorkflow).toHaveBeenCalledTimes(2);
      await expect(guardrailStore.listBreakers()).resolves.toEqual([
        expect.objectContaining({
          provider_id: "browser-breaker",
          service_key: "api.example.com",
          state: "open",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("shares backpressure limits across controllers that point at the same runtime root", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-backpressure-shared-"));
    try {
      const first = new BackpressureController(new GuardrailStore(tmpRuntime), {
        maxConcurrentPerProvider: 1,
        maxConcurrentPerService: 1,
      });
      const second = new BackpressureController(new GuardrailStore(tmpRuntime), {
        maxConcurrentPerProvider: 1,
        maxConcurrentPerService: 1,
      });

      await expect(first.acquire({
        providerId: "browser-shared",
        serviceKey: "app.example.com",
        runKey: "run-1",
      })).resolves.toEqual({ ok: true });
      await expect(second.acquire({
        providerId: "browser-shared",
        serviceKey: "app.example.com",
        runKey: "run-2",
      })).resolves.toEqual({
        ok: false,
        reason: "provider concurrency limit reached (1)",
      });
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("wires browser auth handoff and guardrails through createBuiltinTools with a production-style runtime root", async () => {
    const tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-factory-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-factory" },
      });
      const runBrowserWorkflow = vi.fn()
        .mockResolvedValueOnce({
          success: false,
          summary: "login required",
          error: "login required",
          sessionId: "sess-factory",
          authRequired: true,
          failureCode: "auth_required",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        });
      registry.register({
        id: "browser-factory",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-factory",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });

      const tool = createBuiltinTools({
        stateManager: { getBaseDir: () => tmpBaseDir } as never,
        interactiveAutomationRegistry: registry,
      }).find((candidate) => candidate.metadata.name === "browser_run_workflow") as BrowserRunWorkflowTool | undefined;

      expect(tool).toBeDefined();

      const approvalFn = vi.fn().mockResolvedValue(true);
      const first = await tool!.call(
        { task: "Open mail", startUrl: "https://mail.google.com" },
        makeContext({ approvalFn, conversationSessionId: "chat-factory" }),
      );
      expect(first.success).toBe(true);
      expect(first.summary).toContain("Authentication handoff recorded");
      expect(first.data).toEqual(expect.objectContaining({
        status: "auth_handoff_pending",
        sessionId: "sess-factory",
      }));

      const runtimeRoot = path.join(tmpBaseDir, "runtime");
      const sessionStore = new BrowserSessionStore(runtimeRoot);
      await expect(sessionStore.listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "sess-factory",
          provider_id: "browser-factory",
          service_key: "mail.google.com",
          actor_key: "chat-factory",
          state: "auth_required",
        }),
      ]);

      await tool!.call({ task: "Retry one", startUrl: "https://api.example.com" }, makeContext());
      await tool!.call({ task: "Retry two", startUrl: "https://api.example.com" }, makeContext());
      const blocked = await tool!.call({ task: "Retry three", startUrl: "https://api.example.com" }, makeContext());

      expect(blocked.success).toBe(false);
      expect(blocked.error).toContain("circuit breaker open");
      expect(runBrowserWorkflow).toHaveBeenCalledTimes(3);
      await expect(new GuardrailStore(runtimeRoot).listBreakers()).resolves.toEqual([
        expect.objectContaining({
          provider_id: "browser-factory",
          service_key: "api.example.com",
          state: "open",
        }),
      ]);
    } finally {
      await fs.rm(tmpBaseDir, { recursive: true, force: true });
    }
  });

  it("registers automation tools for enabled production defaults and injected registries", async () => {
    const defaultTools = await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ interactive_automation: { enabled: true } }),
        "utf8",
      );
      return createBuiltinTools().map((tool) => tool.metadata.name);
    });
    const withAutomation = createBuiltinTools({ interactiveAutomationRegistry: makeRegistry() })
      .map((tool) => tool.metadata.name);

    expect(defaultTools).toContain("desktop_click");
    expect(withAutomation).toEqual(expect.arrayContaining([
      "desktop_list_apps",
      "desktop_get_app_state",
      "desktop_click",
      "desktop_type_text",
      "research_web",
      "research_answer_with_sources",
      "browser_run_workflow",
      "browser_get_state",
    ]));
  });

  it("does not register automation tools when config disables automation and no registry is injected", () => {
    const tools = createBuiltinTools().map((tool) => tool.metadata.name);

    expect(tools).not.toContain("desktop_click");
  });

  it("applies global config denied_apps when registering default automation tools", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            denied_apps: ["Protected App"],
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "desktop_click") as DesktopClickTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.checkPermissions({ app: "Protected App", button: "left", clickCount: 1 })).resolves.toMatchObject({
        status: "denied",
      });
    });
  });

  it("uses configured default providers when creating the production registry", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            default_research_provider: "noop",
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "research_web") as ResearchWebTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("noop is unavailable"),
      });
    });
  });
});
