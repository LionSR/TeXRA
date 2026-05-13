import { describe, expect, it } from 'vitest';

import { emitAcceptedWorkspaceFile } from '@controllers/progressView/workflowFileActionsEvents';
import { createExternalLocation, createWorkspaceLocation } from '@utils/files';

import { createRecordingHost } from '../agent/progressTestUtils';

describe('workflow file action progress events', () => {
  it('emits accepted workspace files through the runtime host', () => {
    const { events, host } = createRecordingHost();

    emitAcceptedWorkspaceFile(
      createWorkspaceLocation('/workspace/paper.tex', 'paper.tex'),
      host,
    );

    expect(events).toEqual([
      {
        event: 'workspaceFilesWritten',
        payload: { absolutePaths: ['/workspace/paper.tex'] },
      },
    ]);
  });

  it('does not emit progress for external files', () => {
    const { events, host } = createRecordingHost();

    emitAcceptedWorkspaceFile(createExternalLocation('/tmp/paper.tex'), host);

    expect(events).toEqual([]);
  });
});
