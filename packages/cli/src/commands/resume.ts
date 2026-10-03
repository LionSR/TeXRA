import type { RunId } from '@shared/schemas';

import { CliUsageError } from '../runtime/cliContext';
import { parseCliHistoryId } from '../runtime/history';
import { runResumeCommand } from './resumeRun';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { AGENT_RUN_GLOBAL_ARGS } from './_helpers/globalArgs';

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
  },
  setup(ctx) {
    if (!parseCliHistoryId(ctx.args.id)) {
      throw new CliUsageError(`Invalid task id: ${ctx.args.id}`);
    }
  },
  // `setup` refused every id that does not parse.
  run: (context, ctx) => runResumeCommand(context, ctx.args.id as RunId),
});
