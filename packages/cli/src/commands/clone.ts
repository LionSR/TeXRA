// Node imports
import { resolve } from 'node:path';
// Third-party imports
import { Effect } from 'effect';

// Internal imports
import { Secrets, type PlatformSecrets } from '@texra-ai/harness/plugins';
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
import { installAdvice } from '@texra/shared/constants/latexToolchain';
import { osPlatformOf } from '@texra/shared/osPlatform';
import { CLONE_COPY, cloneProviderLabel } from '@ui/copy/clone';

// Local imports - runtime
import { CliUsageError, type CliContext } from '../runtime/platform/cliContext';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliSecretsLayer } from '../runtime/platform/cliProcessRuntime';
import { askCliQuestion, writeTextStderr } from '../runtime/platform/logSinks';

// Local imports - command helpers
import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { commandResult, writeCliResult } from './_helpers/output';

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

/** Write the clone's outcome and return its exit code (none on success). */
function presentCloneOutcome(
  context: CliContext,
  remote: OverleafRemote,
  workspaceRoot: string,
  outcome: OverleafCloneOutcome,
): CliExitCode | undefined {
  const gitError = (error: string) => {
    if (!context.quietLogs) writeTextStderr(`Git clone error: ${error}`);
  };
  switch (outcome._tag) {
    case 'Cloned': {
      const label = cloneProviderLabel(remote);
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
          `${label} project cloned into ${outcome.destination}.`,
        ),
      );
      return undefined;
    }
    case 'Cancelled':
      writeTextStderr(CLONE_COPY.cancelled);
      return CliExitCode.Cancelled;
    case 'InvalidToken':
      writeTextStderr(outcome.message);
      writeTextStderr(`Token instructions: ${OVERLEAF_TOKEN_DOCS_URL}`);
      return CliExitCode.Usage;
    case 'GitMissing':
      writeTextStderr(
        `Git is not installed or is not on PATH.\n\n${
          installAdvice('Git', ['git'], osPlatformOf(process.platform)).guide
        }`,
      );
      return CliExitCode.AgentError;
    case 'WorkspaceUnreadable':
      writeTextStderr(`Cannot read destination directory: ${outcome.message}`);
      return CliExitCode.AgentError;
    case 'WorkspaceNotEmpty':
      writeTextStderr(
        `The destination directory ${workspaceRoot} is not empty. Create or choose an empty directory, then pass it as the second argument; for example: texra clone 0123456789abcdef01234567 ./project`,
      );
      return CliExitCode.AgentError;
    case 'AuthFailure': {
      const detail = remote.isOverleaf
        ? `Generate a new token at ${OVERLEAF_GIT_TOKEN_URL}, then rerun the command.`
        : 'Check the ShareLaTeX credentials for this host, then rerun the command.';
      writeTextStderr(`${CLONE_COPY.authFailed} ${detail}`);
      gitError(outcome.error);
      return CliExitCode.AgentError;
    }
    case 'CloneFailed':
      writeTextStderr(CLONE_COPY.failed);
      gitError(outcome.error);
      return CliExitCode.AgentError;
  }
}

export const cloneCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'clone',
      description:
        'Clone an Overleaf or ShareLaTeX project into a destination directory',
    },
    args: {
      project: {
        type: 'positional',
        required: true,
        description: 'Project URL, git URL, or 24-character project ID',
      },
      destination: {
        type: 'positional',
        required: false,
        description:
          'Directory to create or clone into (defaults to the working directory)',
      },
    },
    // `clone` runs without a platform: its token ports are the credential
    // store (`Secrets`), and git runs on the Node process services.
    layer: cliSecretsLayer,
    // The project and destination parses are the builder's, above the
    // program: they refuse before anything is built.
    run: (context, ctx) => {
      const remote = parseLatexGitUrl(ctx.args.project);
      if (!remote) {
        throw new CliUsageError({
          message:
            'Invalid Overleaf/ShareLaTeX project. Pass a project URL, git URL, or 24-character project ID.',
        });
      }

      const workspaceRoot = ctx.args.destination
        ? resolve(context.cwd, ctx.args.destination)
        : context.cwd;

      return Effect.gen(function* () {
        const outcome = yield* cloneOverleafProject(
          remote,
          workspaceRoot,
          buildOverleafClonePorts(context, remote, yield* Secrets),
        );
        return presentCloneOutcome(context, remote, workspaceRoot, outcome);
      });
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        [
          'texra clone 0123456789abcdef01234567 ./project',
          'create a directory and clone an Overleaf project into it',
        ],
        [
          'texra clone https://sharelatex.example.edu/project/0123456789abcdef01234567',
          'clone from a self-hosted ShareLaTeX instance',
        ],
      ],
    },
  ],
);
