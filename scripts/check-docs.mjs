#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ignoredDirNames = new Set([
  'node_modules',
  '.git',
  '.next',
  '.claude',
  '.claire',
  '.pulseed',
  'coverage',
  'coverage-c8',
  'dist',
  'memory',
  'web',
]);
const ignoredRelativeDirs = new Set(['docs/archive']);
const ignoredFileNames = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json']);
const publicCurrentFiles = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'docs/index.md',
  'docs/start/index.md',
  'docs/start/guide.md',
  'docs/concepts/index.md',
  'docs/concepts/mechanism.md',
  'docs/operate/runtime.md',
  'docs/operate/configuration.md',
  'docs/operate/status.md',
  'docs/architecture/index.md',
  'docs/architecture/architecture-map.md',
  'docs/architecture/module-map.md',
]);
const publicCurrentDirs = [
  'docs/start/',
  'docs/operate/',
  'docs/concepts/',
  'docs/architecture/',
  'docs/reference/',
];
const retiredThinDocPaths = new Set([
  'docs/getting-started.md',
  'docs/guide.md',
  'docs/concepts.md',
  'docs/runtime.md',
  'docs/mechanism.md',
  'docs/configuration.md',
  'docs/status.md',
  'docs/architecture.md',
  'docs/architecture-map.md',
  'docs/module-map.md',
  'docs/positioning.md',
  'docs/roadmap.md',
  'docs/usecase.md',
  'docs/vision.md',
  'docs/guide/index.md',
  'docs/internal/index.md',
]);
const retiredThinDocDirs = new Set([
  'docs/guide',
  'docs/internal',
  'docs/design/audits/docs-audit',
  'docs/design/archive/design',
]);
const docsWithRequiredStatus = [
  {
    label: 'product-design document',
    matches: (relativePath) => relativePath.startsWith('docs/product/') && relativePath !== 'docs/product/index.md',
  },
  {
    label: 'design document',
    matches: (relativePath) =>
      [
        'docs/design/core/',
        'docs/design/execution/',
        'docs/design/goal/',
        'docs/design/infrastructure/',
        'docs/design/knowledge/',
        'docs/design/personality/',
      ].some((dir) => relativePath.startsWith(dir)) && relativePath.endsWith('.md'),
  },
  {
    label: 'archived design note',
    matches: (relativePath) =>
      relativePath.startsWith('docs/design/archive/') &&
      relativePath !== 'docs/design/archive/index.md',
  },
];
const stagingTermPatterns = [
  /\bMVP\b/,
  /\bminimum viable product\b/i,
  /\bphase(?:\s+|-)(?:[0-9]+|[A-Z])\b/i,
  /\b[0-9]+\s+phases\b/i,
  /\bphases\s+[A-Z](?:[-–][A-Z])?\b/i,
  /\bimplementation\s+road\s*map\b/i,
  /\broad\s*map\b/i,
  /\bimplementation phases\b/i,
  /\bfirst[-\s]+delivery\b/i,
  /\blater lanes\b/i,
  /\bimplementation lanes\b/i,
  /\bfuture lanes\b/i,
  /\bmerge order recommendation\b/i,
  /\bfuture phase\b/i,
  /\bwave\s*[0-9]+\b/i,
  /\bstage\s*14[A-Z-]*\b/i,
];

const markdownFiles = collectMarkdownFiles(repoRoot);
const issues = [];

for (const retiredDir of retiredThinDocDirs) {
  if (directoryExists(path.join(repoRoot, retiredDir))) {
    issues.push(formatIssue(retiredDir, 1, 'retired thin docs directory was recreated; link to the flattened page instead'));
  }
}

