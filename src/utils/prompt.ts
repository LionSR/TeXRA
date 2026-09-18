import * as path from 'node:path';

import { Effect } from 'effect';

import { ensureError } from '@utils/errors/errorMessage';
import { locateInWorkspace } from '@utils/files/workspaceFS';

/**
 * File name exposed to prompt XML and workflow output instructions.
 *
 * Keep workspace files workspace-relative so sibling documents with the same
 * basename remain distinct. For external absolute paths, expose only the
 * basename: model-produced document names must be portable run-storage names,
 * not host filesystem paths.
 *
 * `workspaceRoot` is the root the caller holds as data. `undefined` is a
 * session with no folder open: every path is then external, so the basename
 * rule applies on its own.
 */
export function getPromptFileName(
  workspaceRoot: string | undefined,
  file: string,
): string {
  if (!file) return file;

  const located = locateInWorkspace(workspaceRoot, file);
  if (located.kind === 'workspace') {
    return located.relativePath;
  }

  return path.isAbsolute(file) ? path.basename(file) : file;
}

/**
 * Convert a list of files to a comma-separated string
 * @param workspaceRoot Root the caller holds as data (see {@link getPromptFileName})
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(
  workspaceRoot: string | undefined,
  files: string[] | null | undefined,
): string {
  if (!files) return '';
  return files
    .filter((f) => f.trim() !== '')
    .map((file) => getPromptFileName(workspaceRoot, file))
    .join(', ');
}

/**
 * Build a Nunjucks environment configured the way every TeXRA template render
 * needs: autoescape off, since prompts and generated agent YAML render raw
 * text, not HTML. Centralized so that option isn't hand-copied at each call
 * site — pass a loader to enable `{% include %}`/`{% extends %}`, or `null`
 * for a renderString-only environment.
 */
export function createTexraNunjucksEnvironment(
  nunjucksModule: typeof import('nunjucks'),
  loader: import('nunjucks').ILoader | null = null,
): import('nunjucks').Environment {
  return new nunjucksModule.Environment(loader, { autoescape: false });
}

let promptEnvironmentPromise: Promise<import('nunjucks').Environment> | null =
  null;

/**
 * The shared prompt-rendering environment. The lazy `nunjucks` import is this
 * module's one foreign async edge — memoized, so every render after the first
 * resolves from the already-settled promise.
 */
const promptEnvironment: Effect.Effect<import('nunjucks').Environment, Error> =
  Effect.tryPromise({
    try: () =>
      (promptEnvironmentPromise ??= import('nunjucks').then(
        ({ default: nunjucks }) =>
          createTexraNunjucksEnvironment(
            nunjucks,
            new nunjucks.FileSystemLoader('.'),
          ),
      )),
    catch: ensureError,
  });

/**
 * Render a prompt string using nunjucks templating.
 *
 * @param prompt The prompt template string
 * @param variables Variables to use in template rendering
 * @returns The rendered prompt; a template error fails with that `Error`
 */
export const renderPrompt = Effect.fn('prompt.render')(function* (
  prompt: string,
  variables: Record<string, unknown>,
): Effect.fn.Return<string, Error> {
  const environment = yield* promptEnvironment;
  return yield* Effect.try({
    try: () => environment.renderString(prompt, variables),
    catch: ensureError,
  });
});
