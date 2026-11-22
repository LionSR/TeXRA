/**
 * A launch's activation over a real store, on the validation model: a run
 * is born with its opening batch or not at all, and a run that fails after
 * it opened still records the description generated for it.
 *
 * Failure modes:
 * - a launch whose opening is refused leaves a partial run (a `run.start`
 *   with no activation) for the listing to show;
 * - R6 of the harness 1.0 release acceptance: a tool the run declares that
 *   asks for approval runs unasked, or is not offered, whether the launch
 *   grants its work no bypass, grants it every bypass, or runs where nobody
 *   can answer;
 * - a run that fails while its description is still being generated ends
 *   without it, or records it after its `run.end`.
 */

import { layer } from '@effect/vitest';
import { Context, Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { GOLDEN_AGENTS } from '@cli/runtime/models/validationAgents';
import { AgentConfigSchema, generateRunId } from '@texra-ai/harness/schemas';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { startChildRun } from '@agent/runtime/delegation/childLaunch';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  ASSISTANT,
  waitingAfter,
  persistentTestSession,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import {
  FakeHost,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';

/** What a run of a launch was offered and asked, and how its calls ended,
 *  read from its rows. */
const permissionsOf = (storage: string, runId: string) => {
  const rows = storedRows(storage).filter((row) => row.run === runId);
  const payloads = (type: string) =>
    rows
      .filter((row) => row.type === type)
      // cast: every stored row's data is the JSON object its writer encoded.
      .map((row) => JSON.parse(row.data) as Record<string, unknown>);
  return {
    offered: payloads('tools.offered').map((row) =>
      // cast: a `tools.offered` row's payload is its ToolsOfferedPayload.
      (row.payload as { tools: readonly { name: string }[] }).tools
        .map((tool) => tool.name)
        .toSorted(),
    ),
    asked: payloads('request.opened').map(
      // cast: a `request.opened` row's payload is the request it opened.
      (row) => (row.payload as { kind: string }).kind,
    ),
    ran: payloads('tool.result').map(
      // cast: a `tool.result` row's payload is its ToolResultPayload.
      (row) => (row.payload as { disposition: string }).disposition,
    ),
  };
};

/** `golden_effect`: one command, which `bash` asks about unless a bypass
 *  covers it. */
const ONE_COMMAND = GOLDEN_AGENTS.golden_effect;

const config = (instruction: string) =>
  Schema.decodeUnknownSync(AgentConfigSchema)({
    ...ASSISTANT,
    model: 'openai/gpt-5.6-sol',
    instruction,
  });

describe(
  'native agent launch activation',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(texraHosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-activation-', TEXRA_APP), {
        buildPerTest: true,
      })((it) => {
        // A root's refused opening is the ownership suite's
        // (`RunAgentOwnership.vitest.ts`); a child's ends failed, for its parent.
        it.effect(
          'a child launch whose opening is refused leaves no run and ends failed for its parent',
          () =>
            Effect.gen(function* () {
              const { roots } = yield* FakeHost;
              const session = yield* persistentTestSession();
              const parentId = generateRunId();
              yield* rootRun({
                config: config('Parent.'),
                runId: parentId,
                interactive: true,
              }).pipe(Effect.provide(session), Effect.forkChild);
              yield* untilStored(
                roots.storage,
                waitingAfter(parentId, 1, roots.storage),
              );
              const faults = yield* sessionStoreFaults(roots.storage);
              yield* faults.failNext('appendAll', 'run.start');
              const runId = generateRunId();

              // The opening fails on the run's fiber: the launch's failure,
              // which the parent's call reads, and no run behind it.
              const refused = yield* prepareAgentDefinition({
                config: config('Refused.'),
              }).pipe(
                Effect.flatMap((definition) =>
                  startChildRun(runId, definition, {
                    identity: { kind: 'agent', agent: 'assistant' },
                    parent: { id: parentId, call: null },
                  }),
                ),
                Effect.provide(session),
                Effect.flip,
              );
              expect(refused.message).toContain('injected appendAll');
              expect(
                storedRows(roots.storage).filter((row) => row.run === runId),
              ).toEqual([]);
            }),
        );

        it.effect(
          'R6: a declared tool that asks is asked about, runs under a granted bypass, and is withheld where nobody answers',
          () =>
            Effect.gen(function* () {
              const { roots } = yield* FakeHost;
              /** Launch the run on `session` with the launch's `approval`, and
               *  read what it was offered and asked once `ready` holds. */
              const launch = (
                session: Context.Context<SessionServices>,
                approval: 'autoApprove' | undefined,
                ready: (
                  permissions: ReturnType<typeof permissionsOf>,
                ) => boolean,
              ) =>
                Effect.gen(function* () {
                  const runId = generateRunId();
                  yield* rootRun({
                    config: Schema.decodeUnknownSync(AgentConfigSchema)({
                      ...ONE_COMMAND,
                      model: 'openai/gpt-5.6-sol',
                      instruction: 'Run the command.',
                    }),
                    runId,
                    ...(approval && { approval }),
                  }).pipe(Effect.provide(session));
                  yield* untilStored(roots.storage, () =>
                    ready(permissionsOf(roots.storage, runId)),
                  );
                  return permissionsOf(roots.storage, runId);
                });

              // A host that answers: with no bypass `bash` asks; a launch that
              // starts its work approved grants it the bypass, and it runs.
              const answered = yield* persistentTestSession(roots);
              const asks = yield* launch(
                answered,
                undefined,
                (p) => p.asked.length > 0,
              );
              const granted = yield* launch(
                answered,
                'autoApprove',
                (p) => p.ran.length > 0,
              );
              expect(asks).toMatchObject({ asked: ['bash'], ran: [] });
              expect(asks.offered[0]).toContain('bash');
              expect(granted).toMatchObject({ asked: [], ran: ['executed'] });
              yield* Sessions.use((sessions) => sessions.close(roots));

              // Nobody can answer: it is not offered `bash`.
              const unanswered = yield* Effect.flatMap(
                TestSession.open(roots, { persistent: true }),
                sessionHandleOf,
              );
              const withheld = yield* launch(
                unanswered,
                undefined,
                (p) => p.offered.length > 0,
              );
              expect(withheld.offered[0]).not.toContain('bash');
            }),
        );
      });
    });
  },
);