for (const filePath of markdownFiles) {
  const relativePath = toPosixPath(path.relative(repoRoot, filePath) || path.basename(filePath));
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  if (retiredThinDocPaths.has(relativePath)) {
    issues.push(formatIssue(relativePath, 1, 'retired thin docs path was recreated; link to the flattened page instead'));
  }

  for (const rule of docsWithRequiredStatus) {
    if (rule.matches(relativePath) && !hasStatusBanner(lines)) {
      issues.push(formatIssue(relativePath, 1, `${rule.label} is missing a '> Status:' banner near the top`));
    }
  }

  const fenceState = {
    inFence: false,
    fenceChar: null,
    fenceLength: 0,
    openingLine: 0,
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      const fenceChar = marker[0];
      const fenceLength = marker.length;

      if (!fenceState.inFence) {
        fenceState.inFence = true;
        fenceState.fenceChar = fenceChar;
        fenceState.fenceLength = fenceLength;
        fenceState.openingLine = lineNumber;
        continue;
      }

      if (fenceChar === fenceState.fenceChar && fenceLength >= fenceState.fenceLength) {
        fenceState.inFence = false;
        fenceState.fenceChar = null;
        fenceState.fenceLength = 0;
        fenceState.openingLine = 0;
        continue;
      }
    }

    if (fenceState.inFence) {
      continue;
    }

    if (trimmedStart.includes('<<<<<<<') || trimmedStart.includes('=======') || trimmedStart.includes('>>>>>>>')) {
      issues.push(formatIssue(relativePath, lineNumber, 'unresolved merge conflict marker'));
    }

    const markdownLine = stripInlineCode(line);

    if (relativePath.startsWith('docs/')) {
      for (const retiredPath of retiredThinDocPaths) {
        if (line.includes(retiredPath)) {
          issues.push(formatIssue(relativePath, lineNumber, `retired docs path reference '${retiredPath}' should point to the current section path`));
        }
      }

      for (const pattern of stagingTermPatterns) {
        if (pattern.test(markdownLine)) {
          issues.push(formatIssue(relativePath, lineNumber, 'docs should describe design/spec behavior, not MVP or phased implementation staging'));
        }
      }
    }

    for (const target of findMarkdownLinkTargets(markdownLine)) {
      const normalizedTarget = normalizeMarkdownTarget(target);
      if (!normalizedTarget) {
        continue;
      }

      const resolvedPath = path.resolve(path.dirname(filePath), normalizedTarget);
      if (!fileExists(resolvedPath)) {
        issues.push(formatIssue(relativePath, lineNumber, `missing Markdown link target: ${normalizedTarget}`));
        continue;
      }

      const targetRelativePath = toPosixPath(path.relative(repoRoot, resolvedPath));
      const boundaryIssue = getPublicBoundaryIssue(relativePath, targetRelativePath);
      if (boundaryIssue) {
        issues.push(formatIssue(relativePath, lineNumber, boundaryIssue));
      }
    }
  }

  if (fenceState.inFence && fenceState.fenceChar === '`') {
    issues.push(formatIssue(relativePath, fenceState.openingLine, 'unbalanced triple-backtick fence'));
  }
}

if (issues.length > 0) {
  console.error('docs check failed:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log(`docs check passed: scanned ${markdownFiles.length} Markdown files.`);
}

function collectMarkdownFiles(rootDir) {
  const results = [];
  walk(rootDir, results);
  return results.sort((a, b) => a.localeCompare(b));
}

function walk(currentDir, results) {
  const relativeDir = toPosixPath(path.relative(repoRoot, currentDir));
  if (ignoredRelativeDirs.has(relativeDir)) {
    return;
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name) || entry.name.startsWith('.dist-delete-')) {
        continue;
      }
      walk(path.join(currentDir, entry.name), results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (ignoredFileNames.has(entry.name) || !entry.name.endsWith('.md')) {
      continue;
    }

    results.push(path.join(currentDir, entry.name));
  }
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

function findMarkdownLinkTargets(line) {
  const targets = [];

  for (const match of line.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    targets.push(match[1]);
  }

  const referenceMatch = line.match(/^ {0,3}\[[^\]]+\]:\s*(.+)$/);
  if (referenceMatch) {
    targets.push(referenceMatch[1]);
  }

  return targets;
}

function normalizeMarkdownTarget(rawTarget) {
  const target = rawTarget.trim();
  if (!target) {
    return null;
  }

  if (target.startsWith('#')) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target) || target.startsWith('//')) {
    return null;
  }

  if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
    return null;
  }

  const destination = target.replace(/["'].*$/, '').trim();
  const angleBracketMatch = destination.match(/^<(.+)>$/);
  const cleaned = angleBracketMatch ? angleBracketMatch[1].trim() : destination;
  const pathPart = cleaned.split(/[?#]/, 1)[0].trim();

  if (!pathPart || !pathPart.toLowerCase().endsWith('.md')) {
    return null;
  }

  return pathPart;
}

function hasStatusBanner(lines) {
  return lines.slice(0, 8).some((line) => line.startsWith('> Status:'));
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isPublicCurrentDoc(relativePath) {
  if (publicCurrentFiles.has(relativePath)) {
    return true;
  }

  return publicCurrentDirs.some((dir) => relativePath.startsWith(dir));
}

function getPublicBoundaryIssue(sourceRelativePath, targetRelativePath) {
  if (!isPublicCurrentDoc(sourceRelativePath)) {
    return null;
  }

  if (targetRelativePath.startsWith('docs/design/archive/')) {
    return `current operating doc links directly to archived design material: ${targetRelativePath}`;
  }

  if (
    targetRelativePath.startsWith('docs/design/') &&
    targetRelativePath !== 'docs/design/index.md'
  ) {
    return `current operating doc links directly to a design document instead of the design index: ${targetRelativePath}`;
  }

  return null;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function formatIssue(relativePath, lineNumber, message) {
  return `${relativePath}:${lineNumber} ${message}`;
}
