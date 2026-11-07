// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Context } from 'effect';
import { expect } from 'vitest';

// Local imports
import { generateRunId } from '@texra-ai/harness/schemas';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import { SessionLog } from '@shared/session/runHistory';
import { createFakeHost } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';
import {
  autoDecideRequests,
  createRecordingHost,
} from '@test/agent/progressTestUtils';
import { UpdateConfigTool } from '@texra/tools/setup/ConfigTools';

layer(SessionGraph.hosted)('ConfigTools — update_config allowlist', (it) => {
  it.effect('rejects a non-allowlisted key without writing', () =>
    Effect.gen(function* () {
      // TeXRA's catalog: the allowlisted keys are its rows.
      const { roots } = createFakeHost({ app: TEXRA_APP });

      const update = (key: string, value: unknown) =>
        UpdateConfigTool.call({ key, value, target: 'user' }).pipe(
          Effect.provide(nativeToolTestLayer({ roots })),
        );

      const key = 'texra.model.useGoogleInteractionsServerState';
      const result = yield* update(key, true);

      assert.equal(result.status, 'error');
      // Rejected by the allowlist itself: the key fails the input's key
      // literals, not some other step of the call.
      assert.match(
        result.error ?? '',
        /^Invalid input:\nExpected "texra\.bib\.defaultPath" \| [^\n]*\n {2}at \["key"\]$/,
      );
      assert.deepEqual(
        roots.config.inspect(key.slice('texra.'.length)),
        { globalValue: undefined, workspaceValue: undefined },
        'must not write rejected settings',
      );

      // Control: an allowlisted key on the same layer is written.
      const allowed = yield* update('texra.bib.zoteroPort', 23200);
      assert.equal(allowed.status, 'executed');
      assert.equal(roots.config.get('bib.zoteroPort'), 23200);
    }),
  );
});

// Live clock: a real request is opened and answered on the session's log.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'ConfigTools — update_config approval',
  (it) => {
    // `requiresApproval: true` means the run loop asks before the body runs.
    // Failure modes: the body writes with no request at all (the tool only
    // declared approval), the body writes although the request was rejected,
    // or the call is asked about twice.
    it.effect('asks before writing, and a rejected call writes nothing', () =>
      Effect.gen(function* () {
        const project = createFakeHost({
          config: { 'bib.zoteroPort': 23119 },
        });
        const session = yield* isolatedTestSession(
          createRecordingHost().interactions,
        );
        const runId = generateRunId();
        yield* publishTestRunStart(session, runId);
        yield* Context.get(session, SessionLog).settled;
        const requests = yield* autoDecideRequests(session, () => ({
          action: 'reject',
        }));

        const result = yield* guardedToolCall(UpdateConfigTool, {
          key: 'texra.bib.zoteroPort',
          value: 23200,
          target: 'user',
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              roots: project.roots,
              run: { session, runId, toolPolicy: {} },
            }),
          ),
        );

        expect(
          requests.opened.map(({ payload }) =>
            payload.kind === 'bash' ? payload.data.command : payload.kind,
          ),
        ).toEqual([
          'update_config {"key":"texra.bib.zoteroPort","value":23200,"target":"user"}',
        ]);
        expect(result.status).toBe('error');
        expect(project.roots.config.get('bib.zoteroPort')).toBe(23119);
      }),
    );
  },
);
