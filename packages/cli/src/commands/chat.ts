import { Effect, Option } from 'effect';

import { CliUsageError } from '../runtime/platform/cliContext';
import { assertExplicitModelKnown } from '../runtime/models/launchDefaults';
import { interactiveTerminalRejection } from '../runtime/terminal/terminalRequirements';
import { notifyCliUpdate } from '../runtime/platform/updateChecker';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { writeTextStderr } from '../runtime/platform/logSinks';
import {
  projectAgent,
  startOver,
} from '@texra/controllers/session/projectAgent';

import {
  boolFlag,
  cliCommand,
  SKILL_SOURCES_CONFIG,
  modelFlag,
  type CliCommandOptions,
} from './_helpers/cliCommand';

const chatConfig = {
  ...SKILL_SOURCES_CONFIG,
  model: modelFlag(
    "Model for a new conversation (the project's agent keeps its own)",
  ),
  new: boolFlag(
    'new',
    "Start over: a new conversation instead of the project's agent",
  ),
};

/**
 * Where the chat opens: on the project's agent, the conversation recorded
 * as the project's, unless `--new` starts over (the record is cleared,
 * nothing is deleted, and the first message records the new one).
 */
const openChat = Effect.fn('openChat')(function* (
  fresh: boolean,
  modelOverride: string | undefined,
) {
  const session = yield* (yield* cliPlatform).runSession;
  if (fresh) {
    yield* startOver(session.roots);
    return { chat: { modelOverride } };
  }
  const agent = yield* projectAgent(session);
  if (agent === null) return { chat: { modelOverride } };
  // The conversation continues on its own model: a model asked for here is
  // said not to apply, never dropped silently.
  if (modelOverride !== undefined && modelOverride !== agent.config.model)
    writeTextStderr(
      `Note: the project's conversation continues on ${agent.config.model}, not ${modelOverride}; switch with /model, or start over with --new.`,
    );
  return {
    chat: {
      modelOverride,
      initialResume: { id: agent.runId, config: agent.config },
    },
  };
});

/** The chat, which bare `texra` also starts on an interactive terminal. */
export const chatOptions: CliCommandOptions<typeof chatConfig, Error> = {
  description: "Interactive chat, continuing the project's agent",
  config: chatConfig,
  // Every chat is a client of the one service, and shows a store moved
  // aside in its transcript.
  platform: { startsService: true, presentsStoreMovedAside: true },
  // The update check is the program; the session it hands the terminal to
  // is mounted once the check has finished. An unusable terminal is refused
  // here, in the builder, before the runtime is built.
  run: (context, input) => {
    const modelOverride = assertExplicitModelKnown(
      Option.getOrUndefined(input.model),
    );
    // `mode === 'headless'` already covers --print / CI / non-TTY stdin
    // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
    // and `TERM=dumb` strips the cursor controls Ink depends on.
    const terminalRejection = interactiveTerminalRejection(context, 'chat', {
      headlessMessage:
        'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting or piped input, use `texra run`.',
      nonInteractiveFallback: '`texra run`',
    });
    if (terminalRejection)
      throw new CliUsageError({ message: terminalRejection });
    // An update that ran (or was cancelled) is the command's outcome: the
    // next `texra` runs the new version, so no chat mounts.
    return Effect.gen(function* () {
      const code = yield* notifyCliUpdate(context);
      if (code !== undefined) return code;
      return yield* openChat(input.new, modelOverride);
    });
  },
};

export const chatCommand = cliCommand('chat', chatOptions);
