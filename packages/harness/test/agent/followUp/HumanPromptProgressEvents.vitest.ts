// Third-party imports
import { Effect, Context, Layer } from 'effect';
import { layer } from '@effect/vitest';
import { expect } from 'vitest';

// Local imports
import { generateRunId, type RunId } from '@texra-ai/harness/schemas';
import { requestToolEditApproval } from '@texra-ai/harness/plugins';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
import {
  attachInteractions,
  Interactions,
} from '@agent/runtime/HostInteractions';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Approvals } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

// Local file imports
import {
  autoDecideRequests,
  commandTool,
  createRecordingHost,
} from '@test/agent/progressTestUtils';

type Session = Context.Context<SessionServices>;

function inToolContext<A, E, R>(
  session: Session,
  interactions: ReturnType<typeof createRecordingHost>['interactions'],
  runId: RunId,
  run: () => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.andThen(
      attachInteractions(Context.get(session, Interactions), interactions),
      run().pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { runId, session, toolPolicy: {} },
          }),
        ),
      ),
    ),
  );
}

/** A run whose existence fact the request rows below hang off. */
const startedRun = (session: Session) =>
  publishTestRunStart(session, generateRunId());

// The file's session over a fresh host's roots, opened as a host whose
// person answers from the view: its runs' requests wait for a decision.
layer(
  TestSession.layer(undefined, { host: {} }).pipe(
    Layer.provideMerge(SessionGraph.layer),
    Layer.provideMerge(FakeHost.layer()),
  ),
  { excludeTestServices: true },
)('human prompt progress events', (it) => {
  it.effect('keeps bash and edit session bypasses independent', () =>
    Effect.flatMap(Effect.flatMap(TestSession, sessionHandleOf), (session) =>
      Effect.gen(function* () {
        const explicit = createRecordingHost();
        const runId = yield* startedRun(session);
        const decided = yield* autoDecideRequests(session, () => ({
          action: 'approve',
        }));
        yield* Context.get(session, Approvals).change(
          runId,
          humanGrant(['toolEdit'], true),
        );

        const approval = yield* inToolContext(
          session,
          explicit.interactions,
          runId,
          () => guardedToolCall(commandTool, { command: 'echo still asks' }),
        );

        expect(approval).toMatchObject({ status: 'executed' });
        expect(decided.opened.at(-1)?.payload).toMatchObject({
          kind: 'bash',
          data: { command: 'echo still asks' },
        });

        // A bash bypass answers without asking; the edit bypass above is not
        // what silenced it.
        yield* Context.get(session, Approvals).change(
          runId,
          humanGrant(['bash'], true),
        );

        const bypassed = yield* inToolContext(
          session,
          explicit.interactions,
          runId,
          () => guardedToolCall(commandTool, { command: 'echo bypassed' }),
        );

        expect(bypassed).toMatchObject({ status: 'executed' });
        expect(decided.opened).toHaveLength(1);

        yield* Context.get(session, Approvals).change(
          runId,
          humanGrant(['toolEdit'], false),
        );

        const editApproval = yield* inToolContext(
          session,
          explicit.interactions,
          runId,
          () =>
            requestToolEditApproval({
              path: 'draft.tex',
              originalContent: 'old',
              proposedContent: 'new',
              sourceTool: 'test',
            }),
        );

        expect(
          decided.opened.filter(
            (request) => request.payload.kind === 'toolEdit',
          ),
        ).toHaveLength(1);
        expect(editApproval).toMatchObject({
          action: 'apply',
          appliedContent: 'new',
        });
      }).pipe(Effect.provide(nativeToolTestLayer())),
    ),
  );
});
