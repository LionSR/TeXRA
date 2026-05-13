// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { Plan } from '@shared/schemas';

type RecordedEvent = {
  event: keyof ProgressEventPayloads;
  payload: ProgressEventPayloads[keyof ProgressEventPayloads];
};

function createRecordingHost(): {
  events: RecordedEvent[];
  host: AgentRuntimeHost;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    host: {
      emit: (event, payload) => events.push({ event, payload }),
    },
  };
}

describe('promise coordinators', () => {
  it('captures the run-context runtime host for approval show and resolve events', async () => {
    const coordinator = new PlanApprovalCoordinator();
    const { events, host } = createRecordingHost();
    const plan: Plan = {
      summary: 'Refactor runtime event plumbing',
      steps: [
        {
          title: 'Capture host',
          description: 'Use the current runtime host for approval events',
          status: 'pending',
          files: [],
        },
      ],
    };

    const resultPromise = withRunContext(
      createRunContext({ runtimeHost: host }),
      () =>
        coordinator.waitForApproval('stream:runtime', {
          approvalId: 'approval:runtime',
          plan,
        }),
    );

    coordinator.resolveRequest('approval:runtime', { action: 'approve' });

    assert.deepEqual(await resultPromise, { action: 'approve' });
    assert.deepEqual(events, [
      { event: 'requestEnsureProgressView', payload: {} },
      { event: 'setActiveStream', payload: { streamId: 'stream:runtime' } },
      {
        event: 'showPlanApproval',
        payload: {
          approvalId: 'approval:runtime',
          streamId: 'stream:runtime',
          plan,
        },
      },
      {
        event: 'resolvePlanApproval',
        payload: { approvalId: 'approval:runtime' },
      },
    ]);
  });

  it('dismisses the previous run-context host when a request is replaced', async () => {
    const coordinator = new PlanApprovalCoordinator();
    const first = createRecordingHost();
    const second = createRecordingHost();
    const plan: Plan = {
      summary: 'Replace pending approval',
      steps: [],
    };

    const firstResult = withRunContext(
      createRunContext({ runtimeHost: first.host }),
      () =>
        coordinator.waitForApproval('stream:first', {
          approvalId: 'approval:replace',
          plan,
        }),
    );
    const secondResult = withRunContext(
      createRunContext({ runtimeHost: second.host }),
      () =>
        coordinator.waitForApproval('stream:second', {
          approvalId: 'approval:replace',
          plan,
        }),
    );

    assert.deepEqual(await firstResult, { action: 'reject' });
    assert.equal(
      first.events.at(-1)?.event,
      'resolvePlanApproval',
      'the first host should receive the dismissal event',
    );

    coordinator.resolveRequest('approval:replace', { action: 'approve' });

    assert.deepEqual(await secondResult, { action: 'approve' });
    assert.equal(second.events.at(-1)?.event, 'resolvePlanApproval');
  });
});
