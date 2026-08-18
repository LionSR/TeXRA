import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { parseCliHistoryId } from '../runtime/history';
import { writeTextStderr } from '../runtime/logSinks';
import { runResumeExecution } from './resumeExecution';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { AGENT_RUN_GLOBAL_ARGS } from './_helpers/globalArgs';

// Resume is dual-mode, so it takes the full run flag set: a tool-use session
// reopens the interactive chat, while a workflow run resumes headless like
// `texra run`.
export const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description: 'Continue (resume) a stored tool-use or workflow session',
  },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    const context = await contextFromArgs(ctx.args, ctx.rawArgs);
    setExitCode(await runResumeExecution(context, id));
  },
});
