import * as fsp from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import {
  isTextFileSizeLimitError,
  readTextFileWithinLimit,
  readTextFileWithinLimitSync,
} from "../base/utils/json-io.js";
import { PluginManifestSchema, type PluginManifest } from "./types/plugin.js";

export const PLUGIN_MANIFEST_FILENAMES = ["plugin.yaml", "plugin.json"] as const;
export const PLUGIN_MANIFEST_MAX_BYTES = 1024 * 1024;

export type RawPluginManifestReadFailure = "missing" | "read" | "parse";

export type RawPluginManifestReadResult =
  | {
      ok: true;
      filename: typeof PLUGIN_MANIFEST_FILENAMES[number];
      manifestPath: string;
      value: unknown;
    }
  | {
      ok: false;
      failure: RawPluginManifestReadFailure;
      filename?: typeof PLUGIN_MANIFEST_FILENAMES[number];
      manifestPath?: string;
      errorMessage?: string;
    };

export type PluginManifestReadResult =
  | {
      ok: true;
      filename: typeof PLUGIN_MANIFEST_FILENAMES[number];
      manifestPath: string;
      data: PluginManifest;
    }
  | {
      ok: false;
      failure: RawPluginManifestReadFailure | "schema";
      filename?: typeof PLUGIN_MANIFEST_FILENAMES[number];
      manifestPath?: string;
      errorMessage?: string;
      schemaIssues?: Array<{ path: Array<string | number>; message: string }>;
    };

export async function readRawPluginManifest(pluginDir: string): Promise<RawPluginManifestReadResult> {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const manifestPath = path.join(pluginDir, filename);
    let content: string;
    try {
      content = await readTextFileWithinLimit(manifestPath, { maxBytes: PLUGIN_MANIFEST_MAX_BYTES });
    } catch (err) {
      if (isNotFoundError(err)) continue;
      if (isTextFileSizeLimitError(err)) {
        return {
          ok: false,
          failure: "parse",
          filename,
          manifestPath,
          errorMessage: oversizedManifestErrorMessage(filename),
        };
      }
      return {
        ok: false,
        failure: "read",
        filename,
        manifestPath,
        errorMessage: errorMessage(err),
      };
    }

    try {
      return {
        ok: true,
        filename,
        manifestPath,
        value: parsePluginManifestContent(filename, content),
      };
    } catch (err) {
      return {
        ok: false,
        failure: "parse",
        filename,
        manifestPath,
        errorMessage: errorMessage(err),
      };
    }
  }

  return { ok: false, failure: "missing" };
}

export function readRawPluginManifestSync(pluginDir: string): RawPluginManifestReadResult {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const manifestPath = path.join(pluginDir, filename);
    let content: string;
    try {
      content = readTextFileWithinLimitSync(manifestPath, { maxBytes: PLUGIN_MANIFEST_MAX_BYTES });
    } catch (err) {
      if (isNotFoundError(err)) continue;
      if (isTextFileSizeLimitError(err)) {
        return {
          ok: false,
          failure: "parse",
          filename,
          manifestPath,
          errorMessage: oversizedManifestErrorMessage(filename),
        };
      }
      return {
        ok: false,
        failure: "read",
        filename,
        manifestPath,
        errorMessage: errorMessage(err),
      };
    }

    try {
      return {
        ok: true,
        filename,
        manifestPath,
        value: parsePluginManifestContent(filename, content),
      };
    } catch (err) {
      return {
        ok: false,
        failure: "parse",
        filename,
        manifestPath,
        errorMessage: errorMessage(err),
      };
    }
  }

  return { ok: false, failure: "missing" };
}

export async function readPluginManifest(pluginDir: string): Promise<PluginManifestReadResult> {
  return validateRawPluginManifest(await readRawPluginManifest(pluginDir));
}

export function readPluginManifestSync(pluginDir: string): PluginManifestReadResult {
  return validateRawPluginManifest(readRawPluginManifestSync(pluginDir));
}

export async function hasPluginManifestFile(pluginDir: string): Promise<boolean> {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    try {
      await fsp.access(path.join(pluginDir, filename));
      return true;
    } catch (err) {
      if (!isNotFoundError(err)) return true;
    }
  }
  return false;
}

function validateRawPluginManifest(raw: RawPluginManifestReadResult): PluginManifestReadResult {
  if (!raw.ok) return raw;

  const parsed = PluginManifestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return {
      ok: false,
      failure: "schema",
      filename: raw.filename,
      manifestPath: raw.manifestPath,
      errorMessage: parsed.error.message,
      schemaIssues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  return {
    ok: true,
    filename: raw.filename,
    manifestPath: raw.manifestPath,
    data: parsed.data,
  };
}

function parsePluginManifestContent(
  filename: typeof PLUGIN_MANIFEST_FILENAMES[number],
  content: string
): unknown {
  if (filename === "plugin.yaml") {
    return yaml.load(content, { schema: yaml.JSON_SCHEMA }) as unknown;
  }
  return JSON.parse(content) as unknown;
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function oversizedManifestErrorMessage(filename: typeof PLUGIN_MANIFEST_FILENAMES[number]): string {
  return `${filename} exceeds the manifest parse limit; limit is ${PLUGIN_MANIFEST_MAX_BYTES} bytes`;
}
