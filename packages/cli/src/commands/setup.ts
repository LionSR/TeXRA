import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { RESEARCHER_ACCESS_AUTH } from '@ui/copy/accountAuth';

import { CliExitCode } from '../runtime/exitCodes';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import {
  INTERACTIVE_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { type CliContext } from '../runtime/cliContext';

const CREDENTIAL_CHANNEL = 'Setup Credentials';

/** Exported for the test kernel — the command's `run` is the only other caller. */
export async function runSetup(context: CliContext): Promise<number> {
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra setup requires an interactive terminal (TTY stdin and stdout). For scripting, set a provider API key env var (e.g. ANTHROPIC_API_KEY) or run `texra login`.',
        dumbTerminalCommand: 'setup',
      }),
    );
    return CliExitCode.Usage;
  }

  // Always ends in the chat TUI (setup agent) or returns cleanly before it —
  // either way the platform's own handler covers signals until the TUI mounts
  // and takes over. This entry never passes `installSignalHandlers: false`,
  // so that handler stays live through the whole window below (see
  // `initCliPlatform`).
  //
  // State 0 first (.agents/docs/archived/feature/2026-06-11-agent-native-onboarding.md): a credential is the
  // one step no agent can do for the user. With a credential already in place
  // the picker is skipped — credentials-only (re)configuration is
  // `texra login`'s job under the new vocabulary. The init, the read and the
  // picker it may open are one program on the root's runtime.
  const runtime = await installCliProcessRuntime(context.storageRoot, {
    resourcesPath: context.resourcesPath,
    minimumLogLevel: context.minimumLogLevel,
  });
  const credentialed = await runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      // The probe reports failures synchronously; this program logs them.
      const fails: string[] = [];
      const hasCredential = yield* hasUsableSetupCredential(
        services,
        services.secrets,
        (message) => fails.push(message),
      ).pipe(
        Effect.ensuring(Effect.forEach(fails, (m) => Effect.logWarning(m))),
        withLogChannel(CREDENTIAL_CHANNEL),
      );
      if (hasCredential) return true;
      const { runCliOnboarding } = yield* Effect.promise(
        () => import('../onboarding/runOnboarding'),
      );
      return (yield* runCliOnboarding(services, context.stdoutColorEnabled))
        .configured;
    }),
  );
  // Skipped or abandoned the picker: exit cleanly (the skip summary already
  // printed) — there is no credential for the setup agent to run on.
  if (!credentialed) return CliExitCode.Success;
  // Credential present (pre-existing or just configured): the setup agent owns
  // the session — environment checks, agent roster, first task. Same chat
  // startup path as `texra chat`, with the agent pinned. The TUI mounts at
  // this Promise edge rather than inside a fiber of the runtime it outlives.
  const { runChat } = await import('../chat/tui/runChatTui');
  const result = await runChat(context, { agentOverride: SETUP_AGENT_NAME });
  return result.exitCode;
}

export const setupCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'setup',
      description:
        'Guided setup with the setup agent: environment, agent roster, and your first task (sign-in, ChatGPT, or API key first)',
    },
    args: {
      ...INTERACTIVE_GLOBAL_ARGS,
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'setup');
      const context = await contextFromArgs(ctx.args);
      setExitCode(await runSetup(context));
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        ['texra setup', 'agent-led setup: environment, roster, first task'],
        ['texra auth chatgpt login', 'sign in with a ChatGPT subscription'],
        ['texra login', RESEARCHER_ACCESS_AUTH.credentialsOnlyExample],
        ['texra auth status', RESEARCHER_ACCESS_AUTH.statusExample],
      ],
    },
    {
      title: 'NOTES',
      rows: [
        [
          'texra setup',
          "previously only the credential picker — that's `texra login` now",
        ],
      ],
    },
  ],
);
