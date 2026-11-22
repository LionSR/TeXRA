/**
 * A native plugin hot-plugged into a running session, over a real store on
 * the validation model (`GOLDEN-NATIVE`, `validationModel.ts`): the run
 * installs and enables a plugin folder whose `harness.mjs` adds the tool
 * `native_echo`, which answers the revision of the process layer it was
 * served by. The module writes what happens to it (its layer's acquire and
 * release, each call) to `events.log` beside the plugin folder, and a call
 * told to wait for `<n>` waits for the file `release-<n>` there.
 *
 * Failure modes:
 * - a plugin enabled mid-run is not offered until the run restarts, or is
 *   offered at the step that enabled it;
 * - a replaced plugin interrupts the call its old revision is running, or
 *   runs that call on the new revision;
 * - a replaced plugin's entry runs a module it imports as the plugin shipped
 *   it before the replacement;
 * - the replaced revision's layer is never released, or the new one is
 *   built more than once;
 * - a revision that fails to import fails the step or the other tools, or
 *   drops the revision in use, or is imported again, or the step does not
 *   say why;
 * - the person is not asked to trust the native code, the question does
 *   not say it runs inside the process, or it is asked as a shell command;
 * - a policy or a grant that approves every call trusts native code with no
 *   person asked, first or again after a person disabled it;
 * - a native tool that declares no approval runs without asking, where an
 *   MCP server's tool would ask;
 * - a native tool that fails, dies, throws (in its body or outside any
 *   effect) or never finishes takes the run or the process down, or fails
 *   with a message that does not name its plugin;
 * - a revision whose process layer fails to build fails the step, or is
 *   offered with no reason given;
 * - a native plugin's session layer or program is not served, or its
 *   program cannot reach its tools;
 * - disabling a plugin interrupts its running call, or leaves its tool
 *   offered or its layer up;
 * - a resumed run reruns a call its row finished, or reruns an unfinished
 *   call on a revision other than the one it was issued to, or does not
 *   offer the revision loaded now;
 * - a native plugin that runs on another native plugin is withheld when its
 *   name sorts before that plugin's.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { type Context, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { assert, describe, expect, it } from 'vitest';

import { InstalledPlugins } from '@common/plugins/installedPlugins';
import { resumeRun } from '@agent/runtime/resumeRun';
import { SKIPPED_OUTCOME_UNKNOWN } from '@agent/runtime/run/tools';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/worldline/schemas';
import {
  answersOf,
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  untilStored,
  validationHost,
  waitingAfter,
} from '@test/support/storeFaults';
import { setTestApprovalPolicy } from '@test/support/sessionTestUtils';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { toolTable, withNatives } from '@tools/toolTable';

import { autoDecideRequests } from '../agent/progressTestUtils';

/** What a revision of the test plugin adds to its echo, or how it fails. */
interface EntryOptions {
  /** It throws as the module is imported. */
  readonly broken?: boolean;
  /** Its process layer fails to build. */
  readonly layerFails?: boolean;
  /** Tools that fail, die, throw and never finish, and a fiber in its
   *  process layer that dies once the layer is up. */
  readonly faulty?: boolean;
  /** A session layer, the tool `native_session` that answers what it
   *  serves, and the program `echo_program`, which echoes and says so. */
  readonly session?: boolean;
}

/** The program `session` adds: it calls `native_echo` and says what it
 *  answered. */
const ECHO_PROGRAM = `export default async () => {
  const echoed = await tools.native_echo({});
  return 'program ran: ' + echoed.output;
};
`;

/** The plugin's `harness.mjs` at `revision`: a tool that answers the
 *  revision the module beside it (`shipped.mjs`) names, on the process
 *  layer of its own, waiting for `release-<n>` in `base` when told to wait
 *  for `<n>`, with what `options` add. It writes to `base` by its path: the
 *  entry runs from a copy of the plugin, not from the plugin's folder. */
