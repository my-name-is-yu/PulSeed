import { spawn } from "child_process";
import { writeTrustedTuiControl } from "./terminal-output.js";

export type ClipboardMethod = "pbcopy" | "xclip" | "xsel" | "tmux" | "osc52";

export interface ClipboardResult {
  ok: boolean;
  method?: ClipboardMethod;
}

function spawnWithStdin(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin.end(text);
  });
}

function writeOsc52(text: string): ClipboardResult {
  const b64 = Buffer.from(text).toString("base64");
  writeTrustedTuiControl(`\u001b]52;c;${b64}\u0007`);
  return { ok: true, method: "osc52" };
}

function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

async function copyToTmux(text: string): Promise<ClipboardResult> {
  if (!isInsideTmux()) {
    return { ok: false };
  }
  const tmuxOk = await spawnWithStdin("tmux", ["load-buffer", "-"], text);
  return tmuxOk ? { ok: true, method: "tmux" } : { ok: false };
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const tmuxResult = await copyToTmux(text);
  if (tmuxResult.ok) return tmuxResult;

  if (process.platform === "darwin") {
    const pbcopyOk = await spawnWithStdin("pbcopy", [], text);
    if (pbcopyOk) return { ok: true, method: "pbcopy" };
    return writeOsc52(text);
  }

  if (process.platform === "linux") {
    const xclipOk = await spawnWithStdin("xclip", ["-selection", "clipboard"], text);
    if (xclipOk) return { ok: true, method: "xclip" };
    const xselOk = await spawnWithStdin("xsel", ["--clipboard", "--input"], text);
    if (xselOk) return { ok: true, method: "xsel" };
    return writeOsc52(text);
  }

  return writeOsc52(text);
}

function readClipboard(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    proc.on("error", () => resolve(""));
    proc.on("close", (code) => resolve(code === 0 ? output : ""));
  });
}

export async function getClipboardContent(): Promise<string> {
  if (process.platform === "darwin") {
    return readClipboard("pbpaste", []);
  }
  if (process.platform === "linux") {
    const result = await readClipboard("xclip", ["-selection", "clipboard", "-o"]);
    if (result) return result;
    return readClipboard("xsel", ["--clipboard", "--output"]);
  }
  return "";
}
