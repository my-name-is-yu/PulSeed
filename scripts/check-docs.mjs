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
const productCompletionMatrixPath = 'docs/product/completion-matrix.md';
const productClaimLedgerPath = 'docs/product/claim-ledger.json';
const productClaimLedgerSchemaVersion = 'pulseed-product-claim-ledger/v1';
const productClaimClassifications = new Set([
  'current_operating_behavior',
  'operator_debug_behavior',
  'design_only_or_future_direction',
  'migration_debug_export_config_workspace_boundary',
  'unsupported_overclaim',
]);
const productClaimKinds = new Set([
  'current_behavior',
  'operator_surface',
  'boundary_or_direction',
  'negative_boundary',
]);
const requiredClaimSourceRoots = [
  { label: 'README', matches: (relativePath) => relativePath === 'README.md' },
  { label: 'start docs', matches: (relativePath) => relativePath.startsWith('docs/start/') },
  { label: 'operate docs', matches: (relativePath) => relativePath.startsWith('docs/operate/') },
  { label: 'reference docs', matches: (relativePath) => relativePath.startsWith('docs/reference/') },
  { label: 'product docs', matches: (relativePath) => relativePath.startsWith('docs/product/') },
  { label: 'design docs', matches: (relativePath) => relativePath.startsWith('docs/design/') },
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

checkProductCompletionMatrix(issues);
checkProductClaimLedger(issues);

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

function checkProductCompletionMatrix(issueList) {
  const matrixFilePath = path.join(repoRoot, productCompletionMatrixPath);
  if (!fileExists(matrixFilePath)) {
    issueList.push(formatIssue(productCompletionMatrixPath, 1, 'product-completion scenario matrix is missing'));
    return;
  }

  const content = fs.readFileSync(matrixFilePath, 'utf8');
  if (!content.includes('(claim-ledger.json)')) {
    issueList.push(formatIssue(productCompletionMatrixPath, 1, 'product-completion scenario matrix must link the machine-checkable product claim ledger'));
  }
  if (!content.includes('| Scenario | Class | Current coverage | Product boundary |')) {
    issueList.push(formatIssue(productCompletionMatrixPath, 1, 'product-completion scenario matrix must keep the scenario table contract'));
  }
}

function checkProductClaimLedger(issueList) {
  const ledgerFilePath = path.join(repoRoot, productClaimLedgerPath);
  if (!fileExists(ledgerFilePath)) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, 'product claim ledger is missing'));
    return;
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFilePath, 'utf8'));
  } catch (error) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, `product claim ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, 'product claim ledger must be a JSON object'));
    return;
  }
  if (ledger.schema_version !== productClaimLedgerSchemaVersion) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, `product claim ledger schema_version must be ${productClaimLedgerSchemaVersion}`));
  }
  if (!Array.isArray(ledger.audit_scope) || ledger.audit_scope.length === 0) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, 'product claim ledger audit_scope must list audited doc roots'));
  }
  for (const requiredRoot of ['README.md', 'docs/start', 'docs/operate', 'docs/reference', 'docs/product', 'docs/design']) {
    if (!ledger.audit_scope?.some((entry) => typeof entry === 'string' && (entry === requiredRoot || entry.startsWith(`${requiredRoot}/`)))) {
      issueList.push(formatIssue(productClaimLedgerPath, 1, `product claim ledger audit_scope must include ${requiredRoot}`));
    }
  }
  if (!Array.isArray(ledger.claims) || ledger.claims.length === 0) {
    issueList.push(formatIssue(productClaimLedgerPath, 1, 'product claim ledger must include concrete claims'));
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const seenIds = new Set();
  const seenClassifications = new Set();
  const seenRoots = new Set();

  ledger.claims.forEach((claim, index) => {
    const lineHint = index + 1;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, 'claim entry must be an object'));
      return;
    }
    if (typeof claim.id !== 'string' || claim.id.length === 0) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, 'claim entry is missing id'));
    } else if (seenIds.has(claim.id)) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `duplicate product claim id ${claim.id}`));
    } else {
      seenIds.add(claim.id);
    }
    if (!productClaimClassifications.has(claim.classification)) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} has invalid classification ${String(claim.classification)}`));
    } else {
      seenClassifications.add(claim.classification);
    }
    if (!productClaimKinds.has(claim.claim_kind)) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} has invalid claim_kind ${String(claim.claim_kind)}`));
    }
    if (typeof claim.claim !== 'string' || claim.claim.trim().length === 0) {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} is missing claim text`));
    }

    const source = claim.source;
    if (!source || typeof source !== 'object' || typeof source.path !== 'string' || typeof source.text !== 'string') {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} is missing source.path/source.text`));
    } else {
      const normalizedSource = toPosixPath(source.path);
      const sourcePath = path.join(repoRoot, normalizedSource);
      if (!fileExists(sourcePath)) {
        issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} source file does not exist: ${normalizedSource}`));
      } else {
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        if (!sourceContent.includes(source.text)) {
          issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} source text was not found in ${normalizedSource}`));
        }
      }
      for (const root of requiredClaimSourceRoots) {
        if (root.matches(normalizedSource)) seenRoots.add(root.label);
      }
      if (
        isPublicCurrentDoc(normalizedSource)
        && claim.classification === 'design_only_or_future_direction'
        && claim.claim_kind !== 'boundary_or_direction'
      ) {
        issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} puts a design-only claim in a current doc without boundary_or_direction kind`));
      }
    }

    if (claim.classification === 'unsupported_overclaim' && claim.claim_kind !== 'negative_boundary') {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} unsupported/overclaim entries must be negative_boundary claims`));
    }
    if (claim.claim_kind === 'current_behavior' && claim.classification !== 'current_operating_behavior') {
      issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} current_behavior entries must be classified as current_operating_behavior`));
    }

    const evidenceRefs = claim.evidence_refs;
    if (
      claim.classification === 'current_operating_behavior'
      || claim.classification === 'operator_debug_behavior'
      || claim.classification === 'migration_debug_export_config_workspace_boundary'
    ) {
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} needs machine-checkable evidence_refs`));
      }
    }
    if (Array.isArray(evidenceRefs)) {
      for (const ref of evidenceRefs) {
        const issue = validateEvidenceRef(ref, packageJson);
        if (issue) {
          issueList.push(formatIssue(productClaimLedgerPath, lineHint, `claim ${claim.id ?? index} has invalid evidence ref: ${issue}`));
        }
      }
    }
  });

  for (const classification of productClaimClassifications) {
    if (!seenClassifications.has(classification)) {
      issueList.push(formatIssue(productClaimLedgerPath, 1, `product claim ledger must include classification ${classification}`));
    }
  }
  for (const root of requiredClaimSourceRoots) {
    if (!seenRoots.has(root.label)) {
      issueList.push(formatIssue(productClaimLedgerPath, 1, `product claim ledger must include at least one claim from ${root.label}`));
    }
  }
}

function validateEvidenceRef(ref, packageJson) {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    return 'empty evidence ref';
  }
  if (ref.startsWith('package.json#scripts.')) {
    const scriptName = ref.slice('package.json#scripts.'.length);
    if (!packageJson.scripts || typeof packageJson.scripts[scriptName] !== 'string') {
      return ref;
    }
    return null;
  }

  const [filePart] = ref.split('#', 1);
  const normalized = toPosixPath(filePart);
  if (!fileExists(path.join(repoRoot, normalized))) {
    return ref;
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