const entry = (
  revision: string,
  base: string,
  options: EntryOptions = {},
) => `// A test plugin.
export const description = 'Echoes the revision that serves the call.';
export const provides = ['tool:native_echo', ${options.faulty ? `'tool:native_fail', 'tool:native_die', 'tool:native_throw', 'tool:native_raw', 'tool:native_hang', ` : ''}${options.session ? `'tool:native_session', 'sessionLayer', 'module:echo_program', 'program:echo_program', ` : ''}'processLayer'];

import { appendFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { shipped } from './shipped.mjs';

${options.broken ? `throw new Error('${revision} is broken');` : ''}
const note = (line) =>
  appendFileSync(path.join(${JSON.stringify(base)}, 'events.log'), line + '\\n');

export default ({ plugins, effect }) => {
  const { Context, Effect, Layer, Schema } = effect;
  class Revision extends Context.Service()('echoes/Revision') {}
  const layer = Layer.effect(Revision)(
    ${
      options.layerFails
        ? `Effect.fail(new Error('${revision} cannot reach its service'))`
        : `Effect.acquireRelease(
      Effect.sync(() => (note('acquire ${revision}'), '${revision}')),
      () => Effect.sync(() => note('release ${revision}')),
    )${
      options.faulty
        ? `.pipe(Effect.tap(() => Effect.forkScoped(Effect.die(new Error('the daemon died')))))`
        : ''
    }`
    },
  );
  class Session extends Context.Service()('echoes/Session') {}
  const sessionLayer = Layer.effect(Session)(
    Effect.acquireRelease(
      Effect.sync(() => (note('session acquire ${revision}'), 'session ${revision}')),
      () => Effect.sync(() => note('session release ${revision}')),
    ),
  );
  const native_echo = plugins.defineTool({
    name: 'native_echo',
    description: 'Answer the revision of the plugin that served this call.',
    replay: 'safe',
    schema: Schema.Struct({ wait: Schema.optional(Schema.NullOr(Schema.String)) }),
    execute: ({ wait }) =>
      Effect.gen(function* () {
        const revision = yield* Revision;
        note('call ' + revision);
        if (wait) {
          const released = path.join(${JSON.stringify(base)}, 'release-' + wait);
          yield* Effect.callback((resume) => {
            const timer = setInterval(() => {
              if (existsSync(released)) {
                clearInterval(timer);
                resume(Effect.void);
              }
            }, 20);
            return Effect.sync(() => clearInterval(timer));
          });
        }
        note('done ' + revision);
        return 'echo ' + shipped;
      }),
  });
  const faulty = (name, execute) =>
    plugins.defineTool({ name, description: name, schema: Schema.Struct({}), execute });
  return plugins.definePlugin({
    id: 'echoes',
    tools: [
      native_echo,
      ${
        options.faulty
          ? `faulty('native_fail', () => Effect.fail(new Error('a typed failure'))),
      faulty('native_die', () => Effect.die(new Error('a defect'))),
      faulty('native_throw', () => {
        throw new Error('a synchronous throw');
      }),
      {
        definition: { name: 'native_raw', description: 'native_raw', parameters: { type: 'object', properties: {} } },
        call: () => {
          throw new Error('a throw outside any effect');
        },
      },
      faulty('native_hang', () =>
        Effect.sync(() => note('hang')).pipe(Effect.andThen(Effect.never)),
      ),`
          : ''
      }
      ${
        options.session
          ? `plugins.defineTool({
        name: 'native_session',
        description: 'Answer what the session layer serves.',
        schema: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            return yield* Session;
          }),
      }),`
          : ''
      }
    ],
    processLayer: { layer },
    ${
      options.session
        ? `sessionLayer,
    scriptModules: { echo_program: ${JSON.stringify(ECHO_PROGRAM)} },
    programs: {
      echo_program: { description: 'Echo, and say so.', tools: ['native_echo'] },
    },`
        : ''
    }
  });
};
`;

/** Where the plugin and what it writes live, under the host's root. */
const pluginFiles = Effect.map(FakeHost, (host) => {
  const base = host.path('plugins');
  const dir = path.join(base, 'echoes');
  return {
    dir,
    events: path.join(base, 'events.log'),
    /** Let the `n`th waiting call finish. */
    release: (n: number) => writeFileSync(path.join(base, `release-${n}`), ''),
    /** Write the plugin's manifest and its entry at `revision`. */
    write: (revision: string, options?: EntryOptions) => {
      mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'echoes', version: '1.0.0' }),
      );
      writeFileSync(
        path.join(dir, 'shipped.mjs'),
        `export const shipped = '${revision}';\n`,
      );
      writeFileSync(
        path.join(dir, 'harness.mjs'),
        entry(revision, base, options),
      );
    },
  };
});

