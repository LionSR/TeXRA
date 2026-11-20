// The native entry an installed plugin may carry: `harness.mjs` at its
// root, a module whose default export the harness calls with its own
// `effect` and plugin authoring surface and which returns a `Plugin`
// (`@tools/nativePlugins` loads it). It runs inside the process with the
// user's rights, so nothing here runs it: what it contributes is read from
// the text of the file, for the trust review, and the loader refuses a
// module whose plugin contributes anything else. The file must begin with
// two declarations, as a program file does (`./pluginPrograms`):
//
//   export const description = 'One line: what it adds.';
//   export const provides = ['tool:word_count', 'processLayer', 'prompt'];
//
// `provides` names each contribution: `tool:<name>`, `program:<name>`,
// `module:<name>` (a script module), `processLayer`, `sessionLayer` and
// `prompt`.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports
import { meansAbsent } from '@utils/files/fsEntryExists';
import { readDeclarations } from './pluginPrograms';

/** The native entry's file name, at the plugin's root. */
export const NATIVE_ENTRY_FILE = 'harness.mjs';

/** A native entry as its file declares it. */
export interface NativeEntry {
  /** Its file, absolute. */
  readonly file: string;
  readonly description: string;
  /** What its plugin contributes, as `provides` names it. */
  readonly provides: readonly string[];
}

/** One contribution `provides` may name. */
const CONTRIBUTION =
  /^(?:(?:tool|program|module):[A-Za-z0-9_-]+|processLayer|sessionLayer|prompt)$/;

/** What the review says of each kind of contribution, as `describe`
 *  groups them. */
const KINDS = [
  ['tool:', 'tools'],
  ['program:', 'programs'],
  ['module:', 'script modules'],
] as const;

/**
 * The contributions a native entry declares, one phrase each, for the
 * trust review and a listing: its tools, programs and script modules by
 * name, and whether it holds process services, session services or a
 * prompt section.
 */
export const describeProvides = (provides: readonly string[]): string => {
  const named = KINDS.flatMap(([prefix, label]) => {
    const names = provides.flatMap((item) =>
      item.startsWith(prefix) ? [item.slice(prefix.length)] : [],
    );
    return names.length === 0 ? [] : [`${label} ${names.join(', ')}`];
  });
  const held = [
    ...(provides.includes('processLayer')
      ? ['services held for the life of the process']
      : []),
    ...(provides.includes('sessionLayer')
      ? ['services held for each open session']
      : []),
    ...(provides.includes('prompt')
      ? ['a section of every request’s system text']
      : []),
  ];
  return [...named, ...held].join('; ') || 'nothing';
};

/**
 * The native entry of the plugin at `dir`, read as text and never run:
 * `entry` null when the plugin has none, `refused` naming why one it has is
 * not loaded (a link, an unreadable file, a header that does not declare
 * what it provides). Never fails.
 */
export const readNativeEntry = Effect.fn('readNativeEntry')(function* (
  dir: string,
  plugin: string,
): Effect.fn.Return<
  {
    readonly entry: NativeEntry | null;
    readonly refused: string | null;
  },
  never,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(dir, NATIVE_ENTRY_FILE);
  const refused = (reason: string) => ({
    entry: null,
    refused: `The native code ${NATIVE_ENTRY_FILE} of plugin ${plugin} is not loaded: ${reason}.`,
  });
  const text = yield* Effect.result(
    Effect.gen(function* () {
      const info = yield* fs.lstat(file);
      return info.type === 'File' ? yield* fs.readFileString(file) : null;
    }),
  );
  if (Result.isFailure(text))
    return meansAbsent(text.failure)
      ? { entry: null, refused: null }
      : refused(text.failure.message);
  if (text.success === null)
    return refused(
      'it is not a regular file inside the plugin (a link is not followed)',
    );
  const declared = readDeclarations(text.success, {
    name: 'provides',
    holds: 'what its plugin contributes',
    example: "['tool:word_count', 'processLayer']",
  });
  if (Result.isFailure(declared)) return refused(declared.failure);
  const { description, names } = declared.success;
  const unknown = names.find((name) => !CONTRIBUTION.test(name));
  if (unknown !== undefined)
    return refused(
      `\`provides\` names ${JSON.stringify(unknown)}, which is not tool:<name>, program:<name>, module:<name>, processLayer, sessionLayer or prompt`,
    );
  return {
    entry: { file, description, provides: [...new Set(names)] },
    refused: null,
  };
});
