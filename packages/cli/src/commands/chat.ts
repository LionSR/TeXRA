import { defineCommand } from 'citty';

import { notifyCliUpdate } from '../runtime/updateChecker';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  optString,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { assertExplicitModelKnown } from './_helpers/modelArg';

export const chatCommand = withUsageSections(
  defineCommand({
    meta: { name: 'chat', description: 'Interactive tool-use chat session' },
    args: {
      ...INTERACTIVE_GLOBAL_ARGS,
      agent: { type: 'string', description: 'Tool-use agent for the session' },
      model: {
        type: 'string',
        alias: 'm',
        description: 'Model for the session',
      },
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'chat');
      const modelOverride = assertExplicitModelKnown(optString(ctx.args.model));
      const context = await contextFromArgs(ctx.args);
      await notifyCliUpdate(context);
      const { runChat } = await import('../chat/tui/runChatTui');
      const result = await runChat(context, {
        agentOverride: optString(ctx.args.agent),
        modelOverride,
      });
      setExitCode(result.exitCode);
    },
  }),
  [
    {
      title: 'INTERACTIVE CONTROLS',
      rows: [
        ['/help', 'show slash commands inside chat'],
        ['/status', 'show session state'],
        ['/login, /logout', 'sign in or out of included access'],
        ['Ctrl-T', 'open the transcript viewer'],
        ['Tab', 'cycle visible streams when subagents are active'],
        ['Esc p', 'open tasks and sub-workflows (Alt-p when configured)'],
        ['Esc s', 'open subagents (Alt-s when configured)'],
        ['Esc 1..9', 'focus a visible stream by number'],
        ['approvals', 'answer tool prompts when --approval-policy=ask'],
        ['Ctrl-C', 'stop the running task or exit from the TUI'],
      ],
    },
  ],
);
