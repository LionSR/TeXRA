// Standard library imports
import { strict as assert } from 'assert';

// Local imports - controllers
import {
  ProgressWorkflowFileActionsController,
  type ProgressWorkflowFileActionsControllerDeps,
} from '@controllers/progressView/ProgressWorkflowFileActionsController';

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): ProgressWorkflowFileActionsControllerDeps {
  const infos: string[] = [];
  const host: ProgressWorkflowFileActionsControllerDeps['host'] & {
    infos: string[];
  } = {
    infos,
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
    showError: async () => {},
    ...overrides,
  };

  return {
    state: {
      getActiveStream: () => '',
      getExecutionId: () => undefined,
      getOutputFiles: () => new Map(),
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

    assert.deepEqual(
      (
        deps.host as ProgressWorkflowFileActionsControllerDeps['host'] & {
          infos: string[];
        }
      ).infos,
      ['Label "missing-label" not found.'],
    );
  });
});
