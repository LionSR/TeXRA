// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports
import { type AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { Plan } from '@shared/schemas';

import {
  createRecordingHost,
  type RecordedProgressEvent,
} from '../progressTestUtils';

describe('promise coordinators', () => {
  it('uses the configured runtime host for approval show and resolve events', async () => {
    const { events, host } = createRecordingHost();
    const ambientHost = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const plan: Plan = {
      objective:
        'Refactor runtime event plumbing.\n' +
        'Use the current runtime host for approval events.',
    };

    const resultPromise = withRunContext(
      createRunContext({ runtimeHost: ambientHost.host }),
      () =>
        coordinator.waitForApproval('stream:runtime', {
          approvalId: 'approval:runtime',
          plan,
        }),
    );

    assert.equal(
      host.interactions?.resolve('approval:runtime', {
        kind: 'plan',
        action: 'approve',
      }),
      true,
    );

    assert.deepEqual(await resultPromise, { action: 'approve' });
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
          goalEnabled: false,
        },
      },
      {
        event: 'resolvePlanApproval',
        payload: { approvalId: 'approval:runtime' },
      },
    ]);
  });

  it('captures the provider-callback host at request time and ignores later rebinding', async () => {
    const requestHost = createRecordingHost();
    const ambientHost = createRecordingHost();
    const replacementHost = createRecordingHost();
    // A provider callback resolves the host lazily; the coordinator captures
    // whatever it returns at waitForApproval() time and reuses that captured
    // host when resolving, so rebinding afterwards must not redirect events.
    let providerHost: AgentRuntimeHost = requestHost.host;
    const coordinator = new PlanApprovalCoordinator(() => providerHost);
    const plan: Plan = { objective: 'Use the host boundary' };

    const resultPromise = withRunContext(
      createRunContext({ runtimeHost: ambientHost.host }),
      () =>
        coordinator.waitForApproval('stream:default', {
          approvalId: 'approval:default',
          plan,
        }),
    );

    providerHost = replacementHost.host;
    assert.equal(
      requestHost.host.interactions?.resolve('approval:default', {
        kind: 'plan',
        action: 'approve',
      }),
      true,
    );

    assert.deepEqual(await resultPromise, { action: 'approve' });
    assert.deepEqual(ambientHost.events, []);
    assert.deepEqual(replacementHost.events, []);
    assert.deepEqual(
      requestHost.events.map((entry) => entry.event),
      [
        'requestEnsureProgressView',
        'setActiveStream',
        'showPlanApproval',
        'resolvePlanApproval',
      ],
    );
  });

  it('uses host interactions before the legacy show/resolve event pair', async () => {
    const events: RecordedProgressEvent[] = [];
    const seenPlans: string[] = [];
    const plan: Plan = { objective: 'Approve through HostInteractions' };
    const host: AgentRuntimeHost = {
      interactions: {
        requestPlanApproval: async (request) => {
          seenPlans.push(request.approvalId);
          return { action: 'approve' };
        },
        handleProgressEvent: () => false,
        pending: () => [],
        resolve: () => false,
        cancelForStream: () => {},
      },
      emit: (event, payload) => events.push({ event, payload }),
    };
    const coordinator = new PlanApprovalCoordinator(host);

    assert.deepEqual(
      await coordinator.waitForApproval('stream:interactions', {
        approvalId: 'approval:interactions',
        plan,
      }),
      { action: 'approve' },
    );

    assert.deepEqual(seenPlans, ['approval:interactions']);
    assert.deepEqual(
      events.map((entry) => entry.event),
      ['requestEnsureProgressView', 'setActiveStream'],
    );
  });

  it('dismisses a replaced request through the coordinator host', async () => {
    const { events, host } = createRecordingHost();
    const coordinator = new PlanApprovalCoordinator(host);
    const plan: Plan = { objective: 'Replace pending approval' };

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

    assert.equal(
      host.interactions?.resolve('approval:replace', {
        kind: 'plan',
        action: 'approve',
      }),
      true,
    );

    assert.deepEqual(await secondResult, { action: 'approve' });
    assert.deepEqual(
      events
        .filter((entry) => entry.event === 'resolvePlanApproval')
        .map((entry) => entry.payload),
      [{ approvalId: 'approval:replace' }, { approvalId: 'approval:replace' }],
    );
  });
});
