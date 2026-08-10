// Third-party imports
import { describe, expect, it, vi } from 'vitest';

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
      getRunMetadata: () => ({}),
      getOutputFiles: () => ({}),
    },
    host,
    sendFollowUp: async () => {},
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it('compares previous output without also running latexdiff', async () => {
    const compared: Array<[string, string]> = [];
    const latexdiffs: Array<[string, string]> = [];
    const deps = createDeps({
      compareFiles: async (baseFile, editedFile) => {
        compared.push([baseFile, editedFile]);
      },
      latexdiffFile: async (baseFile, editedFile) => {
        latexdiffs.push([baseFile, editedFile]);
      },
    });
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.comparePrevious(
      '/workspace/output-r1.tex',
      '/workspace/original.tex',
      '/workspace/output-r0.tex',
    );

    expect(compared).toEqual([
      ['/workspace/output-r0.tex', '/workspace/output-r1.tex'],
    ]);
    expect(latexdiffs).toEqual([]);
  });

  it('shows one fallback message when a host cannot open a label', async () => {
    const deps = createDeps({
      openLabel: async () => false,
    });
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.openLabel('missing-label');

    expect(deps.host.infos).toEqual(['Label "missing-label" not found.']);
  });

  it('reports task storage open failures', async () => {
    const failure = new Error('cannot reveal folder');
    const deps = createDeps({
      openDirectory: async () => {
        throw failure;
      },
    });
    const getRunMetadata = vi.fn(() => ({ executionId: 'run-1' }));
    deps.state.getRunMetadata = getRunMetadata;
    const controller = new ProgressWorkflowFileActionsController(deps);

    await controller.openTaskStorage('toolUse');

    expect(getRunMetadata).toHaveBeenCalledOnce();
    expect(getRunMetadata).toHaveBeenCalledWith('toolUse');
    expect(deps.host.errors).toEqual([
      'Failed to open task storage folder: cannot reveal folder',
    ]);
    expect(deps.host.logs).toEqual([
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

    expect(followUps).toEqual([]);

    await controller.acceptFile('/workspace/edited.tex', '/workspace/base.tex');

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/edited\.tex/);
  });
});