/** Wait, polling the store in real time, until `ready` holds: the test
 *  clock moves only where a case moves it. */
const until = (storage: string, ready: Parameters<typeof untilStored>[1]) =>
  TestClock.withLive(untilStored(storage, ready));

/** The lines the plugin wrote so far. */
const eventsIn = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];

/** What `runId`'s tool calls answered, in commit order. */
const toolOutputs = (storage: string, runId: RunId): string[] =>
  storedRows(storage).flatMap((row) => {
    if (row.run !== runId || row.type !== 'tool.result') return [];
    const echoed = /(?:session |program ran: )?echo rev\d|session rev\d/.exec(
      row.data,
    )?.[0];
    if (echoed !== undefined) return [echoed];
    if (row.data.includes('Installed echoes')) return ['installed'];
    if (row.data.includes('Enabled echoes')) return ['enabled'];
    return ['other'];
  });

/** The errors `runId`'s failed tool calls answered, in commit order. */
const toolErrors = (storage: string, runId: RunId): string[] =>
  storedRows(storage).flatMap((row) => {
    if (row.run !== runId || row.type !== 'tool.result') return [];
    const { error } = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          payload: Schema.Struct({
            result: Schema.Struct({ error: Schema.optional(Schema.String) }),
          }),
        }),
      ),
    )(row.data).payload.result;
    return error === undefined ? [] : [error];
  });

/** Start the native run on `session` with `task` after the install
 *  sentence, approving every request it opens, and wait until its first
 *  turn ended (or, `started` false, only start it). */
const start = Effect.fn('start')(function* (
  session: Context.Context<SessionServices>,
  task: string,
  started = true,
) {
  const { roots } = yield* FakeHost;
  const { dir } = yield* pluginFiles;
  const decided = yield* autoDecideRequests(session, () => ({
    action: 'approve',
  }));
  const runId = generateRunId();
  yield* rootRun({
    runId,
    interactive: true,
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      label: 'golden_native',
      system: 'GOLDEN-NATIVE: equip yourself with a plugin.',
      tools: ['read_file'],
      model: 'openai/gpt-5.6-sol',
      instruction: `Install the plugin at ${dir}. ${task}`,
    }),
  }).pipe(Effect.provide(session), Effect.forkScoped);
  if (started)
    yield* until(roots.storage, waitingAfter(runId, 1, roots.storage));
  return { runId, decided };
});

/** While the `n`th call waits: write the plugin at `revision`, trust it as
 *  the CLI's `plugin enable` does, and let the call finish. */
const replaceDuringCall = Effect.fn('replaceDuringCall')(function* (
  n: number,
  revision: string,
  options?: EntryOptions,
) {
  const { roots } = yield* FakeHost;
  const files = yield* pluginFiles;
  yield* until(
    roots.storage,
    () =>
      eventsIn(files.events).filter((line) => line.startsWith('call '))
        .length >= n,
  );
  files.write(revision, options);
  yield* InstalledPlugins.enable('echoes', roots, () => Effect.succeed(true));
  files.release(n);
});

/** A run that pinned revision 1: its reply's first call finished on it,
 *  and its second was waiting on it when the run's session closed. */
const interruptedOnRevision1 = Effect.gen(function* () {
  const { roots } = yield* FakeHost;
  const files = yield* pluginFiles;
  files.write('rev1');
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* persistentTestSession();
      const { runId } = yield* start(
        session,
        'Echo, then echo waiting, in one reply.',
        false,
      );
      yield* until(
        roots.storage,
        () =>
          eventsIn(files.events).filter((line) => line === 'call rev1')
            .length >= 2,
      );
      return runId;
    }),
  );
});

/** Resume `runId` in a session of its own, approving what it asks, and
 *  wait for its answer. */
const resumeOver = Effect.fn('resumeOver')(function* (runId: RunId) {
  const { roots } = yield* FakeHost;
  const session = yield* persistentTestSession();
  yield* autoDecideRequests(session, () => ({ action: 'approve' }));
  yield* resumeRun(runId, {}).pipe(Effect.provide(session));
  yield* until(roots.storage, waitingAfter(runId, 1, roots.storage));
});

