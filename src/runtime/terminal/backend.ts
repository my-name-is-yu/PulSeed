import * as path from "node:path";

export type TerminalBackendType = "local" | "docker";

export interface DockerTerminalBackendConfig {
  image: string;
  workdir?: string;
  network?: "none" | "host" | "bridge";
  env?: Record<string, string>;
  volumes?: string[];
}

export interface TerminalBackendConfig {
  type: TerminalBackendType;
  docker?: DockerTerminalBackendConfig;
}

export interface TerminalCommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinData?: string;
}

export interface ResolvedTerminalCommandSpec extends TerminalCommandSpec {
  backend: TerminalBackendType;
}

const DEFAULT_CONTAINER_WORKDIR = "/workspace";

export function resolveTerminalBackendConfig(
  config: TerminalBackendConfig | undefined
): TerminalBackendConfig {
  if (!config) return { type: "local" };
  if (config.type === "local") return { type: "local" };
  if (!config.docker?.image?.trim()) {
    throw new Error("terminal backend docker.image is required when type is docker");
  }
  return {
    type: "docker",
    docker: {
      image: config.docker.image,
      workdir: config.docker.workdir ?? DEFAULT_CONTAINER_WORKDIR,
      network: config.docker.network ?? "none",
      env: config.docker.env,
      volumes: config.docker.volumes,
    },
  };
}

export function wrapTerminalCommand(
  spec: TerminalCommandSpec,
  backendConfig: TerminalBackendConfig | undefined
): ResolvedTerminalCommandSpec {
  const backend = resolveTerminalBackendConfig(backendConfig);
  if (backend.type === "local") {
    return { ...spec, backend: "local" };
  }

  const docker = backend.docker!;
  const hostCwd = path.resolve(spec.cwd ?? process.cwd());
  const containerWorkdir = docker.workdir ?? DEFAULT_CONTAINER_WORKDIR;
  const args = [
    "run",
    "--rm",
    "-i",
    "--network",
    docker.network ?? "none",
    "-v",
    `${hostCwd}:${containerWorkdir}`,
    "-w",
    containerWorkdir,
  ];

  for (const volume of docker.volumes ?? []) {
    args.push("-v", volume);
  }
  for (const [key, value] of Object.entries(docker.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(docker.image, spec.command, ...spec.args);

  return {
    command: "docker",
    args,
    env: spec.env,
    stdinData: spec.stdinData,
    backend: "docker",
  };
}
