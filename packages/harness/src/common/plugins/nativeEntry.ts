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
// `provides` names each contribution, in the words of `NAMED_KINDS` and
// `SINGLE_KINDS`.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result, Struct } from 'effect';

// Local imports
import { readDeclaredFile } from './pluginPrograms';

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

/** The kinds of contribution a plugin may have several of, each named in
 *  `provides` as `<word>:<name>`: the word, and what a review calls them. */
export const NAMED_KINDS = {
  tool: 'tools',
  program: 'programs',
  module: 'script modules',
} as const;

/** The kinds a plugin has one of or none, each named in `provides` by its
 *  word, the plugin's field of that name: the word, and what a review says
 *  of it. */
export const SINGLE_KINDS = {
  processLayer: 'services held for the life of the process',
  sessionLayer: 'services held for each open session',
  prompt: 'a section of every request’s system text',
} as const;

/** How `provides` names each kind, as a message or a description lists
 *  them. */
export const PROVIDES_WORDS: readonly string[] = [
  ...Struct.keys(NAMED_KINDS).map((word) => `${word}:<name>`),
  ...Struct.keys(SINGLE_KINDS),
];

/** One contribution `provides` may name. */
const CONTRIBUTION = new RegExp(
  `^(?:(?:${Struct.keys(NAMED_KINDS).join('|')}):[A-Za-z0-9_-]+|${Struct.keys(SINGLE_KINDS).join('|')})$`,
);

/**
 * The contributions a native entry declares, one phrase each, for the
 * trust review and a listing: those of each named kind by name, then what
 * it has of the single kinds.
 */
export const describeProvides = (provides: readonly string[]): string => {
  const named = Object.entries(NAMED_KINDS).flatMap(([word, label]) => {
    const names = provides.flatMap((item) =>
      item.startsWith(`${word}:`) ? [item.slice(word.length + 1)] : [],
    );
    return names.length === 0 ? [] : [`${label} ${names.join(', ')}`];
  });
  const single = Object.entries(SINGLE_KINDS).flatMap(([word, says]) =>
    provides.includes(word) ? [says] : [],
  );
  return [...named, ...single].join('; ') || 'nothing';
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
  const file = path.join(dir, NATIVE_ENTRY_FILE);
  const refused = (reason: string) => ({
    entry: null,
    refused: `The native code ${NATIVE_ENTRY_FILE} of plugin ${plugin} is not loaded: ${reason}.`,
  });
  const declared = yield* readDeclaredFile(file, {
    name: 'provides',
    holds: 'what its plugin contributes',
    example: "['tool:word_count', 'processLayer']",
  });
  if (declared === null) return { entry: null, refused: null };
  if (Result.isFailure(declared)) return refused(declared.failure);
  const { description, names } = declared.success;
  const unknown = names.find((name) => !CONTRIBUTION.test(name));
  if (unknown !== undefined)
    return refused(
      `\`provides\` names ${JSON.stringify(unknown)}, which is not one of ${PROVIDES_WORDS.join(', ')}`,
    );
  return {
    entry: { file, description, provides: [...new Set(names)] },
    refused: null,
  };
});
