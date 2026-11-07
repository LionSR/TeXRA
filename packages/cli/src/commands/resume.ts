import { CliUsageError } from '../runtime/platform/cliContext';
import { parseCliHistoryId } from '../runtime/history';
import { runResumeCommand } from './resumeRun';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { AGENT_RUN_GLOBAL_ARGS } from './_helpers/globalArgs';
import type { RunId } from '@texra-ai/harness/schemas';

/** The task id `texra resume` was given, refused as a usage error when it
 *  does not parse. `setup` refuses it before the run opens anything. */
function resumeRunId(raw: string): RunId {
  const runId = parseCliHistoryId(raw);
  if (runId === undefined) {
    throw new CliUsageError({ message: `Invalid task id: ${raw}` });
  }
  return runId;
}

// Resume is dual-mode, so it takes the full run flag set: a tool-use task
// reopens the interactive chat, while a workflow run resumes headless like
// `texra run`.
export const resumeCommand = defineCliCommand({
  meta: {
    name: 'resume',
    description: 'Continue a stored task where it stopped',
  },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Task id from `texra history list`',
    },
    fork: {
      type: 'boolean',
      description:
        'Continue a new task holding this conversation, leaving it unchanged',
    },
  },
  setup(ctx) {
    resumeRunId(ctx.args.id);
  },
  // A conversation continues in the service: the platform starts it.
  platform: { startsService: true },
  run: (context, ctx) =>
    runResumeCommand(context, resumeRunId(ctx.args.id), ctx.args.fork === true),
});
