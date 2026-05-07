import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  captureExecutionDiffArtifacts,
  captureExecutionDiffBaseline,
  type ExecFileSyncFn,
} from "../task-diff-capture.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";

function makeGitWorkspace(): string {
  const workspace = makeTempDir();
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  return workspace;
}

function makeExecFileSync(outputs: Record<string, string>, thrownOutputs: Record<string, string> = {}): ExecFileSyncFn {
  return ((cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in thrownOutputs) {
      const error = new Error("command failed") as Error & { stdout?: string };
      error.stdout = thrownOutputs[key];
      throw error;
    }
    return outputs[key] ?? "";
  }) as ExecFileSyncFn;
}

describe("captureExecutionDiffArtifacts", () => {
  it("uses filesystem diffs for git-ignored disposable workspaces", () => {
    const workspace = makeGitWorkspace();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "contract.json"), "{\"score\":0.1}\n", "utf-8");
      const execFileSyncFn = makeExecFileSync({
        "git check-ignore -- .": ".\n",
      });

      const baseline = captureExecutionDiffBaseline(execFileSyncFn, workspace);
      fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "scripts", "contract-canary.mjs"), "console.log('ok')\n", "utf-8");
      fs.writeFileSync(path.join(workspace, "reports", "contract.json"), "{\"score\":1,\"scenario\":\"fresh\"}\n", "utf-8");
      fs.writeFileSync(path.join(workspace, "reports", "contract.done"), "done\n", "utf-8");

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, { baseline });

      expect(result.evidenceSource).toBe("filesystem_artifact");
      expect(result.changedPaths).toEqual([
        "reports/contract.done",
        "reports/contract.json",
        "scripts/contract-canary.mjs",
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("filters paths that were already dirty in the pre-task baseline", () => {
    const workspace = makeGitWorkspace();
    try {
      let phase: "baseline" | "post" = "baseline";
      const execFileSyncFn: ExecFileSyncFn = ((cmd, args) => {
        const key = `${cmd} ${args.join(" ")}`;
        if (key === "git diff --name-only") {
          return phase === "baseline"
            ? "preexisting.txt\n"
            : "preexisting.txt\ntask-output.txt\n";
        }
        if (key === "git diff --cached --name-only") return "";
        if (key === "git ls-files --others --exclude-standard") return "";
        if (key === "git diff -- preexisting.txt") {
          return "diff --git a/preexisting.txt b/preexisting.txt\n@@ -1 +1 @@\n-clean\n+dirty\n";
        }
        if (key === "git diff -- preexisting.txt task-output.txt" || key === "git diff -- task-output.txt") {
          return [
            "diff --git a/preexisting.txt b/preexisting.txt",
            "@@ -1 +1 @@",
            "-clean",
            "+dirty",
            "diff --git a/task-output.txt b/task-output.txt",
            "@@ -0,0 +1 @@",
            "+task output",
            "",
          ].join("\n");
        }
        return "";
      }) as ExecFileSyncFn;

      const baseline = captureExecutionDiffBaseline(execFileSyncFn, workspace);
      phase = "post";
      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, { baseline });

      expect(baseline.changedPaths).toEqual(["preexisting.txt"]);
      expect(result.changedPaths).toEqual(["task-output.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "task-output.txt",
          patch: expect.stringContaining("+task output"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps further edits to baseline-dirty paths as unsafe to path-restore", () => {
    const workspace = makeGitWorkspace();
    try {
      let phase: "baseline" | "post" = "baseline";
      const execFileSyncFn: ExecFileSyncFn = ((cmd, args) => {
        const key = `${cmd} ${args.join(" ")}`;
        if (key === "git diff --name-only") {
          return "preexisting.txt\n";
        }
        if (key === "git diff --cached --name-only") return "";
        if (key === "git ls-files --others --exclude-standard") return "";
        if (key === "git diff -- preexisting.txt") {
          return phase === "baseline"
            ? "diff --git a/preexisting.txt b/preexisting.txt\n@@ -1 +1 @@\n-clean\n+dirty before task\n"
            : "diff --git a/preexisting.txt b/preexisting.txt\n@@ -1 +1 @@\n-clean\n+dirty before task and task edit\n";
        }
        return "";
      }) as ExecFileSyncFn;

      const baseline = captureExecutionDiffBaseline(execFileSyncFn, workspace);
      phase = "post";
      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, { baseline });

      expect(result.changedPaths).toEqual(["preexisting.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "preexisting.txt",
          patch: expect.stringContaining("dirty before task and task edit"),
          safe_to_revert: false,
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("collects tracked file diffs and changed paths", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync({
        "git diff --name-only": "src/example.ts\n",
        "git ls-files --others --exclude-standard": "",
        "git diff -- src/example.ts": "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      });

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.changedPaths).toEqual(["src/example.ts"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "src/example.ts",
          patch: expect.stringContaining("+new"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("captures untracked file diffs from git diff --no-index output", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync(
        {
          "git diff --name-only": "",
          "git ls-files --others --exclude-standard": "src/new-file.ts\n",
          "git diff -- src/new-file.ts": "",
        },
        {
        "git diff --no-index -- /dev/null src/new-file.ts": "should not be called",
        },
      );
      fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "src/new-file.ts"), "export const created = true;\n", "utf-8");

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.changedPaths).toEqual(["src/new-file.ts"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "src/new-file.ts",
          patch: expect.stringContaining("new file mode 100644"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("batches tracked and staged diff capture instead of reading each path separately", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = vi.fn(makeExecFileSync({
        "git diff --name-only": "src/a.ts\nsrc/b.ts\n",
        "git diff --cached --name-only": "src/c.ts\nsrc/d.ts\n",
        "git ls-files --others --exclude-standard": "",
        "git diff -- src/a.ts src/b.ts": [
          "diff --git a/src/a.ts b/src/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+aa",
          "diff --git a/src/b.ts b/src/b.ts",
          "@@ -1 +1 @@",
          "-b",
          "+bb",
          "",
        ].join("\n"),
        "git diff --cached -- src/c.ts src/d.ts": [
          "diff --git a/src/c.ts b/src/c.ts",
          "@@ -1 +1 @@",
          "-c",
          "+cc",
          "diff --git a/src/d.ts b/src/d.ts",
          "@@ -1 +1 @@",
          "-d",
          "+dd",
          "",
        ].join("\n"),
      }));

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.changedPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
      expect(result.fileDiffs.map((diff) => diff.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
      expect(execFileSyncFn).not.toHaveBeenCalledWith("git", ["diff", "--", "src/a.ts"], expect.any(Object));
      expect(execFileSyncFn).not.toHaveBeenCalledWith("git", ["diff", "--", "src/b.ts"], expect.any(Object));
      expect(execFileSyncFn).not.toHaveBeenCalledWith("git", ["diff", "--cached", "--", "src/c.ts"], expect.any(Object));
      expect(execFileSyncFn).not.toHaveBeenCalledWith("git", ["diff", "--cached", "--", "src/d.ts"], expect.any(Object));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps patches for paths whose names contain git header separators", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync({
        "git diff --name-only": "dir b/file.txt\n",
        "git diff --cached --name-only": "",
        "git ls-files --others --exclude-standard": "",
        "git diff -- dir b/file.txt": [
          "diff --git a/dir b/file.txt b/dir b/file.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
      });

      const baseline = captureExecutionDiffBaseline(execFileSyncFn, workspace);
      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, { baseline: {
        ...baseline,
        pathFingerprints: { "dir b/file.txt": "different baseline patch" },
      } });

      expect(result.changedPaths).toEqual(["dir b/file.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "dir b/file.txt",
          patch: expect.stringContaining("+after"),
          safe_to_revert: false,
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("captures staged file diffs without counting fallback paths as git-backed changes", () => {
    const workspace = makeGitWorkspace();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "clean.md"), "reported by tool\n", "utf-8");
      const execFileSyncFn = makeExecFileSync({
        "git diff --name-only": "",
        "git diff --cached --name-only": "reports/staged.md\n",
        "git ls-files --others --exclude-standard": "",
        "git diff -- reports/staged.md": "",
        "git diff --cached -- reports/staged.md": [
          "diff --git a/reports/staged.md b/reports/staged.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/reports/staged.md",
          "@@ -0,0 +1 @@",
          "+staged output",
          "",
        ].join("\n"),
        "git diff -- reports/clean.md": "",
        "git diff --cached -- reports/clean.md": "",
      });

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, {
        fallbackChangedPaths: ["reports/clean.md", "../outside.md"],
      });

      expect(result.changedPaths).toEqual(["reports/staged.md"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/staged.md",
          patch: expect.stringContaining("+staged output"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("ignores per-path diff read failures after collecting changed paths", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync(
        {
          "git diff --name-only": "src/example.ts\n",
          "git ls-files --others --exclude-standard": "",
        },
        {
          "git diff -- src/example.ts": "",
        },
      );

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.available).toBe(true);
      expect(result.changedPaths).toEqual(["src/example.ts"]);
      expect(result.fileDiffs).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("renders non-git fallback file diffs from concrete changed paths without probing git", () => {
    const workspace = makeTempDir();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "hgb.json"), "{\"score\":0.95}\n", "utf-8");
      const execFileSyncFn = vi.fn(makeExecFileSync({}, {
        "git diff --name-only": "",
        "git ls-files --others --exclude-standard": "",
      }));

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, {
        fallbackChangedPaths: ["reports/hgb.json"],
      });

      expect(result.available).toBe(true);
      expect(result.evidenceSource).toBe("filesystem_artifact");
      expect(result.changedPaths).toEqual(["reports/hgb.json"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/hgb.json",
          patch: expect.stringContaining("+{\"score\":0.95}"),
          safe_to_revert: false,
        }),
      ]);
      expect(execFileSyncFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports filesystem artifact evidence with no changed paths in a non-git workspace", () => {
    const workspace = makeTempDir();
    try {
      const execFileSyncFn = vi.fn(() => {
        throw new Error("git should not be probed for non-git workspace evidence");
      });

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, {
        fallbackChangedPaths: [],
      });

      expect(execFileSyncFn).not.toHaveBeenCalled();
      expect(result.available).toBe(true);
      expect(result.evidenceSource).toBe("filesystem_artifact");
      expect(result.changedPaths).toEqual([]);
      expect(result.fileDiffs).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("omits non-git fallback content when a changed path resolves outside the workspace", () => {
    const workspace = makeTempDir();
    const outside = makeTempDir();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret\n", "utf-8");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "reports", "secret.txt"));

      const result = captureExecutionDiffArtifacts(vi.fn(), workspace, {
        fallbackChangedPaths: ["reports/secret.txt"],
      });

      expect(result.available).toBe(true);
      expect(result.changedPaths).toEqual(["reports/secret.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/secret.txt",
          patch: expect.stringContaining("path resolves outside the workspace"),
        }),
      ]);
      expect(result.fileDiffs[0]?.patch).not.toContain("outside-secret");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
