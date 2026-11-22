// The programs read from files: each `<name>.js` of a directory of programs
// is a script module a person or a model starts by name. An installed
// plugin carries its own in `programs/`, started as `<plugin>:<name>`; an
// agent writes its own into its memory, started as `own:<name>`.
//
// Such a file is not the app's code, so nothing here runs it: a program's
// description and tools are read from the text of the file, and
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
// name; the directory's other programs load.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports
import { meansAbsent } from '@utils/files/fsEntryExists';
import { formatWordList } from '@utils/text/stringUtils';

/** The directory of a plugin that holds its programs. */
const PROGRAMS_DIRECTORY = 'programs';

/** A program's own name, the part after the colon: the grammar of a
 *  plugin's name and of a skill's. */
const PROGRAM_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The longest description a program may declare: it is listed to the model
 *  at every step that may start the program. */
const DESCRIPTION_MAX_LENGTH = 300;

/** One program, as read from its file. */
interface PluginProgram {
  /** `<prefix>:<name>`: what it is started by, and its module's specifier. */
  readonly name: string;
  readonly description: string;
  /** The tools its run is offered, by name. */
  readonly tools: readonly string[];
  /** The module's source, which only the script sandbox evaluates. */
  readonly source: string;
}

/** What a directory of programs holds. */
export interface PluginPrograms {
  readonly loaded: readonly PluginProgram[];
  /** One line for each program file that is not loaded, naming it. */
  readonly refused: readonly string[];
}

/** The list a file's header declares beside its `description`: a
 *  program's `uses` (the tools it is offered), or a native entry's
 *  `provides` (what its plugin contributes, `./nativeEntry`). */
interface HeaderList {
  readonly name: 'uses' | 'provides';
  /** What the list holds, and an example, for a refusal. */
  readonly holds: string;
  readonly example: string;
}

const USES: HeaderList = {
  name: 'uses',
  holds: 'the tools it is offered',
  example: "['read_file', 'agent']",
};

/**
 * The regular file `file` of a plugin, read as text and never run, and the
 * two declarations its header begins with (`list` beside the
 * `description`): the source, or why not
 * (an unreadable file, a link, which is not followed, a header that does
 * not declare them); `null` when nothing is there.
 */
export const readDeclaredFile = Effect.fn('readDeclaredFile')(function* (
  file: string,
  list: HeaderList,
): Effect.fn.Return<
  Result.Result<
    {
      readonly source: string;
      readonly description: string;
      readonly names: readonly string[];
    },
    string
  > | null,
  never,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Effect.result(
    Effect.gen(function* () {
      const info = yield* fs.lstat(file);
      return info.type === 'File' ? yield* fs.readFileString(file) : null;
    }),
  );
  if (Result.isFailure(text))
    return meansAbsent(text.failure) ? null : Result.fail(text.failure.message);
  if (text.success === null)
    return Result.fail('it is not a regular file (a link is not followed)');
  const source = text.success;
  return Result.map(readDeclarations(source, list), (declared) => ({
    source,
    ...declared,
  }));
});

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
  list: HeaderList,
): Result.Result<
  { readonly description: string; readonly names: readonly string[] },
  string
> {
  const headerForm = `it must begin with \`export const description = '...';\` and \`export const ${list.name} = ['...'];\` (${list.holds}), each a quoted literal`;
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
  /** Advance past whitespace and comments. A line comment ends at any of
   *  JavaScript's line terminators, as it does for the engine. */
  const skip = (): void => {
    while (take(/\s+|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//) !== null);
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
      // JavaScript ends a string literal at any line terminator, so the
      // engine would refuse what this reader took.
      if ('\n\r\u2028\u2029'.includes(char)) return undefined;
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
    list: `\`${list.name}\` must be an array of quoted names (${list.example}) followed by \`;\`, not an expression`,
  };
  while (description === undefined || tools === undefined) {
    skip();
    const declared = take(
      new RegExp(`export\\s+const\\s+(description|${list.name})\\b\\s*=`),
    );
    if (declared === null) {
      const missing = [
        ...(description === undefined ? ['description'] : []),
        ...(tools === undefined ? [list.name] : []),
      ];
      return refuse(
        `${headerForm}; ${formatWordList(
          missing.map((name) => `\`${name}\``),
          'and',
        )} ${missing.length === 1 ? 'is' : 'are'} not declared there`,
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
      if (tools !== undefined)
        return refuse(`\`${list.name}\` is declared twice`);
      if (take(/\[/) === null) return refuse(wrong.list);
      const names: string[] = [];
      for (;;) {
        skip();
        if (take(/\]/) !== null) break;
        const name = quoted();
        if (name === undefined || !/^\S+$/.test(name))
          return refuse(wrong.list);
        names.push(name);
        skip();
        if (take(/,/) !== null) continue;
        if (take(/\]/) !== null) break;
        return refuse(wrong.list);
      }
      skip();
      // As above: `[...].concat(more)` is an expression.
      if (take(/;/) === null) return refuse(wrong.list);
      tools = names;
    }
  }
  return Result.succeed({ description, names: tools });
}

/** A directory of program files, and whose they are. */
interface ProgramFiles {
  /** The directory, absolute. */
  readonly root: string;
  /** What its programs' names begin with: `<name>.js` is `<prefix>:<name>`. */
  readonly prefix: string;
  /** How a message names its file `entry`, or the directory itself (`''`). */
  readonly named: (entry: string) => string;
}

/**
 * The programs in the directory `root`: every `<name>.js`, read as text and
 * never run. A file whose name is not lowercase letters, digits and
 * hyphens, that is a link (the loader follows none, so no program comes
 * from outside the directory), that cannot be read or that does not begin
 * with its two declarations is refused by name and the others load; entries
 * that are not `.js` files are not programs. Never fails.
 */
export const readPrograms = Effect.fn('readPrograms')(function* ({
  root,
  prefix,
  named,
}: ProgramFiles): Effect.fn.Return<
  PluginPrograms,
  never,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const refusal = (entry: string, reason: string) =>
    `Program ${named(entry)} is not loaded: ${reason}.`;
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
          refused: [refusal('', listed.failure.message)],
        };
  if (listed.success === undefined)
    return {
      loaded: [],
      refused: [refusal('', 'it is not a directory (a link is not followed)')],
    };
  const read = yield* Effect.forEach(
    listed.success,
    (entry) =>
      Effect.gen(function* () {
        const refused = (reason: string) => Result.fail(refusal(entry, reason));
        const base = entry.slice(0, -'.js'.length);
        if (!PROGRAM_NAME.test(base))
          return refused(
            'its name must be lowercase letters, digits and hyphens',
          );
        const declared = yield* readDeclaredFile(path.join(root, entry), USES);
        if (declared === null) return refused('it is no longer there');
        if (Result.isFailure(declared)) return refused(declared.failure);
        const { description, names, source } = declared.success;
        return Result.succeed({
          name: `${prefix}:${base}`,
          description,
          tools: names,
          source,
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

/** The programs the plugin `plugin` at `dir` carries: those of its
 *  `programs/` directory, each started as `<plugin>:<name>`. */
export const readPluginPrograms = (
  dir: string,
  plugin: string,
): Effect.Effect<PluginPrograms, never, FileSystem.FileSystem> =>
  readPrograms({
    root: path.join(dir, PROGRAMS_DIRECTORY),
    prefix: plugin,
    named: (entry) =>
      `${path.join(PROGRAMS_DIRECTORY, entry)} of plugin ${plugin}`,
  });
