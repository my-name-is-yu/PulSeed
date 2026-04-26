import type { VerificationSignal } from "./contracts.js";

export function parseVerificationSignal(raw: string): VerificationSignal {
  const undefinedMatch = raw.match(/Cannot find name ['"`]?([A-Za-z_$][\w$]*)['"`]?|([A-Za-z_$][\w$]*)\s+is not defined|is not defined:\s*([A-Za-z_$][\w$]*)/);
  if (undefinedMatch) {
    return { kind: "undefined_symbol", symbol: undefinedMatch[1] ?? undefinedMatch[2] ?? undefinedMatch[3], raw };
  }

  const typeMatch = raw.match(/(?<file>[\w@./-]+\.(?:ts|tsx)):(?<line>\d+):\d+.*(?:TS\d+|Type ')/);
  if (typeMatch?.groups) {
    return {
      kind: "type_error",
      file: typeMatch.groups.file,
      line: Number(typeMatch.groups.line),
      raw,
    };
  }

  const packageMatch = raw.match(/Cannot find module ['"`]([^'"`]+)['"`]|ERR_MODULE_NOT_FOUND.*['"`]([^'"`]+)['"`]/);
  if (packageMatch) {
    const specifier = packageMatch[1] ?? packageMatch[2];
    return { kind: "package_import_error", specifier, packageName: specifier?.split("/")[0], raw };
  }

  const lintMatch = raw.match(/(?<file>[\w@./-]+\.(?:ts|tsx|js|jsx)).*(?<rule>@?[\w/-]+)$/m);
  if (lintMatch?.groups && /eslint|lint/i.test(raw)) {
    return { kind: "lint_error", file: lintMatch.groups.file, rule: lintMatch.groups.rule, raw };
  }

  if (/^\s*at\s+.+:\d+:\d+/m.test(raw)) {
    return { kind: "runtime_stacktrace", stacktrace: raw, raw };
  }

  const testMatch = raw.match(/(?:FAIL|FAILED|AssertionError).*?(?<file>[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?)?/s);
  if (testMatch) {
    return { kind: "failing_test", testFile: testMatch.groups?.file, assertion: raw.split("\n").find((line) => /Expected|Received|Assertion/i.test(line)), raw };
  }

  return { kind: "failing_test", raw, assertion: raw.slice(0, 240) };
}
