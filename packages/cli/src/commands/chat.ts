import { defineCommand } from 'citty';

import { assertExplicitModelKnown } from '../runtime/runModel';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '../runtime/shortcutLabels';
import { notifyCliUpdate } from '../runtime/updateChecker';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_AGENT_GLOBAL_ARGS,
  optString,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';

const shortcutModifierLabel = defaultShortcutModifierLabel();
const alternateShortcutModifierLabel =
  shortcutModifierLabel === 'Esc' ? 'Alt' : 'Esc';
const focusShortcut = metaChordLabel(shortcutModifierLabel, '1..9');
const alternateFocusShortcut = metaChordLabel(
  alternateShortcutModifierLabel,
  '1..9',
);

export const chatCommand = withUsageSections(
  defineCommand({
    meta: { name: 'chat', description: 'Interactive tool-use chat session' },
    args: {
      ...INTERACTIVE_AGENT_GLOBAL_ARGS,
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
      const context = await contextFromArgs(ctx.args, ctx.rawArgs);
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
        ['/goal', 'explain autonomous goal mode and approved-plan startup'],
        ['/login, /logout', 'sign in or out of ChatGPT or Researcher Access'],
        [
          'Ctrl-T',
          "open the focused stream's full output in a scrollable reader (PgUp/PgDn pages)",
        ],
        ['Tab', 'select a visible child session or process'],
        [
          focusShortcut,
          `focus a visible stream by number (${alternateFocusShortcut} when configured)`,
        ],
        ['approvals', 'answer tool prompts when --approval-policy=ask'],
        ['Ctrl-C', 'stop the running task or exit from the TUI'],
      ],
    },
  ],
);
