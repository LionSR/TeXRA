/**
 * A launch's activation over a real store, on the validation model: a run
 * is born with its opening batch or not at all, and a run that fails after
 * it opened still records the description generated for it.
 *
 * Failure modes:
 * - a launch whose opening is refused leaves a partial run (a `run.start`
 *   with no activation) for the listing to show;
 * - R6 of the harness 1.0 release acceptance: an agent file and the
 *   equivalent inline persona are offered different tools, or a tool that
 *   asks for approval under one runs unasked under the other, whether the
 *   launch grants its work no bypass, grants it every bypass, or runs where
 *   nobody can answer;
 * - a run that fails while its description is still being generated ends
 *   without it, or records it after its `run.end`.
 */

import { layer } from '@effect/vitest';
import { Context, Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { AgentConfigSchema, generateRunId } from '@texra-ai/harness/schemas';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import {
  parkedAfter,
  persistentTestSession,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { sessionHandleOf, TestSession } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
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

/** `golden_effect`'s agent file and the inline persona it is equivalent to:
 *  one command, which `bash` asks about unless a bypass covers it. */
const FILE_AGENT = { agent: 'golden_effect' } as const;
const INLINE_AGENT = {
  agent: 'golden_effect',
  agentSource: 'inline',
  persona: {
    name: 'golden_effect',
    description:
      "The golden store's run killed after its command's effect and before its result committed.",
    prompt: 'GOLDEN-APPROVAL: run one command.',
    tools: ['bash'],
  },
} as const;

const config = (instruction: string) =>
  Schema.decodeUnknownSync(AgentConfigSchema)({
    agent: 'assistant',
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
              const roots = testWorkspaceRoots();
              const session = yield* persistentTestSession();
              const parentRunId = generateRunId();
              yield* rootRun({
                config: config('Parent.'),
                runId: parentRunId,
                interactive: true,
              }).pipe(Effect.provide(session), Effect.forkChild);
              yield* untilStored(
                roots.storage,
                parkedAfter(parentRunId, 1, roots.storage),
              );
              const faults = yield* sessionStoreFaults(roots.storage);
              yield* faults.failNext('appendAll', 'run.start');
              const runId = generateRunId();

              // The opening fails in the caller's fiber: the launch's
              // failure, which the parent's call reads, and no run behind it.
              const refused = yield* prepareAgentDefinition({
                config: config('Refused.'),
              }).pipe(
                Effect.flatMap((definition) =>
                  executeAgent(definition, runId, {
                    registration: {
                      identity: { kind: 'agent', agent: 'assistant' },
                      parentRunId,
                    },
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
          'R6: an agent file and its equivalent inline persona are offered the same tools and asked the same approvals',
          () =>
            Effect.gen(function* () {
              const roots = testWorkspaceRoots();
              /** Launch `agent` on `session` with the launch's `approval`, and
               *  read what it was offered and asked once `ready` holds. */
              const launch = (
                session: Context.Context<SessionServices>,
                agent: typeof FILE_AGENT | typeof INLINE_AGENT,
                approval: { readonly delegated?: boolean } | undefined,
                ready: (
                  permissions: ReturnType<typeof permissionsOf>,
                ) => boolean,
              ) =>
                Effect.gen(function* () {
                  const runId = generateRunId();
                  yield* rootRun({
                    config: Schema.decodeUnknownSync(AgentConfigSchema)({
                      ...agent,
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
              // starts its work approved grants it the bypass, and it runs. The
              // file and the persona are offered the same tools (the plugins
              // inject theirs into both) and asked the same.
              const answered = yield* persistentTestSession(roots);
              const [fileAsks, inlineAsks, fileGranted, inlineGranted] = [
                yield* launch(
                  answered,
                  FILE_AGENT,
                  undefined,
                  (p) => p.asked.length > 0,
                ),
                yield* launch(
                  answered,
                  INLINE_AGENT,
                  undefined,
                  (p) => p.asked.length > 0,
                ),
                yield* launch(
                  answered,
                  FILE_AGENT,
                  { delegated: true },
                  (p) => p.ran.length > 0,
                ),
                yield* launch(
                  answered,
                  INLINE_AGENT,
                  { delegated: true },
                  (p) => p.ran.length > 0,
                ),
              ];
              expect(fileAsks).toMatchObject({ asked: ['bash'], ran: [] });
              expect(fileAsks.offered[0]).toContain('bash');
              expect(inlineAsks).toEqual(fileAsks);
              expect(fileGranted).toMatchObject({
                asked: [],
                ran: ['executed'],
              });
              expect(inlineGranted).toEqual(fileGranted);
              yield* Sessions.use((sessions) => sessions.close(roots));

              // Nobody can answer: neither is offered `bash`.
              const unanswered = yield* Effect.flatMap(
                TestSession.open(roots, { persistent: true }),
                sessionHandleOf,
              );
              const [fileWithheld, inlineWithheld] = [
                yield* launch(
                  unanswered,
                  FILE_AGENT,
                  undefined,
                  (p) => p.offered.length > 0,
                ),
                yield* launch(
                  unanswered,
                  INLINE_AGENT,
                  undefined,
                  (p) => p.offered.length > 0,
                ),
              ];
              expect(fileWithheld.offered[0]).not.toContain('bash');
              expect(inlineWithheld).toEqual(fileWithheld);
            }),
        );
      });
    });
  },
);
