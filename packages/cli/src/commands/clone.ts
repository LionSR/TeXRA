// Node imports
import { resolve } from 'node:path';
// Third-party imports
import { Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';

// Internal imports
import { Secrets, type PlatformSecrets } from '@texra-ai/worldline/plugins';
import {
  cloneOverleafProject,
  type OverleafCloneOutcome,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  parseLatexGitUrl,
  type OverleafRemote,
} from '@latex/overleafProject';
import { osPlatformOf } from '@texra/shared/osPlatform';
import { overleafCloneNotice } from '@ui/copy/clone';

// Local imports - runtime
import {
  CliUsageError,
  isQuiet,
  type CliContext,
} from '../runtime/platform/cliContext';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliSecretsLayer } from '../runtime/platform/cliProcessRuntime';
import { askCliQuestion, writeTextStderr } from '../runtime/platform/logSinks';

// Local imports - command helpers
import { cliCommand } from './_helpers/cliCommand';
import { commandResult, writeCliResult } from '../runtime/platform/output';

function buildOverleafClonePorts(
  context: CliContext,
  remote: OverleafRemote,
  secrets: PlatformSecrets,
): OverleafCloneWorkflowPorts {
  return {
    // A credential store this host cannot reach fails the clone with its
    // `SecretsFailed`, which the workflow's `Error` channel carries.
    secrets,
    promptToken: Effect.fn('clone.promptToken')(function* (spec) {
      const tokenGuidance = remote.isOverleaf
        ? `${spec.tokenHint ?? ''} Create or copy a token at ${OVERLEAF_GIT_TOKEN_URL}. Instructions: ${OVERLEAF_TOKEN_DOCS_URL}`.trim()
        : spec.tokenHint;
      if (context.mode !== 'interactive' || context.outputFormat !== 'text') {
        return yield* new CliUsageError({
          message: `No saved ${spec.tokenTitle} is available. ${tokenGuidance ? `${tokenGuidance} ` : ''}Run this command in an interactive terminal to enter and save one.`,
        });
      }
      if (tokenGuidance) writeTextStderr(tokenGuidance);
      const token = yield* askCliQuestion(`${spec.tokenTitle}: `, {
        hidden: true,
      });
      return token.trim() || null;
    }),
    // The terminal prints nothing while git runs; git's own error, if any,
    // follows the outcome line.
    showProgress: (clone) => clone,
  };
}

/** The exit code each outcome but `Cloned` ends the command with. */
const OUTCOME_EXIT_CODE = {
  Cancelled: CliExitCode.Cancelled,
  InvalidToken: CliExitCode.Usage,
  GitMissing: CliExitCode.AgentError,
  WorkspaceUnreadable: CliExitCode.AgentError,
  WorkspaceNotEmpty: CliExitCode.AgentError,
  AuthFailure: CliExitCode.AgentError,
  CloneFailed: CliExitCode.AgentError,
} as const satisfies Record<
  Exclude<OverleafCloneOutcome['_tag'], 'Cloned'>,
  CliExitCode
>;

/** The terminal's own next step after a notice: what to type. */
const NEXT_STEP: Partial<Record<OverleafCloneOutcome['_tag'], string>> = {
  WorkspaceNotEmpty:
    'Create or choose an empty directory, then pass it as the second argument; for example: texra clone 0123456789abcdef01234567 ./project',
  AuthFailure: 'Then rerun the command.',
};

/** Write the clone's outcome and return its exit code (none on success). */
function presentCloneOutcome(
  context: CliContext,
  remote: OverleafRemote,
  outcome: OverleafCloneOutcome,
): CliExitCode | undefined {
  const notice = overleafCloneNotice(
    remote,
    outcome,
    osPlatformOf(process.platform),
  );
  if (outcome._tag === 'Cloned') {
    writeCliResult(
      context.outputFormat,
      commandResult(
        'clone',
        {
          cloned: true,
          provider: remote.isOverleaf ? 'overleaf' : 'sharelatex',
          host: remote.host,
          destination: outcome.destination,
        },
        notice.message,
      ),
    );
    return undefined;
  }
  const next = NEXT_STEP[outcome._tag];
  writeTextStderr(next ? `${notice.message} ${next}` : notice.message);
  for (const link of notice.links)
    writeTextStderr(`${link.label}: ${link.url}`);
  if (notice.gitError !== undefined && !isQuiet(context))
    writeTextStderr(`Git clone error: ${notice.gitError}`);
  return OUTCOME_EXIT_CODE[outcome._tag];
}

export const cloneCommand = cliCommand('clone', {
  description:
    'Clone an Overleaf or ShareLaTeX project into a destination directory',
  config: {
    project: Argument.String('project').pipe(
      Argument.withDescription(
        'Project URL, git URL, or 24-character project ID',
      ),
    ),
    destination: Argument.String('destination').pipe(
      Argument.withDescription(
        'Directory to create or clone into (defaults to the working directory)',
      ),
      Argument.optional,
    ),
  },
  // `clone` runs without a platform: its token ports are the credential
  // store (`Secrets`), and git runs on the Node process services.
  layer: cliSecretsLayer,
  // The project and destination parses run before the runtime is built:
  // they refuse before anything is opened.
  run: (context, input) => {
    const remote = parseLatexGitUrl(input.project);
    if (!remote) {
      throw new CliUsageError({
        message:
          'Invalid Overleaf/ShareLaTeX project. Pass a project URL, git URL, or 24-character project ID.',
      });
    }

    const destination = Option.getOrUndefined(input.destination);
    const workspaceRoot = destination
      ? resolve(context.cwd, destination)
      : context.cwd;

    return Effect.gen(function* () {
      const outcome = yield* cloneOverleafProject(
        remote,
        workspaceRoot,
        buildOverleafClonePorts(context, remote, yield* Secrets),
      );
      return presentCloneOutcome(context, remote, outcome);
    });
  },
}).pipe(
  Command.withExamples([
    {
      command: 'texra clone 0123456789abcdef01234567 ./project',
      description: 'create a directory and clone an Overleaf project into it',
    },
    {
      command:
        'texra clone https://sharelatex.example.edu/project/0123456789abcdef01234567',
      description: 'clone from a self-hosted ShareLaTeX instance',
    },
  ]),
);