describe(
  'a native plugin hot-plugged into a session',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(SessionGraph.hosted)((it) => {
      it.layer(validationHost('texra-native-'), { buildPerTest: true })(
        (it) => {
          it.effect('is offered from the step after the person trusts it', () =>
            Effect.gen(function* () {
              const { roots } = yield* FakeHost;
              const files = yield* pluginFiles;
              files.write('rev1');
              const session = yield* persistentTestSession();
              const { runId, decided } = yield* start(session, 'Echo once.');
              // Step 1 offered no `native_echo` (the model would have called
              // it); step 3 did, and its call ran on the plugin's layer.
              expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                'installed',
                'enabled',
                'echo rev1',
              ]);
              expect(eventsIn(files.events)).toStrictEqual([
                'acquire rev1',
                'call rev1',
                'done rev1',
              ]);
              // The person was asked to trust it, and told what the code
              // is; then the call asked as an MCP tool's does, though the
              // tool declares no approval.
              const [trust, echo, ...more] = decided.opened;
              expect(more).toStrictEqual([]);
              expect(JSON.stringify(trust)).toContain(
                'runs inside this process, as you',
              );
              expect(JSON.stringify(trust)).toContain('tools native_echo');
              // Asked as trusting a plugin, not as a command.
              assert(trust?.payload.kind === 'pluginTrust');
              const {
                plugin,
                version,
                path: folder,
                native,
              } = trust.payload.data;
              expect({ plugin, version, folder, native }).toStrictEqual({
                plugin: 'echoes',
                version: '1.0.0',
                folder: files.dir,
                native: true,
              });
              expect(echo?.answeredBy).toBe('superYolo');
              expect(JSON.stringify(echo?.payload)).toContain(
                'plugin echoes native_echo {}',
              );
              expect(answersOf(roots.storage, runId)).toStrictEqual([
                'Echoed.',
              ]);
            }),
          );

          it.effect(
            'asks the person to trust it under a policy that approves every call',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1');
                yield* setTestApprovalPolicy('yolo');
                const session = yield* persistentTestSession();
                const { runId, decided } = yield* start(session, 'Echo once.');
                // `yolo` answers the install's and every other call's
                // approval; trusting the native module is the person's.
                const [trust, ...more] = decided.opened;
                expect(more).toStrictEqual([]);
                expect(trust?.answeredBy).toBe('person');
                expect(JSON.stringify(trust)).toContain(
                  'runs inside this process, as you',
                );
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                ]);
              }),
          );

          it.effect(
            'asks the person again to load native code they trusted and then disabled',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1');
                yield* setTestApprovalPolicy('yolo');
                const session = yield* persistentTestSession();
                yield* start(session, 'Echo once.');
                yield* InstalledPlugins.disable('echoes', roots);
                const { runId, decided } = yield* start(
                  session,
                  'Enable echoes again.',
                );
                // Trusted as it is, and still the person's own answer.
                const [again, ...more] = decided.opened;
                expect(more).toStrictEqual([]);
                expect(again?.answeredBy).toBe('person');
                expect(again?.payload.kind).toBe('pluginTrust');
                expect(answersOf(roots.storage, runId)).toStrictEqual([
                  'Enabled again.',
                ]);
              }),
          );

          it.effect(
            'fails only the call of a tool that fails, dies, throws or never finishes, naming the plugin',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1', { faulty: true });
                yield* setTestApprovalPolicy('yolo');
                const session = yield* persistentTestSession();
                const { runId } = yield* start(
                  session,
                  'Call native_fail, native_die, native_throw, native_raw, native_hang in turn.',
                  false,
                );
                // The call that never finishes runs into its deadline.
                yield* until(roots.storage, () =>
                  eventsIn(files.events).includes('hang'),
                );
                yield* TestClock.adjust('61 seconds');
                yield* until(
                  roots.storage,
                  waitingAfter(runId, 1, roots.storage),
                );
                expect(toolErrors(roots.storage, runId)).toStrictEqual([
                  'native_fail of plugin echoes failed: a typed failure',
                  'native_die of plugin echoes failed: a defect',
                  'native_throw of plugin echoes failed: a synchronous throw',
                  'native_raw of plugin echoes failed: a throw outside any effect',
                  'native_hang of plugin echoes did not finish within 60s.',
                ]);
                // The run went on, on the layer whose fiber died.
                expect(toolOutputs(roots.storage, runId).at(-1)).toBe(
                  'echo rev1',
                );
                expect(answersOf(roots.storage, runId)).toStrictEqual([
                  'Echoed.',
                ]);
              }),
          );

          it.effect(
            'withholds a revision whose process layer fails to build, with its reason',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1', { layerFails: true });
                const session = yield* persistentTestSession();
                const { runId } = yield* start(session, 'Echo once.');
                const [answer] = answersOf(roots.storage, runId);
                expect(answer).toContain('native_echo is not offered');
                expect(answer).toContain('plugin_manager');
                expect(
                  storedRows(roots.storage).some(
                    (row) =>
                      row.run === runId &&
                      row.data.includes('rev1 cannot reach its service'),
                  ),
                ).toBe(true);
              }),
          );

          it.effect(
            'serves its session layer, and starts its program by name with its tools',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1', { session: true });
                yield* setTestApprovalPolicy('yolo');
                const session = yield* persistentTestSession();
                const { runId } = yield* start(
                  session,
                  'Call native_session in turn.',
                );
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'session rev1',
                  'echo rev1',
                ]);
                // The program, started by name as its own run.
                const program = generateRunId();
                yield* rootRun({
                  runId: program,
                  interactive: true,
                  config: Schema.decodeUnknownSync(AgentConfigSchema)({
                    label: 'echo_program',

                    model: 'openai/gpt-5.6-sol',
                    script: { kind: 'program', name: 'echo_program', args: {} },
                  }),
                }).pipe(Effect.provide(session), Effect.forkScoped);
                yield* until(roots.storage, (rows) =>
                  rows.some(
                    (row) => row.run === program && row.type === 'run.end',
                  ),
                );
                const end = storedRows(roots.storage).find(
                  (row) => row.run === program && row.type === 'run.end',
                );
                expect(end?.data).toContain('program ran: echo rev1');
                // Its call of the plugin's tool, then its script's answer.
                expect(toolOutputs(roots.storage, program)).toStrictEqual([
                  'echo rev1',
                  'program ran: echo rev1',
                ]);
                // One session layer for the session, beside the process
                // layer.
                expect(
                  eventsIn(files.events).filter((line) =>
                    /^(session )?acquire/.test(line),
                  ),
                ).toStrictEqual(['acquire rev1', 'session acquire rev1']);
              }),
          );

          it.effect(
            'lets a running call finish when its plugin is disabled, then offers none of it and releases its layer',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1');
                const session = yield* persistentTestSession();
                const { runId } = yield* start(
                  session,
                  'Echo twice, the first waiting.',
                  false,
                );
                yield* until(roots.storage, () =>
                  eventsIn(files.events).includes('call rev1'),
                );
                yield* InstalledPlugins.disable('echoes', roots);
                files.release(1);
                yield* until(
                  roots.storage,
                  waitingAfter(runId, 1, roots.storage),
                );
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                ]);
                const [answer] = answersOf(roots.storage, runId);
                expect(answer).toContain('native_echo is not offered');
                expect(eventsIn(files.events)).toStrictEqual([
                  'acquire rev1',
                  'call rev1',
                  'done rev1',
                  'release rev1',
                ]);
              }),
          );

          it.effect(
            'resumes a run that pinned revision 1 after revision 2 is trusted: a finished call is handed back, an unfinished one is not run again, and the next step runs revision 2',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                const runId = yield* interruptedOnRevision1;
                files.write('rev2');
                yield* InstalledPlugins.enable('echoes', roots, () =>
                  Effect.succeed(true),
                );
                yield* resumeOver(runId);
                // The first call's result is its row's; the second, which
                // the stop cut, ran on a revision the run no longer has, so
                // its outcome is unknown and the model decides, on the
                // revision loaded now.
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                  'other',
                  'echo rev2',
                ]);
                expect(toolErrors(roots.storage, runId)).toStrictEqual([
                  SKIPPED_OUTCOME_UNKNOWN,
                ]);
                expect(
                  eventsIn(files.events).filter((line) =>
                    line.startsWith('call'),
                  ),
                ).toStrictEqual(['call rev1', 'call rev1', 'call rev2']);
              }),
          );

          it.effect(
            'resumes a run whose plugin was disabled: the unfinished call is not run again and the tool is gone',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const runId = yield* interruptedOnRevision1;
                yield* InstalledPlugins.disable('echoes', roots);
                yield* resumeOver(runId);
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                  'other',
                ]);
                expect(toolErrors(roots.storage, runId)).toStrictEqual([
                  SKIPPED_OUTCOME_UNKNOWN,
                ]);
                const [answer] = answersOf(roots.storage, runId);
                expect(answer).toContain('native_echo is not offered');
              }),
          );

          it.effect(
            'finishes a running call on its revision and serves the next step from the new one',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1');
                const session = yield* persistentTestSession();
                const { runId } = yield* start(
                  session,
                  'Echo twice, the first waiting.',
                  false,
                );
                yield* replaceDuringCall(1, 'rev2');
                yield* until(
                  roots.storage,
                  waitingAfter(runId, 1, roots.storage),
                );
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                  'echo rev2',
                ]);
                const events = eventsIn(files.events);
                expect(
                  events.filter((line) => line.startsWith('acquire')),
                ).toStrictEqual(['acquire rev1', 'acquire rev2']);
                // Revision 1 went down only after its call finished, and before
                // revision 2 served a call.
                expect(events.indexOf('done rev1')).toBeLessThan(
                  events.indexOf('release rev1'),
                );
                expect(events.indexOf('release rev1')).toBeLessThan(
                  events.indexOf('call rev2'),
                );
                expect(events).not.toContain('release rev2');
              }),
          );

          it.effect(
            'keeps the revision in use when its replacement throws at import, until a fixed one replaces it',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const files = yield* pluginFiles;
                files.write('rev1');
                const session = yield* persistentTestSession();
                const { runId } = yield* start(
                  session,
                  'Echo three times, the first two waiting.',
                  false,
                );
                yield* replaceDuringCall(1, 'rev2', { broken: true });
                yield* replaceDuringCall(2, 'rev3');
                yield* until(
                  roots.storage,
                  waitingAfter(runId, 1, roots.storage),
                );
                // The step after revision 2 failed still ran revision 1;
                // the one after revision 3 was trusted ran it.
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                  'other',
                  'echo rev1',
                  'echo rev3',
                ]);
                // The listing between them named the revision in use and
                // the one that did not load.
                const listing = storedRows(roots.storage).find(
                  (row) =>
                    row.run === runId &&
                    row.type === 'tool.result' &&
                    row.data.includes('Installed plugins:'),
                );
                expect(listing?.data).toMatch(
                  /native module: revision [0-9a-f]{12} in use/,
                );
                expect(listing?.data).toContain('trusted now, did not load');
                // The step said why, once, naming the revision that stays.
                const warned = storedRows(roots.storage).filter(
                  (row) =>
                    row.run === runId &&
                    row.data.includes('importing it threw: rev2 is broken') &&
                    row.data.includes(
                      'stays in use until the plugin is fixed or disabled',
                    ),
                );
                expect(warned).toHaveLength(1);
                // Revision 2 never came up; revision 1 went down once, after
                // revision 3 came up and before it served a call.
                const events = eventsIn(files.events);
                expect(
                  events.filter((line) => /^(acquire|release)/.test(line)),
                ).toStrictEqual([
                  'acquire rev1',
                  'acquire rev3',
                  'release rev1',
                ]);
                expect(events.indexOf('release rev1')).toBeLessThan(
                  events.indexOf('call rev3'),
                );
              }),
          );
        },
      );
    });
  },
);

describe('native plugins that run on each other', () => {
  it('load whatever their names, and a cycle is withheld', () => {
    const native = (id: string, requires: readonly string[]) => ({
      plugin: { id, requires },
      revision: `${id}@1`,
    });
    const { table, withheld } = withNatives(toolTable([]), [
      native('plugin:a', ['plugin:z']),
      native('plugin:z', []),
      native('plugin:b', ['plugin:c']),
      native('plugin:c', ['plugin:b']),
    ]);
    expect([...table.entries.keys()]).toStrictEqual(['plugin:z', 'plugin:a']);
    expect(
      withheld.map(({ native, reason }) => [native.plugin.id, reason]),
    ).toStrictEqual([
      [
        'plugin:b',
        'plugin plugin:b runs on plugin plugin:c, which is not listed.',
      ],
      [
        'plugin:c',
        'plugin plugin:c runs on plugin plugin:b, which is not listed.',
      ],
    ]);
  });
});
