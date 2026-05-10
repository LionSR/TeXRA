#!/usr/bin/env node

// Local imports - CLI commands
import { runCli } from '../commands/root';

const result = await runCli();
process.exitCode = result.exitCode;
