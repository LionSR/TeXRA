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
import { Effect, FileSystem, Result, Schema, SchemaIssue } from 'effect';

import { readOwnPrograms } from '@agent/memory/ownPrograms';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AGENT_SOURCE,
  backgroundScriptOf,
  factName,
  programOf,
  programOrigin,
  type AgentConfig,
  type ProgramOrigin,
  type RunId,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { SessionLog } from '@shared/session/runHistory';
import { escapeAttr } from '@shared/utils/xmlEscape';
import {
  ToolRegistry,
  type Program,
  type ProgramChange,
} from '@tools/toolTable';

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
interface ScriptCall {
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
 * Every program a run of the project at `roots` can open on now, by name:
 * those the plugin list registers, those of the installed plugins that load
 * now (enabled, and trusted as they are), each under `<plugin>:<name>`, and
 * those the project's agent wrote for itself, each under `own:<name>`; a
 * program read from a file has the description and tools its file
 * declares. `withheld` says why an enabled plugin or a program file is not
 * loaded.
 */
export const programsNow = Effect.fn('programsNow')(function* (
  roots: Pick<WorkspaceRoots, 'storage'>,
) {
  const { programs } = yield* ToolRegistry;
  const installed = yield* readInstalledPluginLoad({
    globalState: yield* AppState,
  });
  // The agent's own last: no plugin holds their prefix.
  const fromFiles = [
    ...installed.loadable.map(({ plugin }) => plugin.programs),
    yield* readOwnPrograms(roots.storage),
  ];
  return {
    programs: new Map<string, Program>([
      ...programs,
      ...fromFiles.flatMap(({ loaded }) =>
        loaded.map(
          ({ name, description, tools }) =>
            [name, { description, tools }] as const,
        ),
      ),
    ]),
    withheld: [
      ...installed.withheld.map(({ reason }) => reason),
      ...fromFiles.flatMap(({ refused }) => refused),
    ],
  };
});

/** The program started by `name` in the project at `roots`. The program
 *  files are read only for a name of theirs. */
const registeredProgram = Effect.fn('registeredProgram')(function* (
  name: string,
  roots: Pick<WorkspaceRoots, 'storage'>,
): Effect.fn.Return<
  Program,
  ProgramNotRegistered,
  ToolRegistry | AppState | FileSystem.FileSystem
> {
  const registered = (yield* ToolRegistry).programs.get(name);
  if (registered !== undefined) return registered;
  const { programs, withheld } =
    programOrigin(name) === 'listed'
      ? { programs: (yield* ToolRegistry).programs, withheld: [] }
      : yield* programsNow(roots);
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
 * tools (its script is all it runs), and it writes the program's own
 * outputs unless the launch names files other than its inputs.
 */
export const programLaunch = Effect.fn('programLaunch')(function* (
  name: string,
  args: Readonly<Record<string, Schema.Json>>,
  files: Pick<AgentConfig, 'inputFiles' | 'outputFiles'>,
  roots: Pick<WorkspaceRoots, 'storage'>,
) {
  const program = yield* registeredProgram(name, roots);
  const named = files.outputFiles.filter(Boolean);
  return {
    agent: name,
    agentSource: { kind: AGENT_SOURCE.INLINE, persona: {} },
    outputFiles: named.some((file) => !files.inputFiles.includes(file))
      ? named
      : [...(program.outputs ?? [])],
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

/** A program run's value as its registration reads it. */
interface ProgramRunResult {
  /** The program's name (`kind` on the delivery). */
  readonly name: string;
  /** The delivery body; empty when the program registers no result. */
  readonly delivery: readonly string[];
  readonly changes: readonly ProgramChange[];
}

/**
 * The result of the completed run `runId`, launched with `config`, or
 * undefined for a run that is no program's (or has no recorded config). A
 * program that registers no result reports no files. A run of a program no
 * plugin registers, with no row of the result's fact kind, or with a row
 * its schema refuses, is logged and read as no files; the refusal is also
 * the delivery, so the launching model sees it.
 */
export const readProgramResult = Effect.fn('readProgramResult')(function* (
  config: Pick<AgentConfig, 'script'> | null,
  runId: RunId,
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Effect.fn.Return<
  ProgramRunResult | undefined,
  DatabaseReadFailed,
  ToolRegistry | SessionLog
> {
  const program = config === null ? null : programOf(config);
  if (program === null) return undefined;
  const { name } = program;
  const refused = (reason: string) =>
    Effect.logWarning(
      `Run ${runId} of the program '${name}' reports nothing its registration reads: ${reason}`,
    ).pipe(
      withLogChannel('ProgramResult'),
      Effect.as({
        name,
        delivery: [`<invalid-result reason="${escapeAttr(reason)}" />`],
        changes: [],
      }),
    );
  // A program read from a file registers no result: its run delivers its
  // reply alone.
  if (programOrigin(name) !== 'listed')
    return { name, delivery: [], changes: [] };
  const { programs } = yield* ToolRegistry;
  const registered = programs.get(name);
  if (registered === undefined)
    return yield* refused(
      new ProgramNotRegistered({
        name,
        registered: [...programs.keys()],
        withheld: [],
      }).message,
    );
  const { result } = registered;
  if (result === undefined) return { name, delivery: [], changes: [] };
  const { schema } = result.fact;
  const fact = factName(result.fact);
  const row = (yield* (yield* SessionLog).facts(runId))?.facts[fact];
  if (row === undefined)
    return yield* refused(`the run recorded no '${fact}' row`);
  const parsed = Schema.decodeUnknownResult(schema)(row.value, {
    errors: 'all',
  });
  if (Result.isFailure(parsed)) {
    return yield* refused(
      SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue)
        .issues.map(
          ({ path, message }) =>
            `${(path ?? []).map(String).join('.') || 'value'}: ${message}`,
        )
        .join('; '),
    );
  }
  return {
    name,
    delivery: result.delivery(parsed.success, runId),
    changes: result.changes(parsed.success, roots),
  };
});
