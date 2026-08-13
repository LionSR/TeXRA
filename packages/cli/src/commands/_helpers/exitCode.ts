import { CliExitCode } from '@cli/runtime/exitCodes';

// One CLI invocation per process — module-level pending exit code is the
// simplest way to surface handler exit codes back to `bin/texra.ts` after
// `runCommand` returns. citty's `ctx.data` would also work but is `any`-typed.
let pendingExitCode: number = CliExitCode.Success;

export function setExitCode(code: number): void {
  pendingExitCode = code;
}

export function resetExitCode(): void {
  pendingExitCode = CliExitCode.Success;
}

export function getExitCode(): number {
  return pendingExitCode;
}
