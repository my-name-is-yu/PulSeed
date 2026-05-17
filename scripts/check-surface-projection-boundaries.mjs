#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const normalSurfaceConsumers = [
  "src/interface/chat/chat-runner.ts",
  "src/interface/chat/chat-runner-routes.ts",
  "src/runtime/gateway/chat-session-dispatch.ts",
  "src/runtime/gateway/outbound-conversation.ts",
  "src/runtime/gateway/telegram-gateway-adapter.ts",
  "src/runtime/daemon/runner-resident-proactive.ts",
  "src/runtime/approval-broker.ts",
  "src/reflection/reflection-profile-surface.ts",
];

const requiredFiles = [
  "src/runtime/surface-projection-protocol.ts",
  "src/index.ts",
];

const forbiddenNormalSurfacePatterns = [
  {
    pattern: /\boperatorSourceEventRef\s*\(/,
    message: "normal surfaces must not expose operator/debug source-event refs",
  },
  {
    pattern: /\boperatorRuntimeGraphRef\s*\(/,
    message: "normal surfaces must not expose operator/debug runtime graph refs",
  },
  {
    pattern: /\bview\s*:\s*["']operator_debug["']/,
    message: "normal surface consumers must not project operator_debug views",
  },
  {
    pattern: /\braw_trace_ids_visible\s*:\s*true\b/,
    message: "normal views must not expose raw trace ids",
  },
  {
    pattern: /\braw_evidence_refs_visible\s*:\s*true\b/,
    message: "normal views must not expose raw evidence refs",
  },
  {
    pattern: /\bpolicy_rationale_visible\s*:\s*true\b/,
    message: "normal views must not expose policy rationale internals",
  },
  {
    pattern: /\bmemory_truth_internals_visible\s*:\s*true\b/,
    message: "normal views must not expose memory truth internals",
  },
  {
    pattern: /\bapproval_fingerprints_visible\s*:\s*true\b/,
    message: "normal views must not expose approval fingerprints",
  },
  {
    pattern: /\boperator_refs_visible\s*:\s*true\b/,
    message: "normal views must not expose operator refs",
  },
];

const issues = [];

for (const filePath of requiredFiles) {
  if (!existsSync(filePath)) {
    issues.push(`missing required Surface Projection Protocol file: ${filePath}`);
  }
}

for (const filePath of normalSurfaceConsumers) {
  if (!existsSync(filePath)) {
    issues.push(`missing normal surface consumer: ${filePath}`);
    continue;
  }
  const text = readFileSync(filePath, "utf8");
  if (!text.includes("surface-projection-protocol")) {
    issues.push(`${filePath}: public/user-visible surface changes must flow through surface-projection-protocol`);
  }
  for (const check of forbiddenNormalSurfacePatterns) {
    if (check.pattern.test(text)) {
      issues.push(`${filePath}: ${check.message}`);
    }
  }
}

const publicIndex = existsSync("src/index.ts") ? readFileSync("src/index.ts", "utf8") : "";
for (const exportName of [
  "SurfaceProjectionSchema",
  "SurfaceActionBindingSchema",
  "SurfaceApprovalPromptSchema",
  "SurfaceMemorySummarySchema",
  "UnifiedSurfaceDeliveryProjectionSchema",
  "createSurfaceProjection",
  "validateSurfaceActionBinding",
  "projectMemorySummarySurface",
]) {
  if (!publicIndex.includes(exportName)) {
    issues.push(`src/index.ts is missing Surface Projection Protocol export ${exportName}`);
  }
}

const gatewayDispatch = existsSync("src/runtime/gateway/chat-session-dispatch.ts")
  ? readFileSync("src/runtime/gateway/chat-session-dispatch.ts", "utf8")
  : "";
if (!gatewayDispatch.includes('parsedProjection.data.view === "normal"')) {
  issues.push("src/runtime/gateway/chat-session-dispatch.ts must reject operator/debug projections from gateway session ports");
}

const telegramAdapter = existsSync("src/runtime/gateway/telegram-gateway-adapter.ts")
  ? readFileSync("src/runtime/gateway/telegram-gateway-adapter.ts", "utf8")
  : "";
if (telegramAdapter.includes("getLatestDeliveryForCandidate")) {
  issues.push("src/runtime/gateway/telegram-gateway-adapter.ts must not use candidate-only peer callback lookup for mutations");
}
if (!telegramAdapter.includes("Legacy Telegram peer callback protocol is not a mutation authority")) {
  issues.push("src/runtime/gateway/telegram-gateway-adapter.ts must fail closed for legacy peer callback mutation attempts");
}
if (!telegramAdapter.includes("transportMessageRef: String(messageId)")) {
  issues.push("src/runtime/gateway/telegram-gateway-adapter.ts must validate SurfaceActionBinding transport message refs");
}

const approvalBroker = existsSync("src/runtime/approval-broker.ts")
  ? readFileSync("src/runtime/approval-broker.ts", "utf8")
  : "";
if (!approvalBroker.includes("validateApprovalResolutionBinding")) {
  issues.push("src/runtime/approval-broker.ts must validate SurfaceActionBinding before non-conversational approval resolution");
}

const eventServer = existsSync("src/runtime/event/server.ts")
  ? readFileSync("src/runtime/event/server.ts", "utf8")
  : "";
if (!eventServer.includes("validateEventServerApprovalBinding")) {
  issues.push("src/runtime/event/server.ts direct approval fallback must validate SurfaceActionBinding before resolution");
}

const protocol = existsSync("src/runtime/surface-projection-protocol.ts")
  ? readFileSync("src/runtime/surface-projection-protocol.ts", "utf8")
  : "";
for (const requiredSnippet of [
  "normal SurfaceProjection cannot expose operator/debug refs",
  "operator/debug SurfaceProjection must carry an operator_debug_view",
  "raw_trace_ids_visible: z.literal(false)",
  "approval_fingerprints_visible: z.literal(false)",
  "memory_truth_internals_visible: z.literal(false)",
]) {
  if (!protocol.includes(requiredSnippet)) {
    issues.push(`surface-projection-protocol is missing guard invariant: ${requiredSnippet}`);
  }
}

if (issues.length > 0) {
  console.error("Surface Projection Protocol boundary check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("Surface Projection Protocol boundary check passed.");
