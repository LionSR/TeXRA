import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';
import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';

import { activationRows, registerRun } from '@agent/storage/runLifecycle';
import { runBypasses } from '@shared/approvalBypassKind';
import { AgentConfigSchema, type RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { BUNDLED_AGENTS } from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';

const EXECUTION_ID = 'a00101' as RunId;

const tempDirs = useTempDirs();

describe('AgentLaunchContext', () => {
  // The built-in agents are the bundled personas: a launch resolves its
  // agent, or misses, against the catalog a real host scans.
  setupPlatform(async () => {
    const host = await createTempDirPlatform('texra-launch-', tempDirs);
    return {
      ...host,
      platform: {
        ...host.platform,
        agentDirectories: {
          ...host.platform.agentDirectories,
          builtIn: () => Effect.succeed(BUNDLED_AGENTS),
        },
      },
    };
  });

  it.effect(
    "restores a resumed run's human grants from its durable policy, not its goal's",
    () =>
      Effect.gen(function* () {
        // Failure modes: a resume in a new process forgets an
        // approve-for-session grant; its re-stamp overwrites the durable
        // grant with an empty snapshot; a goal's auto-approval comes back
        // on without a human re-arming it.
        const session = yield* createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        const config = Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: 'chat',
          model: 'openai/gpt-5.5-2026-04-23',
        });
        yield* registerRun(session, EXECUTION_ID, config, {
          identity: { kind: 'agent', agent: 'chat' },
        });
        // A human approves edits for the session; the run's goal then
        // auto-approves its commands.
        yield* session.approvals.change(
          EXECUTION_ID,
          humanGrant(['toolEdit'], true),
        );
        yield* session.approvals.change(EXECUTION_ID, goalGrant(['bash']));
        yield* session.log.settled;

        // A resume's activation, as its run's cell commits it.
        yield* session.runHistory.open(EXECUTION_ID, {
          activation: () => activationRows(session, EXECUTION_ID, config),
        });

        // The human's grant stands; the goal's ends with the activation.
        const view = yield* session.view.read([]);
        expect(runBypasses(view, EXECUTION_ID)).toEqual({
          bash: false,
          toolEdit: true,
          superYolo: false,
        });
        expect(view.policy.get(EXECUTION_ID)).toEqual({
          own: { toolEdit: 'on' },
          goal: [],
        });
      }),
  );
});
