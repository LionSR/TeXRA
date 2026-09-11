import { describe, expect, it } from 'vitest';

import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsControllerDeps,
} from '@controllers/progressView/ProgressWorkflowFileActionsController';
import type { RunId } from '@shared/schemas';

const RUN = 'ab12cd' as RunId;

type LogEntry = { message: string; error: unknown };

type RecordingHost = ProgressWorkflowFileActionsControllerDeps['host'] & {
  infos: string[];
  errors: string[];
  logs: LogEntry[];
};

type RecordingDeps = ProgressWorkflowFileActionsControllerDeps & {
  host: RecordingHost;
};

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): RecordingDeps {
  const infos: string[] = [];
  const errors: string[] = [];
  const logs: LogEntry[] = [];
  const host: RecordingHost = {
    infos,
    errors,
    logs,
    compareFiles: async () => {},
    acceptEditedFile: async () => {},
    mergeFile: async () => {},
    latexdiffFile: async () => {},
    openDirectory: async () => {},
    openLabel: async () => true,
    readFile: async () => '',
    showInfo: async (message) => {
      infos.push(message);
    },
    showError: async (message) => {
      errors.push(message);
    },
    logError: (message, error) => {
      logs.push({ message, error });
    },
    ...overrides,
  };

  return {
    state: {
      getOutputFiles: () => ({}),
    },
    host,
    sendFollowUp: async () => {},
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it('keeps the accept follow-up backup when the host cancels acceptance', async () => {
    const followUps: string[] = [];
    const acceptResults = [false, true];
    const readResults = [
      'original model output',
      'user edited output',
      'user edited output',
    ];
    const deps = createDeps({
      acceptEditedFile: async () => acceptResults.shift(),
      readFile: async () => readResults.shift() ?? '',
    });
    deps.sendFollowUp = async (_stream, text) => {
      followUps.push(text);
    };
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.compareOriginal(
      '/workspace/edited.tex',
      '/workspace/base.tex',
      RUN,
    );
    await controller.acceptFile(
      '/workspace/edited.tex',
      '/workspace/base.tex',
      RUN,
    );

    expect(followUps).toEqual([]);

    await controller.acceptFile(
      '/workspace/edited.tex',
      '/workspace/base.tex',
      RUN,
    );

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/edited\.tex/);
  });
});
