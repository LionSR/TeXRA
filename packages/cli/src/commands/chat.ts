import { defineCommand } from 'citty';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  optString,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { assertExplicitModelKnown } from './_helpers/modelArg';

export const chatCommand = defineCommand({
  meta: { name: 'chat', description: 'Interactive tool-use chat session' },
  args: {
    ...INTERACTIVE_GLOBAL_ARGS,
    agent: { type: 'string', description: 'Tool-use agent for the session' },
    model: { type: 'string', alias: 'm', description: 'Model for the session' },
  },
  async run(ctx) {
    rejectHeadlessOnlyFlags(ctx.rawArgs, 'chat');
    const modelOverride = assertExplicitModelKnown(optString(ctx.args.model));
    const context = await contextFromArgs(ctx.args);
    const { runChat } = await import('../chat/tui/runChatTui');
    const result = await runChat(context, {
      agentOverride: optString(ctx.args.agent),
      modelOverride,
    });
    setExitCode(result.exitCode);
  },
});
