// The programs an installed plugin carries: each `programs/<name>.js` is a
// script module a person or a model starts by name, as `<plugin>:<name>`.
//
// An installed plugin's file is third-party code, so nothing here runs it:
// a program's description and tools are read from the text of the file, and
// the source is handed on as text for the script sandbox to load. The file
// must begin with two declarations, in either order, with only whitespace
// and comments before and between them:
//
//   export const description = 'One line: what it does.';
//   export const uses = ['read_file', 'agent'];
//
// `uses` names the tools its run is offered. It is not called `tools`: a
// module's own `tools` binding would hide the sandbox's `tools` global, and
// `tools.read_file(...)` inside the program would then call an array.
//
// Each value is a quoted literal, so reading it needs no JavaScript parser
// and no evaluation, and what the reader takes is what the module itself
// exports. Anything else at the start of the file (a computed value, a
// template string, code before the declarations) refuses that one file by
// name; the plugin's other programs load.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports
import { meansAbsent } from '@utils/files/fsEntryExists';

/** The directory of a plugin that holds its programs. */
const PROGRAMS_DIRECTORY = 'programs';

/** A program's own name, the part after `<plugin>:`: the grammar of a
 *  plugin's name and of a skill's. */
const PROGRAM_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The longest description a program may declare: it is listed to the model
 *  at every step that may start the program. */
const DESCRIPTION_MAX_LENGTH = 300;

/** One program an installed plugin carries, as read from its file. */
export interface PluginProgram {
  /** `<plugin>:<name>`: what it is started by, and its module's specifier. */
  readonly name: string;
  /** Its file, relative to the plugin directory. */
  readonly file: string;
  readonly description: string;
  /** The tools its run is offered, by name. */
  readonly tools: readonly string[];
  /** The module's source, which only the script sandbox evaluates. */
  readonly source: string;
}

/** What a plugin's `programs/` directory holds. */
export interface PluginPrograms {
  readonly loaded: readonly PluginProgram[];
  /** One line for each program file that is not loaded, naming it. */
  readonly refused: readonly string[];
}

const HEADER_FORM =
  "it must begin with `export const description = '...';` and `export const uses = ['...'];` (the tools it is offered), each a quoted literal";

/** The escapes a quoted literal may hold, by the character after `\`. */
const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  n: '\n',
  t: '\t',
};

/**
 * The two declarations a program file begins with, read from its text, or
 * why it has none. A cursor walks whitespace, comments and the two
 * `export const` statements and stops there: the rest of the file is never
 * looked at.
 */
function readDeclarations(
  source: string,
): Result.Result<Pick<PluginProgram, 'description' | 'tools'>, string> {
  let at = 0;
  const refuse = (reason: string) => Result.fail(reason);
  /** Advance past `pattern` when the text at the cursor matches it. */
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const sticky = new RegExp(pattern.source, 'y');
    sticky.lastIndex = at;
    const match = sticky.exec(source);
    if (match !== null) at = sticky.lastIndex;
    return match;
  };
  /** Advance past whitespace and comments. */
  const skip = (): void => {
    while (take(/\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\//) !== null);
  };
  /** A single- or double-quoted literal at the cursor, as the string it
   *  spells; undefined when there is none or it holds an escape or a line
   *  break this reader does not take. */
  const quoted = (): string | undefined => {
    const quote = source[at];
    if (quote !== "'" && quote !== '"') return undefined;
    let text = '';
    for (let index = at + 1; index < source.length; index += 1) {
      const char = source.charAt(index);
      if (char === quote) {
        at = index + 1;
        return text;
      }
      if (char === '\n' || char === '\r') return undefined;
      if (char !== '\\') {
        text += char;
        continue;
      }
      index += 1;
      const escaped = ESCAPES[source.charAt(index)];
      if (escaped === undefined) return undefined;
      text += escaped;
    }
    return undefined;
  };
  let description: string | undefined;
  let tools: string[] | undefined;
  const wrong = {
    description:
      '`description` must be one quoted string on one line (\'...\' or "...") followed by `;`, not a template or an expression',
    uses: "`uses` must be an array of quoted tool names (['read_file', 'agent']) followed by `;`, not an expression",
  };
  while (description === undefined || tools === undefined) {
    skip();
    const declared = take(/export\s+const\s+(description|uses)\b\s*=/);
    if (declared === null) {
      const missing = [
        ...(description === undefined ? ['description'] : []),
        ...(tools === undefined ? ['uses'] : []),
      ];
      return refuse(
        `${HEADER_FORM}; ${missing.map((name) => `\`${name}\``).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not declared there`,
      );
    }
    skip();
    if (declared[1] === 'description') {
      if (description !== undefined)
        return refuse('`description` is declared twice');
      const text = quoted();
      skip();
      // A line break does not end a JavaScript statement, so only `;`
      // shows the literal is the whole value (`'a' + b` is an expression).
      if (text === undefined || take(/;/) === null)
        return refuse(wrong.description);
      description = text.replaceAll(/\s+/g, ' ').trim();
      if (description === '') return refuse('`description` is empty');
      if (description.length > DESCRIPTION_MAX_LENGTH)
        return refuse(
          `\`description\` is longer than ${DESCRIPTION_MAX_LENGTH} characters`,
        );
    } else {
      if (tools !== undefined) return refuse('`uses` is declared twice');
      if (take(/\[/) === null) return refuse(wrong.uses);
      const names: string[] = [];
      for (;;) {
        skip();
        if (take(/\]/) !== null) break;
        const name = quoted();
        if (name === undefined || !/^\S+$/.test(name))
          return refuse(wrong.uses);
        names.push(name);
        skip();
        if (take(/,/) !== null) continue;
        if (take(/\]/) !== null) break;
        return refuse(wrong.uses);
      }
      skip();
      // As above: `[...].concat(more)` is an expression.
      if (take(/;/) === null) return refuse(wrong.uses);
      tools = names;
    }
  }
  return Result.succeed({ description, tools });
}

