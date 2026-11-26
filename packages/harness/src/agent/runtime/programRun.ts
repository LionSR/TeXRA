/**
 * A script's run: the one `script` call a run opened on
 * (`AgentConfig.script`) makes, and what a completed program's run reports.
 * A background script records its call whole. A program records its name
 * and arguments; its call is two generated lines over the module its plugin
 * registers (`Plugin.programs`) or, for a program read from a file (an
 * installed plugin's `<plugin>:<name>`, the agent's own `own:<name>`), the
 * module that file holds, and its tools are the ones its registration or
 * its file lists for it.
 */
import { Effect, FileSystem, Schema } from 'effect';

import { readOwnPrograms } from '@agent/memory/ownPrograms';
import type { PluginPrograms } from '@common/plugins/pluginPrograms';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import { AppState } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  backgroundScriptOf,
  programOf,
  programOrigin,
  type AgentConfig,
  type ProgramOrigin,
} from '@shared/schemas';
import { ToolRegistry, type Program } from '@tools/toolTable';

/**
 * The script a program's run makes: import the program's module (a
 * registered one is `builtIn:<name>`, one read from a file is its own
 * name) and call its default export with its own `args` and the launch's
 * instruction and files. What that resolves to is the script's return, so
 * the run ends with it as its output.
 */
const programScript = (
  name: string,
  args: Readonly<Record<string, Schema.Json>>,
  launch: Pick<
    AgentConfig,
    'instruction' | 'inputFiles' | 'contextFiles' | 'mediaFiles'
  >,
): string =>
  `const { default: program } = await import(${JSON.stringify(
    (
      {
        listed: `builtIn:${name}`,
        installed: name,
        own: name,
      } satisfies Record<ProgramOrigin, string>
    )[programOrigin(name)],
  )});
return await program(${JSON.stringify(args)}, ${JSON.stringify({
    instruction: launch.instruction,
    inputFiles: launch.inputFiles,
    contextFiles: launch.contextFiles,
    mediaFiles: launch.mediaFiles,
  })});`;

/** The `script` call a run opened on `script` makes, and the tools its run
 *  offers that call. */
export interface ScriptCall {
  readonly code: string;
  readonly title: string;
  readonly tools: readonly string[];
  readonly timeoutMs?: number | null;
}

/** A run names a program no plugin offers: an earlier build's run, one of
 *  a plugin this process does not load, or one read from a file that is
 *  not loaded now (`withheld` says why). */
export class ProgramNotRegistered extends Schema.TaggedError<ProgramNotRegistered>()(
  'ProgramNotRegistered',
  {
    name: Schema.String,
    registered: Schema.Array(Schema.String),
    withheld: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return [
      `No plugin registers a program named '${this.name}'. The programs are: ${this.registered.join(', ') || 'none'}.`,
      ...this.withheld,
    ].join(' ');
  }
}

/**
 * The programs read from files of one origin in the project at `roots`:
 * those of the installed plugins that load now (enabled, and trusted as
 * they are), each under `<plugin>:<name>`, or those the project's agent
 * wrote for itself, each under `own:<name>`. `refused` says why an enabled
 * plugin or a program file is not loaded.
 */
const programFiles = {
  installed: Effect.fn('installedPrograms')(function* () {
    const { loadable, withheld } = yield* readInstalledPluginLoad({
      globalState: yield* AppState,
    });
    return {
      loaded: loadable.flatMap(({ plugin }) => plugin.programs.loaded),
      refused: [
        ...withheld.map(({ reason }) => reason),
        ...loadable.flatMap(({ plugin }) => plugin.programs.refused),
      ],
    };
  }),
  own: (roots: Pick<WorkspaceRoots, 'storage'>) =>
    readOwnPrograms(roots.storage),
} satisfies Record<
  Exclude<ProgramOrigin, 'listed'>,
  (
    roots: Pick<WorkspaceRoots, 'storage'>,
  ) => Effect.Effect<PluginPrograms, never, AppState | FileSystem.FileSystem>
>;

/** The listed programs and those read from `files`, by name, and why a
 *  plugin or a file among them is not loaded. */
const programTable = (
  listed: ReadonlyMap<string, Program>,
  files: readonly PluginPrograms[],
) => ({
  programs: new Map<string, Program>([
    ...listed,
    ...files.flatMap(({ loaded }) =>
      loaded.map(
        ({ name, description, tools }) =>
          [name, { description, tools }] as const,
      ),
    ),
  ]),
  withheld: files.flatMap(({ refused }) => refused),
});

/**
 * Every program a run of the project at `roots` can open on now, by name:
 * those the plugin list registers and those read from files
 * ({@link programFiles}); a program read from a file has the description
 * and tools its file declares. `withheld` says why an enabled plugin or a
 * program file is not loaded.
 */
export const programsNow = Effect.fn('programsNow')(function* (
  roots: Pick<WorkspaceRoots, 'storage'>,
) {
  return programTable((yield* ToolRegistry).programs, [
    yield* programFiles.installed(),
    yield* programFiles.own(roots),
  ]);
});

/** The program started by `name` in the project at `roots`. Only the files
 *  of the name's origin are read: none for a listed program. */
const registeredProgram = Effect.fn('registeredProgram')(function* (
  name: string,
  roots: Pick<WorkspaceRoots, 'storage'>,
): Effect.fn.Return<
  Program,
  ProgramNotRegistered,
  ToolRegistry | AppState | FileSystem.FileSystem
> {
  const listed = (yield* ToolRegistry).programs;
  const origin = programOrigin(name);
  const { programs, withheld } = programTable(
    listed,
    origin === 'listed' ? [] : [yield* programFiles[origin](roots)],
  );
  const program = programs.get(name);
  if (program === undefined)
    return yield* new ProgramNotRegistered({
      name,
      registered: [...programs.keys()],
      withheld,
    });
  return program;
});

/**
 * What launches the program `name` as a run of its own in the project at
 * `roots`: the run is named for the program and has no agent's prompt or
 * tools (its script is all it runs). Fails for a program no plugin
 * registers now.
 */
export const programLaunch = Effect.fn('programLaunch')(function* (
  name: string,
  args: Readonly<Record<string, Schema.Json>>,
  roots: Pick<WorkspaceRoots, 'storage'>,
) {
  yield* registeredProgram(name, roots);
  return {
    label: name,
    script: { kind: 'program' as const, name, args },
  } satisfies Partial<AgentConfig>;
});

/** The call the script run of `config` makes in the project at `roots`
 *  ({@link ScriptCall}), or null for a run that asks its model. */
export const scriptCallOf = Effect.fn('scriptCallOf')(function* (
  config: AgentConfig,
  roots: Pick<WorkspaceRoots, 'storage'>,
): Effect.fn.Return<
  ScriptCall | null,
  ProgramNotRegistered,
  ToolRegistry | AppState | FileSystem.FileSystem
> {
  const background = backgroundScriptOf(config);
  if (background !== null) return background;
  const program = programOf(config);
  if (program === null) return null;
  const { tools } = yield* registeredProgram(program.name, roots);
  return {
    code: programScript(program.name, program.args, config),
    title: program.name,
    tools,
  };
});
