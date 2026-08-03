// Pure helpers for `texra init`: turn collected answers into a canonical
// `.texra/config.json`, resolve the target path by scope, and keep the
// workspace config directory out of version control. The interactive wizard
// (init/runInitWizard) and the command (commands/init) build on these; keeping
// the logic here makes it unit-testable without a TTY.

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';
import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';

import type { CliOutputFormat } from '../schemas/cliSettings';

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

/** Stable, pretty JSON with a trailing newline (matches editor/formatter output). */
export function serializeInitConfig(config: InitConfigShape): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function configFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeInitFileAtomic(
  filePath: string,
  data: string,
): Promise<void> {
  try {
    const target = await open(filePath, fsConstants.O_WRONLY);
    await target.close();
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) throw error;
  }
  await writeFileAtomic(filePath, data);
}

export async function writeInitConfig(
  filePath: string,
  config: InitConfigShape,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeInitFileAtomic(filePath, serializeInitConfig(config));
}

/**
 * Return `.gitignore` content with the workspace config dir ignored, or `null`
 * when it is already covered. Appends a single `.texra/` entry, preserving any
 * existing content and a single trailing newline.
 */
export function gitignoreWithTexra(existing: string): string | null {
  const entry = `${TEXRA_STORAGE_DIR_NAME}/`;
  const present = existing
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === entry || line === TEXRA_STORAGE_DIR_NAME);
  if (present) return null;
  const trimmed = existing.replace(/\n+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n${entry}\n` : `${entry}\n`;
}

export type GitignoreOutcome = 'added' | 'present' | 'created';

export async function ensureTexraGitignored(
  cwd: string,
): Promise<GitignoreOutcome> {
  const gitignorePath = path.join(cwd, '.gitignore');
  let existing = '';
  let existed = true;
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch (error: unknown) {
    // A missing .gitignore is fine — we create one. Anything else (EACCES,
    // a transient I/O error, ...) must not be treated as "file absent": doing
    // so would fall through to the write below and overwrite unreadable-but-
    // present content instead of surfacing the failure.
    if (!isFileNotFoundError(error)) throw error;
    existed = false;
  }
  const next = gitignoreWithTexra(existing);
  if (next === null) return 'present';
  await writeInitFileAtomic(gitignorePath, next);
  return existed ? 'added' : 'created';
}
