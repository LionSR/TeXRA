// Helpers for `texra init`: turn collected answers into a canonical
// `.texra/config.json`, write it through the FileSystem service, and keep the
// workspace config directory out of version control. The interactive wizard
// (init/runInitWizard) and the command (commands/init) build on these; keeping
// the logic here makes it unit-testable without a TTY.

import path from 'node:path';

import { Effect, FileSystem, PlatformError } from 'effect';

import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { CliOutputFormat } from '@shared/schemas';
import { writeFileAtomic } from '@utils/files/fsDurability';

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
 * Probe for write permission before the atomic write stages its temp
 * file, so an unwritable target fails without leaving one behind. An absent
 * target is the normal case and is not a failure. The probe checks
 * permission only: a directory at the path fails at the atomic rename.
 */
function writeInitFileAtomic(
  filePath: string,
  data: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.use((fs) =>
    fs.access(filePath, { writable: true }),
  ).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.andThen(writeFileAtomic(filePath, new TextEncoder().encode(data))),
  );
}

export function writeInitConfig(
  filePath: string,
  config: InitConfigShape,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.use((fs) =>
    fs.makeDirectory(path.dirname(filePath), { recursive: true }),
  ).pipe(
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
): Effect.Effect<
  GitignoreOutcome,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const gitignorePath = path.join(cwd, '.gitignore');
    const existing = yield* fs.readFileString(gitignorePath).pipe(
      // A missing .gitignore is fine — we create one. Anything else (EACCES,
      // a transient I/O error, ...) must not be treated as "file absent":
      // doing so would fall through to the write below and overwrite
      // unreadable-but-present content instead of surfacing the failure.
      Effect.catchReason('PlatformError', 'NotFound', () =>
        Effect.succeed(undefined),
      ),
    );
    const next = gitignoreWithTexra(existing ?? '');
    if (next === null) return 'present';
    yield* writeInitFileAtomic(gitignorePath, next);
    return existing === undefined ? 'created' : 'added';
  });
}
