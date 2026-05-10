#!/usr/bin/env node

// Local imports - CLI commands
import { runCli } from '../commands/root';
import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';

try {
  const result = await runCli();
  process.exitCode = result.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeTextStderr(`TeXRA CLI failed: ${message}`);
  process.exitCode = CliExitCode.AgentError;
}
