// Node imports
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Third-party imports
import { execa } from 'execa';

// Internal imports
import { isFileNotFoundError } from '@common/errors';
import {
  cloneOverleafProject,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  parseLatexGitUrl,
  type OverleafRemote,
} from '@latex/overleafProject';
import { executeCommandSync } from '@utils/system/execUtils';
import { extendEnvPath } from '@utils/system/platformPaths';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - runtime
import { CliUsageError, type CliContext } from '../runtime/cliContext';
import { getCliSecrets } from '../runtime/cliSecrets';
import { CliExitCode } from '../runtime/exitCodes';
import { writeRawStderr, writeTextStderr } from '../runtime/logSinks';

// Local imports - command helpers
import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

async function promptSecret(question: string): Promise<string> {
  const hiddenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: hiddenOutput,
    terminal: true,
  });
  writeRawStderr(question);
  try {
    return await prompt.question('');
  } finally {
    prompt.close();
    writeRawStderr('\n');
  }
}

function buildOverleafClonePorts(
  context: CliContext,
  remote: OverleafRemote,
  workspacePath: string,
): OverleafCloneWorkflowPorts {
  const secrets = getCliSecrets();
  let canonicalWorkspacePath = workspacePath;
  return {
    getStoredToken: (key) => secrets.get(key),
    deleteStoredToken: (key) => secrets.delete(key),
    storeToken: (key, token) => secrets.set(key, token),
    promptToken: async (spec) => {
      const tokenGuidance = remote.isOverleaf
        ? `${spec.tokenHint ?? ''} Create or copy a token at ${OVERLEAF_GIT_TOKEN_URL}. Instructions: ${OVERLEAF_TOKEN_DOCS_URL}`.trim()
        : spec.tokenHint;
      if (context.mode !== 'interactive' || context.outputFormat !== 'text') {
        throw new CliUsageError(
          `No saved ${spec.tokenTitle} is available. ${tokenGuidance ? `${tokenGuidance} ` : ''}Run this command in an interactive terminal to enter and save one.`,
        );
      }
      if (tokenGuidance) writeTextStderr(tokenGuidance);
      const token = (await promptSecret(`${spec.tokenTitle}: `)).trim();
      return token || null;
    },
    showInvalidToken: async (_spec, message) => {
      writeTextStderr(message);
      writeTextStderr(`Token instructions: ${OVERLEAF_TOKEN_DOCS_URL}`);
    },

    isGitAvailable: () =>
      executeCommandSync(['git', '--version'], { quiet: true }).success,
    showGitMissing: async () => {
      writeTextStderr(
        `Git is not installed or is not on PATH. Install it from ${GIT_DOWNLOAD_URL}.`,
      );
    },
    listWorkspaceEntries: async (dir) => {
      try {
        return await readdir(dir);
      } catch (error) {
        if (isFileNotFoundError(error)) return [];
        throw error;
      }
    },
    showWorkspaceUnreadable: (error) => {
      writeTextStderr(
        `Cannot read destination directory: ${toErrorMessage(error)}`,
      );
    },
    showWorkspaceNotEmpty: () => {
      writeTextStderr(
        `The destination directory ${workspacePath} is not empty. Create or choose an empty directory, then pass it as the second argument; for example: texra clone 0123456789abcdef01234567 ./paper`,
      );
    },

    runClone: async (remoteUrl, workspacePath) => {
      await mkdir(workspacePath, { recursive: true });
      canonicalWorkspacePath = await realpath(workspacePath);
      await execa('git', ['clone', remoteUrl, '.'], {
        cwd: canonicalWorkspacePath,
        env: { GIT_TERMINAL_PROMPT: '0', PATH: extendEnvPath() },
      });
    },
    showCloneSucceeded: (label) => {
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
    },
    showAuthFailure: async (failedRemote) => {
      const detail = failedRemote.isOverleaf
        ? `Generate a new token at ${OVERLEAF_GIT_TOKEN_URL}, then rerun the command.`
        : 'Check the ShareLaTeX credentials for this host, then rerun the command.';
      writeTextStderr(`Clone failed: authentication error. ${detail}`);
    },
    showCloneFailed: (message) => {
      writeTextStderr(message);
    },
    logCloneError: (message) => {
      if (!context.quietLogs) {
        writeTextStderr(`Git clone error: ${message}`);
      }
    },
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
    run: async (context, ctx) => {
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

      const outcome = await cloneOverleafProject(
        remote,
        workspacePath,
        buildOverleafClonePorts(context, remote, workspacePath),
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
