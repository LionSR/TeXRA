import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { parseCliHistoryId } from '../runtime/history';
import { writeTextStderr } from '../runtime/logSinks';
import { runResumeExecution } from './resumeExecution';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';

export const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description: 'Continue (resume) a stored tool-use session',
  },
  args: {
    ...INTERACTIVE_GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    rejectHeadlessOnlyFlags(ctx.rawArgs, 'resume');
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runResumeExecution(context, id));
  },
});
