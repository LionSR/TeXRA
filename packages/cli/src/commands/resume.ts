import { Argument } from 'effect/cli';

import type { RunId } from '@texra-ai/worldline/schemas';

import { CliUsageError } from '../runtime/platform/cliContext';
import { parseCliHistoryId } from '../runtime/history';
import { runResumeCommand } from './resumeRun';

import {
  boolFlag,
  cliCommand,
  SKILL_SOURCES_CONFIG,
} from './_helpers/cliCommand';

/** The task id `texra resume` was given, refused as a usage error when it
 *  does not parse, before the run opens anything. */
function resumeRunId(raw: string): RunId {
  const runId = parseCliHistoryId(raw);
  if (runId === undefined) {
    throw new CliUsageError({ message: `Invalid task id: ${raw}` });
  }
  return runId;
}

// Resume is dual-mode, so it takes the full run flag set: a tool-use task
// reopens the interactive chat, while a document task run resumes headless like
// `texra run`.
export const resumeCommand = cliCommand('resume', {
  description: 'Continue a stored task where it stopped',
  config: {
    ...SKILL_SOURCES_CONFIG,
    id: Argument.String('id').pipe(
      Argument.withDescription('Task id from `texra history list`'),
    ),
    fork: boolFlag(
      'fork',
      'Continue a new task holding this conversation, leaving it unchanged',
    ),
  },
  // A conversation continues in the service: the platform starts it.
  platform: { startsService: true },
  run: (context, input) =>
    runResumeCommand(context, resumeRunId(input.id), input.fork),
});
