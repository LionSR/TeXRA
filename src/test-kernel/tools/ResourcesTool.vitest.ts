/**
 * A run that reads its own resources (`resources`), over a real store on the
 * validation model (`GOLDEN-RESOURCES`, `validationModel.ts`), with the
 * process on the test clock and its HTTP answered by a stub `fetch`
 * provided beneath it: the run's script reads its resources and returns
 * them, then starts a `self()` child under a spend cap, which reads its own
 * and answers with the cap they name. Before the run, a reply on the
 * ChatGPT plan states its quota in its headers, through the transport the
 * plan's requests take.
 *
 * Failure modes:
 * - the time is the machine's, not the process's clock, or not dated in a
 *   zone;
 * - a coding plan that is on shows no quota, or a failed read fails the call;
 * - the ChatGPT plan's quota from a reply is lost, shown without when it was
 *   observed, or dated as now;
 * - a plan nothing reads says nothing, or invents a quota;
 * - the run's spend differs from what its priced rows hold;
 * - a child held to a cap is not told of it.
 */
import { layer } from '@effect/vitest';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { assert, describe, expect } from 'vitest';

import { PlanQuotas } from '@agent/runtime/modelAccess/planQuotas';
import { rootRun } from '@agent/runtime/rootLaunch';
import { Settings } from '@shared/config/settings';
import { KIMI_CODE_PREFER_SETTING } from '@shared/state/stateSettings';
import { AgentConfigSchema, generateRunId } from '@texra-ai/harness/schemas';
import {
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  type StoredRow,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

import { autoDecideRequests } from '../agent/progressTestUtils';

/** When the ChatGPT reply arrives, and the run starts ten minutes later:
 *  the test clock starts at zero, and moving it runs every timer of the
 *  process that falls in between, so it moves little. */
const OBSERVED = 0;
const NOW = OBSERVED + 10 * 60 * 1000;
/** When the Kimi Code weekly window resets, as its endpoint says. */
const KIMI_RESET = '2026-11-23T00:00:00Z';
/** When the ChatGPT secondary window resets, in epoch seconds. */
const CHATGPT_SECONDARY_RESET = Date.parse('2026-11-25T00:00:00Z') / 1000;

/** The instant a time the tool shows names, when it is written with its
 *  UTC offset and its zone named; undefined for any other form. */
const instant = (shown: string | undefined): number | undefined =>
  shown === undefined || !shown.endsWith(']')
    ? undefined
    : Option.getOrUndefined(
        Option.map(DateTime.makeZonedFromString(shown), DateTime.toEpochMillis),
      );

/** Every HTTP request the process makes: the Kimi Code quota endpoint
 *  answers its weekly window; anything else is refused. */
const stubFetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input.toString();
  return url.endsWith('/usages')
    ? new Response(
        JSON.stringify({
          usage: { limit: 100, remaining: 30, resetTime: KIMI_RESET },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    : new Response('not stubbed', { status: 404 });
}) as typeof globalThis.fetch;

/** A ChatGPT-plan reply stating its two quota windows. */
const chatgptReply = (async () =>
  new Response('{}', {
    headers: {
      'x-codex-primary-used-percent': '40',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': String(CHATGPT_SECONDARY_RESET),
    },
  })) as typeof globalThis.fetch;

const WindowSchema = Schema.Struct({
  name: Schema.String,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
  windowMinutes: Schema.optional(Schema.Number),
});
const ResourcesSchema = Schema.Struct({
  now: Schema.String,
  models: Schema.Array(
    Schema.Struct({ id: Schema.String, billing: Schema.String }),
  ),
  plans: Schema.Array(
    Schema.Struct({
      plan: Schema.String,
      on: Schema.Boolean,
      quota: Schema.Struct({
        source: Schema.String,
        asOf: Schema.optional(Schema.String),
        windows: Schema.optional(Schema.Array(WindowSchema)),
        failed: Schema.optional(Schema.String),
        unknown: Schema.optional(Schema.String),
      }),
    }),
  ),
  spend: Schema.Struct({
    runUsd: Schema.Number,
    treeUsd: Schema.Number,
    caps: Schema.Array(Schema.Unknown),
  }),
});
const ScriptResultSchema = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.Struct({
      result: Schema.Struct({
        value: Schema.Struct({ own: ResourcesSchema, child: Schema.String }),
      }),
    }),
  }),
);
const Cost = Schema.optional(Schema.Struct({ cost: Schema.Number }));
/** A row's priced usage: a response's, or a helper call's billed to the
 *  run (its description). */
const PricedSchema = Schema.fromJsonString(
  Schema.Struct({
    usage: Cost,
    payload: Schema.optional(Schema.Struct({ usage: Cost })),
  }),
);

/** The cost the priced rows `runId` committed before `commit` hold. */
const spentBefore = (
  rows: readonly StoredRow[],
  runId: string,
  commit: number,
): number =>
  rows
    .filter((row) => row.run === runId && row.commit < commit)
    .reduce((sum, row) => {
      const priced = Schema.decodeUnknownSync(PricedSchema)(row.data);
      return (
        sum + (priced.usage?.cost ?? 0) + (priced.payload?.usage?.cost ?? 0)
      );
    }, 0);

/** The process over the fake host, its HTTP answered by `stubFetch`. */
const graph = Layer.provideMerge(
  SessionGraph.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(stubFetch)),
  ),
  FakeHost.layer(),
);

