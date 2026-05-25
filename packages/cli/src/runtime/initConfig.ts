// Pure helpers for `texra init`: turn collected answers into a canonical
// `.texra/config.json`, resolve the target path by scope, and keep the
// workspace config directory out of version control. The interactive wizard
// (init/runInitWizard) and the command (commands/init) build on these; keeping
// the logic here makes it unit-testable without a TTY.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CliApprovalPolicy,
  CliOutputFormat,
} from '../schemas/cliSettings';
import { CLI_CONFIG_DIR, workspaceCliConfigPath } from './cliConfig';

export interface InitAnswers {
  readonly agent: string;
  readonly model: string;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly outputFormat: CliOutputFormat;
}

/** Canonical config shape written by `texra init` (a subset of CliConfigValues). */
export interface InitConfigShape {
  readonly model: string;
  readonly outputFormat: CliOutputFormat;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly chat: { readonly agent: string; readonly model: string };
}

/**
 * Resolve the workspace config file path. (User-scope config lives in global
 * storage with a different shape and loader; bootstrapping it is a follow-up.)
 */
export function initConfigPath(cwd: string): string {
  return workspaceCliConfigPath(cwd);
}

/** Map wizard answers to the canonical config object. */
export function buildInitConfig(answers: InitAnswers): InitConfigShape {
  return {
    model: answers.model,
    outputFormat: answers.outputFormat,
    approvalPolicy: answers.approvalPolicy,
    chat: { agent: answers.agent, model: answers.model },
  };
}

/** Stable, pretty JSON with a trailing newline (matches editor/formatter output). */
export function serializeInitConfig(config: InitConfigShape): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function configFileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function writeInitConfig(
  filePath: string,
  config: InitConfigShape,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeInitConfig(config), 'utf8');
}

/**
 * Return `.gitignore` content with the workspace config dir ignored, or `null`
 * when it is already covered. Appends a single `.texra/` entry, preserving any
 * existing content and a single trailing newline.
 */
export function gitignoreWithTexra(existing: string): string | null {
  const entry = `${CLI_CONFIG_DIR}/`;
  const present = existing
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === entry || line === CLI_CONFIG_DIR);
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
  } catch {
    existed = false;
  }
  const next = gitignoreWithTexra(existing);
  if (next === null) return 'present';
  await writeFile(gitignorePath, next, 'utf8');
  return existed ? 'added' : 'created';
}
