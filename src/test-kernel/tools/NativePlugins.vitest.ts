/**
 * A native plugin hot-plugged into a running session, over a real store on
 * the validation model (`GOLDEN-NATIVE`, `validationModel.ts`): the run
 * installs and enables a plugin folder whose `harness.mjs` adds the tool
 * `native_echo`, which answers the revision of the process layer it was
 * served by. The module writes what happens to it (its layer's acquire and
 * release, each call) to `events.log` beside the plugin folder, and a call
 * told to wait waits for the file `release` there.
 *
 * Failure modes:
 * - a plugin enabled mid-run is not offered until the run restarts, or is
 *   offered at the step that enabled it;
 * - a replaced plugin interrupts the call its old revision is running, or
 *   runs that call on the new revision;
 * - the replaced revision's layer is never released, or the new one is
 *   built more than once;
 * - a revision that fails to import fails the step or the other tools, or
 *   the step falls back to the previous revision;
 * - the person is not asked to trust the native code, or the question does
 *   not say it runs inside the process;
 * - a policy or a grant that approves every call trusts native code with no
 *   person asked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { type Context, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import { InstalledPlugins } from '@common/plugins/installedPlugins';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
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

import { autoDecideRequests } from '../agent/progressTestUtils';

/** The plugin's `harness.mjs` at `revision`: a tool that answers the
 *  revision its process layer serves, waiting for `../release` when asked.
 *  `broken` throws as the module is imported. */
const entry = (revision: string, broken = false) => `// A test plugin.
export const description = 'Echoes the revision that serves the call.';
export const provides = ['tool:native_echo', 'processLayer'];

import { appendFileSync, existsSync } from 'node:fs';

${broken ? `throw new Error('${revision} is broken');` : ''}
const note = (line) =>
  appendFileSync(new URL('../events.log', import.meta.url), line + '\\n');
const released = new URL('../release', import.meta.url);

export default ({ plugins, effect }) => {
  const { Context, Effect, Layer, Schema } = effect;
  class Revision extends Context.Service()('echoes/Revision') {}
  const layer = Layer.effect(Revision)(
    Effect.acquireRelease(
      Effect.sync(() => (note('acquire ${revision}'), '${revision}')),
      () => Effect.sync(() => note('release ${revision}')),
    ),
  );
  const native_echo = plugins.defineTool({
    name: 'native_echo',
    description: 'Answer the revision of the plugin that served this call.',
    schema: Schema.Struct({ wait: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
    execute: ({ wait }) =>
      Effect.gen(function* () {
        const revision = yield* Revision;
        note('call ' + revision);
        if (wait)
          yield* Effect.callback((resume) => {
            const timer = setInterval(() => {
              if (existsSync(released)) {
                clearInterval(timer);
                resume(Effect.void);
              }
            }, 20);
            return Effect.sync(() => clearInterval(timer));
          });
        note('done ' + revision);
        return 'echo ' + revision;
      }),
  });
  return plugins.definePlugin({
    id: 'echoes',
    tools: [native_echo],
    processLayer: { layer },
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
    release: path.join(base, 'release'),
    /** Write the plugin's manifest and its entry at `revision`. */
    write: (revision: string, broken = false) => {
      mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'echoes', version: '1.0.0' }),
      );
      writeFileSync(path.join(dir, 'harness.mjs'), entry(revision, broken));
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
    const echoed = /echo rev\d/.exec(row.data)?.[0];
    if (echoed !== undefined) return [echoed];
    if (row.data.includes('Installed echoes')) return ['installed'];
    if (row.data.includes('Enabled echoes')) return ['enabled'];
    return ['other'];
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
      agent: 'golden_native',
      agentSource: {
        kind: 'inline',
        persona: {
          prompt: 'GOLDEN-NATIVE: equip yourself with a plugin.',
          tools: ['read_file'],
        },
      },
      model: 'openai/gpt-5.6-sol',
      instruction: `Install the plugin at ${dir}. ${task}`,
    }),
  }).pipe(Effect.provide(session), Effect.forkScoped);
  if (started)
    yield* until(roots.storage, waitingAfter(runId, 1, roots.storage));
  return { runId, decided };
});

/** While revision 1's call waits: write the plugin at `revision`, trust
 *  it as the CLI's `plugin enable` does, and let the call finish. */
const replaceDuringCall = Effect.fn('replaceDuringCall')(function* (
  revision: string,
  broken = false,
) {
  const { roots } = yield* FakeHost;
  const files = yield* pluginFiles;
  yield* until(roots.storage, () =>
    eventsIn(files.events).includes('call rev1'),
  );
  files.write(revision, broken);
  yield* InstalledPlugins.enable('echoes', roots, () => Effect.succeed(true));
  writeFileSync(files.release, '');
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
              // The person was asked once, and told what the code is.
              const [trust, ...more] = decided.opened;
              expect(more).toStrictEqual([]);
              expect(JSON.stringify(trust)).toContain(
                'runs inside this process, as you',
              );
              expect(JSON.stringify(trust)).toContain('tools native_echo');
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
                yield* replaceDuringCall('rev2');
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
            'withholds a revision that throws at import, and falls back to none',
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
                yield* replaceDuringCall('rev3', true);
                yield* until(
                  roots.storage,
                  waitingAfter(runId, 1, roots.storage),
                );
                const [answer] = answersOf(roots.storage, runId);
                // The other tools are offered as before; revision 1 is not.
                expect(answer).toContain('native_echo is not offered');
                expect(answer).toContain('plugin_manager');
                expect(answer).toContain('read_file');
                expect(toolOutputs(roots.storage, runId)).toStrictEqual([
                  'installed',
                  'enabled',
                  'echo rev1',
                ]);
                // The step says why, and revision 1's layer is released.
                expect(
                  storedRows(roots.storage).some(
                    (row) =>
                      row.run === runId &&
                      row.data.includes('importing it threw: rev3 is broken'),
                  ),
                ).toBe(true);
                expect(eventsIn(files.events)).toStrictEqual([
                  'acquire rev1',
                  'call rev1',
                  'done rev1',
                  'release rev1',
                ]);
              }),
          );
        },
      );
    });
  },
);
