import path from "node:path";

export function teeWrapperArgs(
  command: string,
  args: string[],
  logPath: string,
  metricsPath: string,
  reportPath: string,
  nextActionPath: string,
  experimentId: string,
  competition: string,
): string[] {
  const script = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
const logPath = process.argv[3];
const childProcessPath = process.argv[4];
const metricsPath = process.argv[5];
const reportPath = process.argv[6];
const nextActionPath = process.argv[7];
const experimentId = process.argv[8];
const competition = process.argv[9];
const workspaceRoot = path.dirname(path.dirname(path.dirname(logPath)));
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.createWriteStream(logPath, { flags: "a" });
const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
fs.writeFileSync(childProcessPath, JSON.stringify({ pid: child.pid, command, args, startedAt: new Date().toISOString() }, null, 2));
let exiting = false;
const write = (stream, chunk) => {
  stream.write(chunk);
  log.write(chunk);
};
const forwardSignal = (signal) => {
  if (exiting) return;
  exiting = true;
  if (child.exitCode === null && !child.killed) {
    child.kill(signal);
  }
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => forwardSignal(signal));
}
child.stdout.on("data", (chunk) => write(process.stdout, chunk));
child.stderr.on("data", (chunk) => write(process.stderr, chunk));
child.on("error", (err) => {
  const msg = "[kaggle experiment process error] " + err.message + "\\n";
  process.stderr.write(msg);
  log.write(msg);
});
child.on("exit", (code, signal) => {
  writeCompletionArtifacts(code, signal);
  const msg = "[kaggle experiment exited code=" + (code ?? "null") + " signal=" + (signal ?? "null") + "]\\n";
  log.write(msg, () => process.exit(code ?? 1));
});

function writeCompletionArtifacts(code, signal) {
  const observedAt = new Date().toISOString();
  const metrics = readMetricsArtifact();
  const metric = extractMetric(metrics.value);
  const exitOk = code === 0 && !signal;
  const status = metrics.value && typeof metrics.value.status === "string"
    ? metrics.value.status
    : exitOk ? "completed" : "failed";
  const report = renderReport({
    observedAt,
    code,
    signal,
    status,
    metrics,
    metric,
  });
  const nextAction = buildNextAction({
    observedAt,
    code,
    signal,
    status,
    metrics,
    metric,
  });
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, report, "utf-8");
    fs.writeFileSync(nextActionPath, JSON.stringify(nextAction, null, 2) + "\\n", "utf-8");
  } catch (err) {
    const msg = "[kaggle experiment artifact error] " + err.message + "\\n";
    process.stderr.write(msg);
    log.write(msg);
  }
}

function readMetricsArtifact() {
  try {
    const raw = fs.readFileSync(metricsPath, "utf-8");
    return { available: true, value: JSON.parse(raw), error: null };
  } catch (err) {
    return { available: false, value: null, error: err.message };
  }
}

function extractMetric(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metricName = firstString(value.metric_name)
    || firstNumericMetricName(value.all_metrics)
    || (isFiniteNumber(value.balanced_accuracy) ? "balanced_accuracy" : null)
    || (isFiniteNumber(value.accuracy) ? "accuracy" : null);
  if (!metricName) return null;
  const score = firstNumber(value.cv_score, value.metric_value, value.score, value[metricName], value.all_metrics && value.all_metrics[metricName]);
  if (score === null) return null;
  const direction = normalizeDirection(firstString(value.direction) || firstString(value.metric_direction), metricName);
  return { metric_name: metricName, score, direction };
}

function renderReport(info) {
  const lines = [
    "# Kaggle Experiment " + experimentId,
    "",
    "- Competition: " + competition,
    "- Status: " + info.status,
    "- Exit: code=" + (info.code ?? "null") + " signal=" + (info.signal ?? "null"),
    "- Observed at: " + info.observedAt,
    "- Log: " + relativePath(logPath),
    "- Metrics: " + relativePath(metricsPath),
  ];
  if (info.metric) {
    lines.push("- Metric: " + info.metric.metric_name + "=" + info.metric.score + " (" + info.metric.direction + ")");
  } else if (info.metrics.error) {
    lines.push("- Metric: unavailable (" + info.metrics.error + ")");
  } else {
    lines.push("- Metric: unavailable");
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push(nextActionSummary(info));
  lines.push("");
  lines.push("## Artifacts");
  lines.push("- train.log");
  lines.push("- metrics.json" + (info.metrics.available ? "" : " (missing or invalid)"));
  lines.push("- next-action.json");
  return lines.join("\\n") + "\\n";
}

function buildNextAction(info) {
  const actionType = info.metric && info.status === "completed" ? "compare_experiment" : "investigate_run";
  return {
    schema_version: "long-running-next-action-v1",
    created_at: info.observedAt,
    source: {
      kind: "kaggle_experiment",
      experiment_id: experimentId,
      competition,
    },
    observation: {
      status: info.status,
      exit_code: info.code,
      signal: info.signal,
      metric: info.metric,
      artifacts: {
        log: relativePath(logPath),
        metrics: relativePath(metricsPath),
        report: relativePath(reportPath),
      },
      metrics_error: info.metrics.error,
    },
    action: {
      type: actionType,
      summary: nextActionSummary(info),
      candidate_tools: actionType === "compare_experiment"
        ? ["kaggle_metric_report", "kaggle_compare_experiments"]
        : ["kaggle_experiment_read"],
    },
  };
}

function nextActionSummary(info) {
  if (info.metric && info.status === "completed") {
    return "Compare " + experimentId + " using " + info.metric.metric_name + " before deciding on another run or submission preparation.";
  }
  if (info.metrics.error) {
    return "Inspect train.log and restore a readable metrics.json before comparing experiments.";
  }
  return "Inspect train.log and metrics.json before planning the next run.";
}

function relativePath(target) {
  return path.relative(workspaceRoot, target).split(path.sep).join("/");
}

function firstString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

function firstNumericMetricName(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["balanced_accuracy", "accuracy", "macro_f1", "weighted_f1", "log_loss", "rmse"]) {
    if (isFiniteNumber(value[key])) return key;
  }
  for (const [key, field] of Object.entries(value)) {
    if (isFiniteNumber(field)) return key;
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function inferDirection(metricName) {
  return metricName === "rmse" || metricName === "log_loss" ? "minimize" : "maximize";
}

function normalizeDirection(value, metricName) {
  if (value === "maximize" || value === "higher" || value === "higher_is_better" || value === "greater_is_better") return "maximize";
  if (value === "minimize" || value === "lower" || value === "lower_is_better" || value === "less_is_better") return "minimize";
  return inferDirection(metricName);
}
`;
  const childProcessPath = path.join(path.dirname(logPath), "child-process.json");
  return ["-e", script, command, JSON.stringify(args), logPath, childProcessPath, metricsPath, reportPath, nextActionPath, experimentId, competition];
}
