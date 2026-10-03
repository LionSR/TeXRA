import type { RunId } from '@shared/schemas';

import { CliUsageError } from '../runtime/cliContext';
import { parseCliHistoryId } from '../runtime/history';
import { runResumeCommand, type ResumeAction } from './resumeRun';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { AGENT_RUN_GLOBAL_ARGS, optString } from './_helpers/globalArgs';

/** The one view action a resume takes, from its flags, or the refusal. */
function resumeAction(args: {
  readonly fork?: boolean;
  readonly at?: unknown;
  readonly reset?: boolean;
  readonly handoff?: unknown;
}): ResumeAction | undefined {
  const at = optString(args.at);
  const handoff = optString(args.handoff);
  const chosen = [args.fork === true, args.reset === true, handoff].filter(
    Boolean,
  );
  if (chosen.length > 1) {
    throw new CliUsageError(
      'Use at most one of --fork, --reset and --handoff.',
    );
  }
  if (at !== undefined && args.fork !== true) {
    throw new CliUsageError('--at names a fork point: use it with --fork.');
  }
  if (at !== undefined && !/^[1-9]\d*$/.test(at)) {
    throw new CliUsageError(`--at takes a position number, not ${at}.`);
  }
  if (handoff !== undefined && handoff.trim() === '') {
    throw new CliUsageError('--handoff takes the text the task starts from.');
  }
  if (args.fork === true)
    return { kind: 'fork', at: at === undefined ? null : Number(at) };
  if (args.reset === true) return { kind: 'edit', handoff: null };
  if (handoff !== undefined) return { kind: 'edit', handoff };
  return undefined;
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
    at: {
      type: 'string',
      valueHint: 'position',
      description:
        'With --fork: the settled position to fork at (default: the end)',
    },
    reset: {
      type: 'boolean',
      description: "Clear the model's view of the conversation, then continue",
    },
    handoff: {
      type: 'string',
      valueHint: 'text',
      description:
        "Clear the model's view and continue from this text as your message",
    },
  },
  setup(ctx) {
    if (!parseCliHistoryId(ctx.args.id)) {
      throw new CliUsageError(`Invalid task id: ${ctx.args.id}`);
    }
    resumeAction(ctx.args);
  },
  // `setup` refused every id that does not parse, and every flag mix.
  run: (context, ctx) =>
    runResumeCommand(context, ctx.args.id as RunId, resumeAction(ctx.args)),
});
