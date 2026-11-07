// Node imports
import { resolve } from 'node:path';
// Third-party imports
import { Effect, FileSystem } from 'effect';

// Internal imports
import { Secrets, type PlatformSecrets } from '@texra-ai/harness/host';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  cloneOverleafProject,
  gitClone,
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

// Local imports - runtime
import { CliUsageError, type CliContext } from '../runtime/platform/cliContext';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliSecretsLayer } from '../runtime/platform/cliProcessRuntime';
import { askCliQuestion, writeTextStderr } from '../runtime/platform/logSinks';

// Local imports - command helpers
import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { writeCliResult } from './_helpers/output';

function buildOverleafClonePorts(
  context: CliContext,
  remote: OverleafRemote,
  workspacePath: string,
  secrets: PlatformSecrets,
): OverleafCloneWorkflowPorts {
  let canonicalWorkspacePath = workspacePath;
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
    showInvalidToken: (_spec, message) =>
      Effect.sync(() => {
        writeTextStderr(message);
        writeTextStderr(`Token instructions: ${OVERLEAF_TOKEN_DOCS_URL}`);
      }),

    showGitMissing: () =>
      Effect.sync(() => {
        writeTextStderr(
          `Git is not installed or is not on PATH.\n\n${
            installAdvice('Git', ['git'], osPlatformOf(process.platform)).guide
          }`,
        );
      }),
    listWorkspaceEntries: (dir) =>
      FileSystem.FileSystem.use((fs) => fs.readDirectory(dir)).pipe(
        // A destination that does not exist yet is an empty destination, not
        // an unreadable one: `runClone` creates it. Only `NotFound` counts,
        // not all of `absentReason`: a path under a regular file (ENOTDIR)
        // cannot be created, so it stays unreadable and stops the clone
        // before the token prompt.
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.succeed<string[]>([]),
        ),
        Effect.mapError((error) => ensureError(error.reason.cause ?? error)),
      ),
    showWorkspaceUnreadable: (error) =>
      Effect.sync(() => {
        writeTextStderr(
          `Cannot read destination directory: ${toErrorMessage(error)}`,
        );
      }),
    showWorkspaceNotEmpty: () =>
      Effect.sync(() => {
        writeTextStderr(
          `The destination directory ${workspacePath} is not empty. Create or choose an empty directory, then pass it as the second argument; for example: texra clone 0123456789abcdef01234567 ./paper`,
        );
      }),

    runClone: (clone, cloneInto) =>
      FileSystem.FileSystem.use((fs) =>
        fs
          .makeDirectory(cloneInto, { recursive: true })
          .pipe(Effect.andThen(fs.realPath(cloneInto))),
      ).pipe(
        Effect.mapError((error) => ensureError(error.reason.cause ?? error)),
        Effect.flatMap((canonical) => {
          canonicalWorkspacePath = canonical;
          return gitClone(clone, canonical);
        }),
      ),
    showCloneSucceeded: (label) =>
      Effect.sync(() => {
        const result = {
          cloned: true,
          provider: remote.isOverleaf ? 'overleaf' : 'sharelatex',
          host: remote.host,
          destination: canonicalWorkspacePath,
        };
        writeCliResult(context.outputFormat, {
          json: result,
          ndjson: { kind: 'result', result: { command: 'clone', ...result } },
          text: `${label} project cloned into ${canonicalWorkspacePath}.`,
        });
      }),
    showAuthFailure: (failedRemote) =>
      Effect.sync(() => {
        const detail = failedRemote.isOverleaf
          ? `Generate a new token at ${OVERLEAF_GIT_TOKEN_URL}, then rerun the command.`
          : 'Check the ShareLaTeX credentials for this host, then rerun the command.';
        writeTextStderr(`Clone failed: authentication error. ${detail}`);
      }),
    showCloneFailed: (message) =>
      Effect.sync(() => {
        writeTextStderr(message);
      }),
    logCloneError: (message) =>
      Effect.sync(() => {
        if (!context.quietLogs) {
          writeTextStderr(`Git clone error: ${message}`);
        }
      }),
  };
}

export const cloneCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'clone',
      description:
        'Clone an Overleaf or ShareLaTeX project into a destination directory',
    },
    args: {
      ...GLOBAL_ARGS,
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

      const workspacePath = ctx.args.destination
        ? resolve(context.cwd, ctx.args.destination)
        : context.cwd;

      return Effect.gen(function* () {
        const outcome = yield* cloneOverleafProject(
          remote,
          workspacePath,
          buildOverleafClonePorts(
            context,
            remote,
            workspacePath,
            yield* Secrets,
          ),
        );
        switch (outcome.status) {
          case 'success':
            return CliExitCode.Success;
          case 'cancelled':
            writeTextStderr('Clone cancelled.');
            return CliExitCode.Cancelled;
          case 'invalidToken':
            return CliExitCode.Usage;
          case 'gitMissing':
          case 'workspaceUnreadable':
          case 'workspaceNotEmpty':
          case 'authFailure':
          case 'cloneFailed':
            return CliExitCode.AgentError;
        }
      });
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        [
          'texra clone 0123456789abcdef01234567 ./paper',
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
