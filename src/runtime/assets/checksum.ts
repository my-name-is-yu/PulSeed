import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

export async function checksumPath(targetPath: string): Promise<string> {
  const stat = await fsp.stat(targetPath);
  if (stat.isFile()) {
    return `sha256:${await checksumFile(targetPath)}`;
  }
  if (!stat.isDirectory()) {
    throw new Error(`asset checksum target must be a file or directory: ${targetPath}`);
  }

  const files = await listFiles(targetPath);
  const rootHash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(targetPath, file).replace(/\\/g, "/");
    rootHash.update(relative);
    rootHash.update("\0");
    rootHash.update(await checksumFile(file));
    rootHash.update("\0");
  }
  return `sha256:${rootHash.digest("hex")}`;
}

async function checksumFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, found);
  return found.sort((a, b) => a.localeCompare(b));
}

async function walk(dir: string, found: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, found);
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
}
