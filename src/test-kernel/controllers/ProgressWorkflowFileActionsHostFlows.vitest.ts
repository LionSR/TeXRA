// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - controllers
import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsControllerDeps,
} from '@controllers/progressView/ProgressWorkflowFileActionsController';

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
      getActiveStream: () => '',
      getExecutionId: () => undefined,
      getOutputFiles: () => new Map(),
      getAgentModel: () => undefined,
    },
    host,
    sendFollowUp: async () => {},
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it('shows one fallback message when a host cannot open a label', async () => {
    const deps = createDeps({
      openLabel: async () => false,
    });
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.openLabel('missing-label');

    assert.deepEqual(deps.host.infos, ['Label "missing-label" not found.']);
  });

  it('reports task storage open failures', async () => {
    const failure = new Error('cannot reveal folder');
    const deps = createDeps({
      openDirectory: async () => {
        throw failure;
      },
    });
    deps.state.getExecutionId = () => 'run-1';
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.openTaskStorage('toolUse');

    assert.deepEqual(deps.host.errors, [
      'Failed to open task storage folder: cannot reveal folder',
    ]);
    assert.deepEqual(deps.host.logs, [
      { message: 'Failed to open task storage folder', error: failure },
    ]);
  });

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
    deps.state.getActiveStream = () => 'workflow';
    deps.sendFollowUp = async (_stream, text) => {
      followUps.push(text);
    };
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.compareOriginal(
      '/workspace/edited.tex',
      '/workspace/base.tex',
    );
    await controller.acceptFile('/workspace/edited.tex', '/workspace/base.tex');

    assert.deepEqual(followUps, []);

    await controller.acceptFile('/workspace/edited.tex', '/workspace/base.tex');

    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? '', /edited\.tex/);
  });
});
