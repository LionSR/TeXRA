// Pure helpers for `texra init`: turn collected answers into a canonical
// `.texra/config.json`, resolve the target path by scope, and keep the
// workspace config directory out of version control. The interactive wizard
// (init/runInitWizard) and the command (commands/init) build on these; keeping
// the logic here makes it unit-testable without a TTY.

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';
import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { CliOutputFormat } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

export interface InitAnswers {
  readonly agent: string;
  readonly model: string;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly outputFormat: CliOutputFormat;
}

/** Canonical config shape written by `texra init` (a subset of CliConfigValues). */
export interface InitConfigShape {
  readonly 'texra.model': string;
  readonly 'texra.outputFormat': CliOutputFormat;
  readonly 'texra.approvalPolicy': TexraApprovalPolicy;
  readonly 'texra.chat': { readonly agent: string; readonly model: string };
}

/** Map wizard answers to the canonical config object. */
export function buildInitConfig(answers: InitAnswers): InitConfigShape {
  return {
    'texra.model': answers.model,
    'texra.outputFormat': answers.outputFormat,
    'texra.approvalPolicy': answers.approvalPolicy,
    'texra.chat': { agent: answers.agent, model: answers.model },
  };
}

/**
 * `false` only for a genuinely absent path; any other failure (EACCES, EIO)
 * propagates instead of being reported as "absent".
 *
 * Still Promise-shaped, unlike its neighbours. Both callers are Effect
 * programs now (`commands/init.ts` and `commands/installGithubAction.ts`, the
 * latter as of the `defineCliCommand` Effect contract), and each wraps this
 * one call itself: `init` as a defect it does not report on, the GitHub
 * action as a typed failure its `catchExitCode` writes. Giving this function
 * one Effect shape would have to pick between those two readings, which is a
 * change to what the callers report, not a lift. Written with a rejection
 * handler rather than `try`/`catch` because this module imports `effect`, and
 * such a module carries no raw catch clause.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    (error: unknown) => {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
        return false;
      }
      throw error;
    },
  );
}

/**
 * Probe for write permission before `write-file-atomic` creates its temp
 * file, so an unwritable target fails without leaving one behind. An absent
 * target is the normal case and is not a failure.
 */
function writeInitFileAtomic(
  filePath: string,
  data: string,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const target = await open(filePath, fsConstants.O_WRONLY);
      await target.close();
    },
    catch: ensureError,
  }).pipe(
    Effect.catchIf(isFileNotFoundError, () => Effect.void),
    Effect.andThen(
      Effect.tryPromise({
        try: () => writeFileAtomic(filePath, data),
        catch: ensureError,
      }),
    ),
  );
}

export function writeInitConfig(
  filePath: string,
  config: InitConfigShape,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => mkdir(path.dirname(filePath), { recursive: true }),
    catch: ensureError,
  }).pipe(
    Effect.andThen(
      // Stable, pretty JSON with a trailing newline (matches
      // editor/formatter output).
      writeInitFileAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`),
    ),
  );
}

/**
 * Return `.gitignore` content with the workspace config dir ignored, or `null`
 * when it is already covered. Appends a single `.texra/` entry, preserving any
 * existing content and a single trailing newline.
 */
function gitignoreWithTexra(existing: string): string | null {
  const entry = `${TEXRA_STORAGE_DIR_NAME}/`;
  const present = existing.split('\n').some((line) => {
    const trimmedLine = line.trim();
    return trimmedLine === entry || trimmedLine === TEXRA_STORAGE_DIR_NAME;
  });
  if (present) return null;
  const trimmed = existing.replace(/\n+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n${entry}\n` : `${entry}\n`;
}

export type GitignoreOutcome = 'added' | 'present' | 'created';

export function ensureTexraGitignored(
  cwd: string,
): Effect.Effect<GitignoreOutcome, Error> {
  return Effect.gen(function* () {
    const gitignorePath = path.join(cwd, '.gitignore');
    const existing = yield* Effect.tryPromise({
      try: () => readFile(gitignorePath, 'utf8'),
      catch: ensureError,
    }).pipe(
      // A missing .gitignore is fine — we create one. Anything else (EACCES,
      // a transient I/O error, ...) must not be treated as "file absent":
      // doing so would fall through to the write below and overwrite
      // unreadable-but-present content instead of surfacing the failure.
      Effect.catchIf(isFileNotFoundError, () => Effect.succeed(undefined)),
    );
    const next = gitignoreWithTexra(existing ?? '');
    if (next === null) return 'present';
    yield* writeInitFileAtomic(gitignorePath, next);
    return existing === undefined ? 'created' : 'added';
  });
}
