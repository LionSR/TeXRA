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
  const errors: string[] = [];
  const logs: { message: string; error: unknown }[] = [];
  const host: ProgressWorkflowFileActionsControllerDeps['host'] & {
    infos: string[];
    errors: string[];
    logs: { message: string; error: unknown }[];
  } = {
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

    const host =
      deps.host as ProgressWorkflowFileActionsControllerDeps['host'] & {
        errors: string[];
        logs: { message: string; error: unknown }[];
      };
    assert.deepEqual(host.errors, [
      'Failed to open task storage folder: cannot reveal folder',
    ]);
    assert.deepEqual(host.logs, [
      { message: 'Failed to open task storage folder', error: failure },
    ]);
  });
});