describe(
  'a run that reads its resources',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(graph)((it) => {
      it.layer(validationHost('texra-resources-'), { buildPerTest: true })(
        (it) => {
          it.effect(
            'reads the clock, the plans, its spend and its cap from a script',
            () =>
              Effect.gen(function* () {
                const { roots, secrets } = yield* FakeHost;
                yield* secrets.set('apiKey.kimiCode', 'kimi-test-key');
                yield* Settings.set(roots, KIMI_CODE_PREFER_SETTING, true);
                // A ChatGPT-plan reply arrives through the transport its
                // requests take, ten minutes before the run.
                yield* TestClock.setTime(OBSERVED);
                const quotas = yield* PlanQuotas;
                yield* Effect.promise(() =>
                  quotas.observing(
                    'chatgpt-subscription',
                    chatgptReply,
                  )('https://api.openai.com/v1/responses'),
                );
                yield* TestClock.adjust(NOW - OBSERVED);

                const session = yield* persistentTestSession();
                yield* autoDecideRequests(session, () => ({
                  action: 'approve',
                }));
                const root = generateRunId();
                yield* rootRun({
                  runId: root,
                  interactive: false,
                  config: Schema.decodeUnknownSync(AgentConfigSchema)({
                    label: 'golden_resources',
                    system: 'GOLDEN-RESOURCES: read your resources.',
                    tools: ['script', 'resources'],
                    model: 'openai/gpt-5.6-sol',
                    instruction: 'Read your resources.',
                  }),
                }).pipe(Effect.provide(session));
                yield* TestClock.withLive(
                  untilStored(roots.storage, (rows) =>
                    rows.some(
                      (row) => row.run === root && row.type === 'run.end',
                    ),
                  ),
                );

                const rows = storedRows(roots.storage);
                const scriptResult = rows.find(
                  (row) =>
                    row.run === root &&
                    row.type === 'tool.result' &&
                    row.data.includes('"own"'),
                );
                assert(scriptResult !== undefined, 'the script returned');
                const { own, child } = Schema.decodeUnknownSync(
                  ScriptResultSchema,
                )(scriptResult.data).payload.result.value;

                // The process's clock, in the process's zone.
                expect(instant(own.now)).toBe(NOW);
                expect(own.models.length).toBeGreaterThan(0);

                const plan = (name: string) => {
                  const found = own.plans.find((entry) => entry.plan === name);
                  assert(found !== undefined, `${name} is listed`);
                  return found;
                };
                // Kimi Code is on: its endpoint answered as the run asked.
                const kimi = plan('kimi-code-subscription');
                expect(kimi.on).toBe(true);
                expect(kimi.quota.source).toBe('quota endpoint');
                expect(instant(kimi.quota.asOf)).toBe(NOW);
                expect(
                  kimi.quota.windows?.map((window) => ({
                    ...window,
                    resetsAt: instant(window.resetsAt),
                  })),
                ).toStrictEqual([
                  {
                    name: 'weekly_limit',
                    remainingPercent: 30,
                    resetsAt: Date.parse(KIMI_RESET),
                  },
                ]);
                // ChatGPT: the reply's word, dated when it came.
                const chatgpt = plan('chatgpt-subscription');
                expect(chatgpt.quota.source).toBe('reply headers');
                expect(instant(chatgpt.quota.asOf)).toBe(OBSERVED);
                expect(
                  chatgpt.quota.windows?.map((window) => ({
                    ...window,
                    resetsAt: instant(window.resetsAt),
                  })),
                ).toStrictEqual([
                  {
                    name: 'primary',
                    remainingPercent: 60,
                    resetsAt: OBSERVED + 3600 * 1000,
                    windowMinutes: 300,
                  },
                  {
                    name: 'secondary',
                    remainingPercent: 90,
                    resetsAt: CHATGPT_SECONDARY_RESET * 1000,
                    windowMinutes: 10080,
                  },
                ]);
                // Nothing reads Grok's plan, and it says so.
                expect(plan('xai-subscription').quota).toStrictEqual({
                  source: 'none',
                  unknown:
                    'Nothing this process reads states the quota of this plan.',
                });
                expect(plan('glm-coding-plan-subscription')).toStrictEqual({
                  plan: 'glm-coding-plan-subscription',
                  on: false,
                  quota: {
                    source: 'quota endpoint',
                    unknown: 'Not asked while the plan is off.',
                  },
                });

                // What the run's priced rows held when the call ran, before
                // it started any child.
                const intent = rows.find(
                  (row) =>
                    row.run === root &&
                    row.type === 'tool.intent' &&
                    row.data.includes('"resources"'),
                );
                assert(intent !== undefined, 'the script called resources');
                expect(own.spend.runUsd).toBe(
                  spentBefore(rows, root, intent.commit),
                );
                expect(own.spend.runUsd).toBeGreaterThan(0);
                expect(own.spend.treeUsd).toBe(own.spend.runUsd);
                expect(own.spend.caps).toStrictEqual([]);

                // The child is told of the cap its call holds it to.
                const childId = rows.find(
                  (row) => row.parent === root && row.type === 'run.start',
                )?.run;
                assert(childId !== undefined, 'the script started a child');
                expect(child).toMatch(
                  new RegExp(
                    `^Spend cap: run ${childId} and the runs it started stop at \\$100; spent \\$`,
                  ),
                );
              }),
          );
        },
      );
    });
  },
);