/**
 * The programs in the plugin `plugin` at `dir`: every `programs/<name>.js`,
 * read as text and never run. A file whose name is not lowercase letters,
 * digits and hyphens, that is a link (the loader follows none, so no program
 * comes from outside the plugin directory), that cannot be read or that does
 * not begin with its two declarations is refused by name and the others
 * load; entries that are not `.js` files are not programs. Never fails.
 */
export const readPluginPrograms = Effect.fn('readPluginPrograms')(function* (
  dir: string,
  plugin: string,
): Effect.fn.Return<PluginPrograms, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const root = path.join(dir, PROGRAMS_DIRECTORY);
  const refusal = (file: string, reason: string) =>
    `Program ${file} of plugin ${plugin} is not loaded: ${reason}.`;
  const listed = yield* Effect.result(
    Effect.gen(function* () {
      const info = yield* fs.lstat(root);
      if (info.type !== 'Directory') return undefined;
      return (yield* fs.readDirectory(root))
        .filter((entry) => entry.endsWith('.js'))
        .toSorted();
    }),
  );
  if (Result.isFailure(listed))
    return meansAbsent(listed.failure)
      ? { loaded: [], refused: [] }
      : {
          loaded: [],
          refused: [refusal(PROGRAMS_DIRECTORY, listed.failure.message)],
        };
  if (listed.success === undefined)
    return {
      loaded: [],
      refused: [
        refusal(
          PROGRAMS_DIRECTORY,
          'it is not a directory inside the plugin (a link is not followed)',
        ),
      ],
    };
  const read = yield* Effect.forEach(
    listed.success,
    (entry) =>
      Effect.gen(function* () {
        const file = path.join(PROGRAMS_DIRECTORY, entry);
        const refused = (reason: string) => Result.fail(refusal(file, reason));
        const base = entry.slice(0, -'.js'.length);
        if (!PROGRAM_NAME.test(base))
          return refused(
            'its name must be lowercase letters, digits and hyphens',
          );
        const full = path.join(root, entry);
        const text = yield* Effect.result(
          Effect.gen(function* () {
            const info = yield* fs.lstat(full);
            return info.type === 'File'
              ? yield* fs.readFileString(full)
              : undefined;
          }),
        );
        if (Result.isFailure(text)) return refused(text.failure.message);
        if (text.success === undefined)
          return refused(
            'it is not a regular file inside the plugin (a link is not followed)',
          );
        const declared = readDeclarations(text.success);
        if (Result.isFailure(declared)) return refused(declared.failure);
        return Result.succeed({
          name: `${plugin}:${base}`,
          file,
          ...declared.success,
          source: text.success,
        } satisfies PluginProgram);
      }),
    { concurrency: 8 },
  );
  return {
    loaded: read.flatMap((one) => (Result.isSuccess(one) ? [one.success] : [])),
    refused: read.flatMap((one) =>
      Result.isFailure(one) ? [one.failure] : [],
    ),
  };
});
