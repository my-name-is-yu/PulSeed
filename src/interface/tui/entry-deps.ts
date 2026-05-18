import path from "path";
import { StateManager } from "../../base/state/state-manager.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import type { ApprovalRequest } from "./app.js";
import type { TuiChatSurface } from "./chat-surface.js";
import { isSafeBashCommand } from "./bash-mode.js";
import { getCliLogger } from "../cli/cli-logger.js";
import type { Task } from "../../base/types/task.js";
import { createApprovalQueue } from "./entry-approval.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { ApprovalBroker } from "../../runtime/approval-broker.js";
import { ApprovalStore, createRuntimeStorePaths } from "../../runtime/store/index.js";

function createTuiApprovalBroker(stateManager: StateManager): ApprovalBroker {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  return new ApprovalBroker({
    store: new ApprovalStore(createRuntimeStorePaths(runtimeRoot), { controlBaseDir: stateManager.getBaseDir() }),
  });
}

export async function buildStandaloneTuiDeps() {
  const { buildLLMClient, buildAdapterRegistry } = await import("../../base/llm/provider-factory.js");
  const { createWorkspaceContextProvider } = await import("../../platform/observation/workspace-context.js");
  const { TrustManager } = await import("../../platform/traits/trust-manager.js");
  const { DriveSystem } = await import("../../platform/drive/drive-system.js");
  const { ObservationEngine } = await import("../../platform/observation/observation-engine.js");
  const { StallDetector } = await import("../../platform/drive/stall-detector.js");
  const { ProgressPredictor } = await import("../../platform/drive/progress-predictor.js");
  const { SatisficingJudge } = await import("../../platform/drive/satisficing-judge.js");
  const { EthicsGate } = await import("../../platform/traits/ethics-gate.js");
  const { SessionManager } = await import("../../orchestrator/execution/session-manager.js");
  const { StrategyManager } = await import("../../orchestrator/strategy/strategy-manager.js");
  const { GoalNegotiator } = await import("../../orchestrator/goal/goal-negotiator.js");
  const { TaskLifecycle } = await import("../../orchestrator/execution/task/task-lifecycle.js");
  const { ReportingEngine } = await import("../../reporting/reporting-engine.js");
  const { DurableLoop } = await import("../../orchestrator/loop/durable-loop.js");
  const { GoalTreeManager } = await import("../../orchestrator/goal/goal-tree-manager.js");
  const { StateAggregator } = await import("../../orchestrator/goal/state-aggregator.js");
  const { GoalDependencyGraph } = await import("../../orchestrator/goal/goal-dependency-graph.js");
  const { TreeLoopOrchestrator } = await import("../../orchestrator/goal/tree-loop-orchestrator.js");
  const { ScheduleEngine } = await import("../../runtime/schedule/engine.js");
  const { RuntimeEvidenceLedger } = await import("../../runtime/store/evidence-ledger.js");
  const { RuntimeBudgetStore } = await import("../../runtime/store/budget-store.js");
  const { RuntimeOperatorHandoffStore } = await import("../../runtime/store/operator-handoff-store.js");
  const { RuntimePostmortemReportStore } = await import("../../runtime/store/postmortem-report.js");
  const { MemoryLifecycleManager, DriveScoreAdapter } = await import("../../platform/knowledge/memory/memory-lifecycle.js");
  const { KnowledgeManager } = await import("../../platform/knowledge/knowledge-manager.js");
  const { CharacterConfigManager } = await import("../../platform/traits/character-config.js");
  const { SharedManagerTuiChatSurface } = await import("./chat-surface.js");
  const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
  const { createArcAgi3CompletionArtifactFinalizer } = await import("../../tools/arc-agi3/index.js");
  const { buildCliDataSourceRegistry } = await import("../cli/data-source-bootstrap.js");
  const {
    createNativeCorePhaseRunner,
    createNativeChatAgentLoopRunner,
    createNativeReviewAgentLoopRunner,
    createNativeTaskAgentLoopRunner,
    shouldUseNativeTaskAgentLoop,
  } = await import("../../orchestrator/execution/agent-loop/index.js");
  const { ActionHandler } = await import("./actions.js");
  const { IntentRecognizer } = await import("./intent-recognizer.js");
  const GapCalculator = await import("../../platform/drive/gap-calculator.js");
  const DriveScorer = await import("../../platform/drive/drive-scorer.js");

  const stateManager = new StateManager();
  const characterConfigManager = new CharacterConfigManager(stateManager);
  const characterConfig = await characterConfigManager.load();
  const llmClient = await buildLLMClient();
  const providerConfig = await loadProviderConfig();
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const dataSourceRegistry = await buildCliDataSourceRegistry(process.cwd(), getCliLogger());
  const toolRegistry = new ToolRegistry();
  const evidenceLedger = new RuntimeEvidenceLedger(path.join(stateManager.getBaseDir(), "runtime"));
  const registerToolIfMissing = (tool: ReturnType<typeof createBuiltinTools>[number]) => {
    if (!toolRegistry.get(tool.metadata.name)) {
      toolRegistry.register(tool);
    }
  };
  for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry, llmClient })) {
    registerToolIfMissing(tool);
  }

  const contextProvider = createWorkspaceContextProvider(
    { workDir: process.cwd() },
    async (goalId: string) => {
      try {
        const goal = await stateManager.loadGoal(goalId);
        if (!goal) return undefined;
        let desc = `${goal.title}\n${goal.description}`;
        if (goal.parent_id) {
          const parent = await stateManager.loadGoal(goal.parent_id);
          if (parent?.description) {
            desc = `${desc}\n${parent.description}`;
          }
        }
        const dimensionMappings = Object.fromEntries(
          goal.dimensions.map((dimension) => [dimension.name, dimension.observation_mapping ?? null])
        );
        return { description: desc, dimensionMappings };
      } catch (err) {
        getCliLogger().error(`[pulseed] Failed to resolve goal description for "${goalId}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    async (goalId: string) => {
      try {
        const goal = await stateManager.loadGoal(goalId);
        return goal?.constraints;
      } catch (err) {
        getCliLogger().error(`[pulseed] Failed to resolve goal constraints for "${goalId}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }
  );

  const observationEngine = new ObservationEngine(stateManager, dataSourceRegistry.getAllSources(), llmClient, contextProvider);
  const progressPredictor = new ProgressPredictor();
  const stallDetector = new StallDetector(stateManager, characterConfig, progressPredictor);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient, undefined, getCliLogger());
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const adapterRegistry = await buildAdapterRegistry(llmClient);
  const permissionManager = new ToolPermissionManager({
    trustManager,
    allowRules: [
      {
        toolName: "shell",
        inputMatcher: (input) =>
          typeof input === "object" &&
          input !== null &&
          typeof (input as Record<string, unknown>)["command"] === "string" &&
          isSafeBashCommand((input as Record<string, unknown>)["command"] as string),
        reason: "safe shell command",
      },
    ],
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager,
    concurrency: new ConcurrencyController(),
    traceBaseDir: stateManager.getBaseDir(),
  });

  const approvalQueue = createApprovalQueue();
  const approvalFn = (task: Task): Promise<boolean> => approvalQueue.enqueueApproval(task);
  const approvalBroker = createTuiApprovalBroker(stateManager);

  const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);
  const goalTreeManager = new GoalTreeManager(stateManager, llmClient, ethicsGate, goalDependencyGraph);
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const treeLoopOrchestrator = new TreeLoopOrchestrator(stateManager, goalTreeManager, stateAggregator, satisficingJudge);

  const pulseedBaseDir = getPulseedDirPath();
  let memoryLifecycleManager: InstanceType<typeof MemoryLifecycleManager> | undefined;
  let driveScoreAdapter: InstanceType<typeof DriveScoreAdapter> | undefined;
  try {
    driveScoreAdapter = new DriveScoreAdapter();
    memoryLifecycleManager = new MemoryLifecycleManager(
      pulseedBaseDir,
      llmClient,
      undefined,
      undefined,
      undefined,
      driveScoreAdapter
    );
    await memoryLifecycleManager.initializeDirectories();
  } catch (err) {
    getCliLogger().warn(`[pulseed] MemoryLifecycleManager init failed — memory features disabled: ${err instanceof Error ? err.message : String(err)}`);
    memoryLifecycleManager = undefined;
    driveScoreAdapter = undefined;
  }
  const knowledgeManager = new KnowledgeManager(stateManager, llmClient);

  const agentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeTaskAgentLoopRunner({
        llmClient,
        stateManager,
        providerConfig,
        toolRegistry,
        toolExecutor,
        cwd: process.cwd(),
        traceBaseDir: stateManager.getBaseDir(),
        defaultWorktreePolicy: providerConfig.agent_loop?.worktree
          ? {
              enabled: providerConfig.agent_loop.worktree.enabled,
              baseDir: providerConfig.agent_loop.worktree.base_dir,
              keepForDebug: providerConfig.agent_loop.worktree.keep_for_debug,
              cleanupPolicy: providerConfig.agent_loop.worktree.cleanup_policy,
            }
          : undefined,
      })
    : undefined;
  const corePhaseRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeCorePhaseRunner({
        llmClient,
        stateManager,
        providerConfig,
        toolRegistry,
        toolExecutor,
        cwd: process.cwd(),
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;

  const controlDbOptions = { controlBaseDir: stateManager.getBaseDir() };
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const runtimeBudgetStore = new RuntimeBudgetStore(runtimeRoot, controlDbOptions);
  const operatorHandoffStore = new RuntimeOperatorHandoffStore(runtimeRoot, controlDbOptions);
  const postmortemReportStore = new RuntimePostmortemReportStore(runtimeRoot, controlDbOptions);

  const taskLifecycle = new TaskLifecycle({
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    options: {
      approvalFn,
      toolExecutor,
      agentLoopRunner,
      completionArtifactFinalizers: [createArcAgi3CompletionArtifactFinalizer()],
      revertCwd: process.cwd(),
      healthCheckCwd: process.cwd(),
      operatorHandoffStore,
    },
  });

  const gapCalculator = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer = {
    scoreAllDimensions: (gapVector: Parameters<typeof DriveScorer.scoreAllDimensions>[0], context: Parameters<typeof DriveScorer.scoreAllDimensions>[1], _config: unknown) =>
      DriveScorer.scoreAllDimensions(gapVector, context),
    rankDimensions: DriveScorer.rankDimensions,
  };

  const coreLoop = new DurableLoop({
    stateManager,
    observationEngine,
    gapCalculator,
    driveScorer,
    taskLifecycle,
    satisficingJudge,
    stallDetector,
    strategyManager,
    reportingEngine,
    driveSystem,
    adapterRegistry,
    goalTreeManager,
    stateAggregator,
    treeLoopOrchestrator,
    goalDependencyGraph,
    memoryLifecycleManager,
    driveScoreAdapter,
    contextProvider,
    corePhaseRunner,
    evidenceLedger,
    runtimeBudgetStore,
    operatorHandoffStore,
    postmortemReportStore,
  });

  const scheduleEngine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    dataSourceRegistry,
    llmClient,
    coreLoop,
    stateManager,
    reportingEngine,
    memoryLifecycle: memoryLifecycleManager,
    knowledgeManager,
  });
  await scheduleEngine.loadEntries();
  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry: toolRegistry,
    llmClient,
    scheduleEngine,
    adapterRegistry,
    sessionManager,
    observationEngine,
    knowledgeManager,
  })) {
    registerToolIfMissing(tool);
  }

  const goalNegotiator = new GoalNegotiator(
    stateManager,
    llmClient,
    ethicsGate,
    observationEngine,
    characterConfig,
    satisficingJudge,
    goalTreeManager,
    adapterRegistry.getAdapterCapabilities()
  );

  let chatRunner: TuiChatSurface | undefined;
  try {
    const adapterType = providerConfig.adapter ?? "claude_code_cli";
    const adapter = adapterRegistry.getAdapter(adapterType);
    const { RuntimeControlService, createDaemonRuntimeControlExecutor } = await import("../../runtime/control/index.js");
    const runtimeControlService = new RuntimeControlService({
      runtimeRoot: path.join(stateManager.getBaseDir(), "runtime"),
      stateManager,
      executor: createDaemonRuntimeControlExecutor({ baseDir: stateManager.getBaseDir() }),
    });
    for (const tool of createBuiltinTools({
      stateManager,
      trustManager,
      registry: toolRegistry,
      llmClient,
      runtimeControlService,
    })) {
      if (!toolRegistry.get(tool.metadata.name)) {
        toolRegistry.register(tool);
      }
    }
    const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeChatAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;
    const reviewAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeReviewAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;
    chatRunner = new SharedManagerTuiChatSurface({
      stateManager,
      adapter,
      llmClient,
      defaultExecutionSecurity: providerConfig.agent_loop?.security,
      trustManager,
      registry: toolRegistry,
      toolExecutor,
      chatAgentLoopRunner,
      reviewAgentLoopRunner,
      runtimeControlService,
      approvalBroker,
    });
  } catch (err) {
    getCliLogger().warn(`[pulseed] ChatRunner init failed — free-form chat disabled: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actionHandler = new ActionHandler({
    stateManager,
    goalNegotiator,
    reportingEngine,
  });
  const intentRecognizer = new IntentRecognizer(llmClient);

  return {
    stateManager,
    llmClient,
    trustManager,
    coreLoop,
    goalNegotiator,
    reportingEngine,
    setRequestApproval: approvalQueue.setRequestApproval,
    approvalFn,
    chatRunner,
    actionHandler,
    intentRecognizer,
    toolExecutor,
  };
}

export async function buildDaemonModeChatSurface(
  baseDir: string,
  stateManager: StateManager,
  daemonClient: DaemonClient,
  daemonPort: number
): Promise<{
  chatRunner: TuiChatSurface | undefined;
  llmClient: ILLMClient | undefined;
  setRequestApproval: (fn: (req: ApprovalRequest) => void) => void;
  approvalFn: (task: Task) => Promise<boolean>;
  toolExecutor: ToolExecutor;
}> {
  const { TrustManager } = await import("../../platform/traits/trust-manager.js");
  const { ScheduleEngine } = await import("../../runtime/schedule/engine.js");
  const { buildCliDataSourceRegistry } = await import("../cli/data-source-bootstrap.js");
  const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
  const trustManager = new TrustManager(stateManager);
  const toolRegistry = new ToolRegistry();
  const dataSourceRegistry = await buildCliDataSourceRegistry(process.cwd(), getCliLogger());
  const scheduleEngine = new ScheduleEngine({ baseDir, dataSourceRegistry });
  await scheduleEngine.loadEntries();
  for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry, scheduleEngine })) {
    toolRegistry.register(tool);
  }
  const permissionManager = new ToolPermissionManager({
    trustManager,
    allowRules: [
      {
        toolName: "shell",
        inputMatcher: (input) =>
          typeof input === "object" &&
          input !== null &&
          typeof (input as Record<string, unknown>)["command"] === "string" &&
          isSafeBashCommand((input as Record<string, unknown>)["command"] as string),
        reason: "safe shell command",
      },
    ],
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager,
    concurrency: new ConcurrencyController(),
    traceBaseDir: baseDir,
  });
  const approvalQueue = createApprovalQueue();
  const approvalBroker = createTuiApprovalBroker(stateManager);

  let chatRunner: TuiChatSurface | undefined;
  let llmClient: ILLMClient | undefined;
  const providerConfig = await loadProviderConfig();
  try {
    const { SharedManagerTuiChatSurface } = await import("./chat-surface.js");
    const { buildGatewayLLMClient, buildAdapterRegistry } = await import("../../base/llm/provider-factory.js");
    const {
      createNativeChatAgentLoopRunner,
      createNativeReviewAgentLoopRunner,
      shouldUseNativeTaskAgentLoop,
    } = await import("../../orchestrator/execution/agent-loop/index.js");
    const { GoalNegotiator } = await import("../../orchestrator/goal/goal-negotiator.js");
    const { EthicsGate } = await import("../../platform/traits/ethics-gate.js");
    const { ObservationEngine } = await import("../../platform/observation/observation-engine.js");
    const { RuntimeControlService, createDaemonRuntimeControlExecutor } = await import("../../runtime/control/index.js");
    llmClient = await buildGatewayLLMClient(providerConfig);
    for (const tool of createBuiltinTools({
      stateManager,
      trustManager,
      registry: toolRegistry,
      scheduleEngine,
      llmClient,
      daemonClient,
    })) {
      if (!toolRegistry.get(tool.metadata.name)) {
        toolRegistry.register(tool);
      }
    }
    const adapterRegistry = await buildAdapterRegistry(llmClient);
    const observationEngine = new ObservationEngine(stateManager, dataSourceRegistry.getAllSources(), llmClient);
    const ethicsGate = new EthicsGate(stateManager, llmClient);
    const goalNegotiator = new GoalNegotiator(
      stateManager,
      llmClient,
      ethicsGate,
      observationEngine,
      undefined,
      undefined,
      undefined,
      adapterRegistry.getAdapterCapabilities()
    );
    const adapterType = providerConfig.adapter ?? "claude_code_cli";
    const adapter = adapterRegistry.getAdapter(adapterType);
    const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeChatAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;
    const reviewAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeReviewAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;
    const runtimeControlService = new RuntimeControlService({
      runtimeRoot: path.join(stateManager.getBaseDir(), "runtime"),
      stateManager,
      executor: createDaemonRuntimeControlExecutor({ baseDir: stateManager.getBaseDir() }),
    });
    for (const tool of createBuiltinTools({
      stateManager,
      trustManager,
      registry: toolRegistry,
      scheduleEngine,
      llmClient,
      daemonClient,
      runtimeControlService,
    })) {
      if (!toolRegistry.get(tool.metadata.name)) {
        toolRegistry.register(tool);
      }
    }
    chatRunner = new SharedManagerTuiChatSurface({
      stateManager,
      adapter,
      llmClient,
      defaultExecutionSecurity: providerConfig.agent_loop?.security,
      trustManager,
      registry: toolRegistry,
      toolExecutor,
      chatAgentLoopRunner,
      reviewAgentLoopRunner,
      runtimeControlService,
      goalNegotiator,
      daemonClient,
      daemonBaseUrl: `http://127.0.0.1:${daemonPort}`,
      approvalBroker,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getCliLogger().warn(`[pulseed] Daemon-mode ChatRunner init failed — free-form chat disabled: ${message}`);
  }

  return {
    chatRunner,
    llmClient,
    setRequestApproval: approvalQueue.setRequestApproval,
    approvalFn: approvalQueue.enqueueApproval,
    toolExecutor,
  };
}
