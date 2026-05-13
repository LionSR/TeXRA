// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  noopAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
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
  afterEach(() => {
    setDefaultAgentRuntimeHost(noopAgentRuntimeHost);
  });

  it('uses the configured runtime host for approval show and resolve events', async () => {
    const { events, host } = createRecordingHost();
    const defaultHost = createRecordingHost();
    const ambientHost = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
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

    setDefaultAgentRuntimeHost(defaultHost.host);
    const resultPromise = withRunContext(
      createRunContext({ runtimeHost: ambientHost.host }),
      () =>
        coordinator.waitForApproval('stream:runtime', {
          approvalId: 'approval:runtime',
          plan,
        }),
    );

    coordinator.resolveRequest('approval:runtime', { action: 'approve' });

    assert.deepEqual(await resultPromise, { action: 'approve' });
    assert.deepEqual(defaultHost.events, []);
    assert.deepEqual(ambientHost.events, []);
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

  it('keeps unconfigured singleton coordinators on the default host boundary', async () => {
    const coordinator = new PlanApprovalCoordinator();
    const defaultHost = createRecordingHost();
    const ambientHost = createRecordingHost();
    const plan: Plan = {
      summary: 'Use the host boundary',
      steps: [],
    };

    setDefaultAgentRuntimeHost(defaultHost.host);
    const resultPromise = withRunContext(
      createRunContext({ runtimeHost: ambientHost.host }),
      () =>
        coordinator.waitForApproval('stream:default', {
          approvalId: 'approval:default',
          plan,
        }),
    );

    coordinator.resolveRequest('approval:default', { action: 'approve' });

    assert.deepEqual(await resultPromise, { action: 'approve' });
    assert.deepEqual(ambientHost.events, []);
    assert.deepEqual(
      defaultHost.events.map((entry) => entry.event),
      [
        'requestEnsureProgressView',
        'setActiveStream',
        'showPlanApproval',
        'resolvePlanApproval',
      ],
    );
  });

  it('dismisses a replaced request through the coordinator host', async () => {
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const plan: Plan = {
      summary: 'Replace pending approval',
      steps: [],
    };

    const firstResult = coordinator.waitForApproval('stream:first', {
      approvalId: 'approval:replace',
      plan,
    });
    const secondResult = coordinator.waitForApproval('stream:second', {
      approvalId: 'approval:replace',
      plan,
    });

    assert.deepEqual(await firstResult, { action: 'reject' });
    assert.equal(
      events.at(-1)?.event,
      'showPlanApproval',
      'the replacement request should be the active prompt',
    );

    coordinator.resolveRequest('approval:replace', { action: 'approve' });

    assert.deepEqual(await secondResult, { action: 'approve' });
    assert.deepEqual(
      events
        .filter((entry) => entry.event === 'resolvePlanApproval')
        .map((entry) => entry.payload),
      [{ approvalId: 'approval:replace' }, { approvalId: 'approval:replace' }],
    );
  });
});
