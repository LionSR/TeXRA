// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - controllers
import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsControllerDeps,
} from '@controllers/progressView/ProgressWorkflowFileActionsController';

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): ProgressWorkflowFileActionsControllerDeps {
  return {
    state: {
      getActiveStream: () => '',
      getExecutionId: () => undefined,
      getOutputFiles: () => new Map(),
    },
    host: {
      compareFiles: async () => {},
      acceptEditedFile: async () => {},
      mergeFile: async () => {},
      latexdiffFile: async () => {},
      openDirectory: async () => {},
      openLabel: async () => true,
      readFile: async () => '',
      showInfo: async () => {},
      showError: async () => {},
      ...overrides,
    },
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
});
