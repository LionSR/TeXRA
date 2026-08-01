// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { MediaExtractionNode } from '@agent/implementations/flows/reflection/nodes/MediaExtractionNode';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import type { FileLocation } from '@shared/schemas';

// Local file imports
import { reflectionFlowShared } from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

function buildServices(
  overrides: Partial<ReflectionServices<unknown>> = {},
): ReflectionServices<unknown> {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelCell: testModelCell({
      addMediaToUserMessage: vi.fn(async () => []),
    }) as never,
    ...overrides,
  } as ReflectionServices<unknown>;
}

const MEDIA_FILES: FileLocation[] = [
  {
    kind: 'external',
    absolutePath: '/tmp/img.png',
  },
];

function buildPrepRes(currentRound: number) {
  return {
    currentRound,
    files: [],
    extraMediaFiles: [],
    workspaceState: AgentWorkspaceState.create(),
  };
}

describe('MediaExtractionNode transcript logging (regression #7508)', () => {
  it('logs the initial transcript row when addMediaToUserMessage throws', async () => {
    // A failed round-0 media insertion (corrupt/oversized file, provider
    // validation error, ...) must still leave a record of what the user
    // asked for — otherwise the transcript's opening row silently vanishes
    // for exactly the runs most likely to need debugging.
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    (
      services.modelCell.handler.addMediaToUserMessage as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error('media insertion failed'));
    const node = new MediaExtractionNode().setServices(services);
    const shared = reflectionFlowShared();

    await expect(
      node.post(shared, buildPrepRes(0), MEDIA_FILES),
    ).rejects.toThrow('media insertion failed');

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
  });

  it('still logs exactly once on the success path', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    const node = new MediaExtractionNode().setServices(services);
    const shared = reflectionFlowShared();

    await node.post(shared, buildPrepRes(0), MEDIA_FILES);

    expect(services.logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log on rounds after the first', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    (
      services.modelCell.handler.addMediaToUserMessage as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error('boom'));
    const node = new MediaExtractionNode().setServices(services);
    const shared = reflectionFlowShared({ currentRound: 1 });

    await expect(
      node.post(shared, buildPrepRes(1), MEDIA_FILES),
    ).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});
