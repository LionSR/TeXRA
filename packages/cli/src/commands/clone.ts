// Node imports
import { resolve } from 'node:path';
// Third-party imports
import { Effect, FileSystem } from 'effect';

// Internal imports
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

// Local imports - runtime
import { CliUsageError, type CliContext } from '../runtime/cliContext';

import { getCliSecrets } from '../runtime/cliSecrets';
import { CliExitCode } from '../runtime/exitCodes';
import {
  askCliQuestion,
  cliErrorMessage,
  writeTextStderr,
} from '../runtime/logSinks';

// Local imports - command helpers
import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

function buildOverleafClonePorts(
  context: CliContext,
  remote: OverleafRemote,
  workspacePath: string,
  fs: FileSystem.FileSystem,
): OverleafCloneWorkflowPorts {
  const secrets = getCliSecrets(context.storageRoot);
  let canonicalWorkspacePath = workspacePath;
  return {
    // `orDie` keeps what `Effect.promise` did with a rejected store call: a
    // credential store this host cannot reach is a defect here, not a clone
    // outcome the workflow reports.
    getStoredToken: (key) => Effect.orDie(secrets.get(key)),
    deleteStoredToken: (key) => Effect.orDie(secrets.delete(key)),
    storeToken: (key, token) => Effect.orDie(secrets.set(key, token)),
    promptToken: (spec) =>
      Effect.gen(function* () {
        const tokenGuidance = remote.isOverleaf
          ? `${spec.tokenHint ?? ''} Create or copy a token at ${OVERLEAF_GIT_TOKEN_URL}. Instructions: ${OVERLEAF_TOKEN_DOCS_URL}`.trim()
          : spec.tokenHint;
        if (context.mode !== 'interactive' || context.outputFormat !== 'text') {
          return yield* Effect.fail(
            new CliUsageError(
              `No saved ${spec.tokenTitle} is available. ${tokenGuidance ? `${tokenGuidance} ` : ''}Run this command in an interactive terminal to enter and save one.`,
            ),
          );
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
          `Git is not installed or is not on PATH. Install it from ${GIT_DOWNLOAD_URL}.`,
        );
      }),
    listWorkspaceEntries: (dir) =>
      fs.readDirectory(dir).pipe(
        // A destination that does not exist yet is an empty destination, not
        // an unreadable one: `runClone` creates it.
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.succeed<string[]>([]),
        ),
      ),
    showWorkspaceUnreadable: (error) =>
      Effect.sync(() => {
        writeTextStderr(
          `Cannot read destination directory: ${cliErrorMessage(error)}`,
        );
      }),
    showWorkspaceNotEmpty: () =>
      Effect.sync(() => {
        writeTextStderr(
          `The destination directory ${workspacePath} is not empty. Create or choose an empty directory, then pass it as the second argument; for example: texra clone 0123456789abcdef01234567 ./paper`,
        );
      }),

    runClone: (clone, cloneInto) =>
      fs.makeDirectory(cloneInto, { recursive: true }).pipe(
        Effect.andThen(fs.realPath(cloneInto)),
        Effect.mapError((error) => new Error(cliErrorMessage(error))),
        Effect.flatMap((canonical) => {
          canonicalWorkspacePath = canonical;
          return gitClone(clone, canonical).pipe(
            Effect.mapError((error) => new Error(error.message)),
          );
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
        emitCliResult(context, {
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
      cwd: {
        ...GLOBAL_ARGS.cwd,
        description:
          'Empty directory to clone into (defaults to the current directory)',
      },
      project: {
        type: 'positional',
        required: true,
        description: 'Project URL, git URL, or 24-character project ID',
      },
      destination: {
        type: 'positional',
        required: false,
        description: 'Directory to create or clone into (defaults to --cwd)',
      },
    },
    // `clone` runs without a platform, but its token ports are `CliSecrets`,
    // whose reads and writes are Effect programs. The process runtime its
    // entry installs for them serves a state store and a global-root handle
    // that refuse: clone serves no application state and reads no record, and
    // opening either would create the global storage directory and its
    // database, which an env-token clone on a read-only storage root must
    // not require.
    install: 'noPlatform',
    // The project and destination parses are the builder's, above the
    // program: they refuse before anything is installed.
    run: (context, ctx) => {
      const remote = parseLatexGitUrl(ctx.args.project);
      if (!remote) {
        throw new CliUsageError(
          'Invalid Overleaf/ShareLaTeX project. Pass a project URL, git URL, or 24-character project ID.',
        );
      }

      if (ctx.args.destination && ctx.args.cwd) {
        throw new CliUsageError(
          'Pass the clone destination either as the second argument or with --cwd, not both.',
        );
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
            yield* FileSystem.FileSystem,
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
