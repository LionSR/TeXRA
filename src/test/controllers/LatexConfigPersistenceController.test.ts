// Standard library imports
import { strict as assert } from 'assert';

// Local imports - state keys
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { WorkspaceStateKey } from '@common/state/stateKeys';

// Local imports - controllers

describe('LatexConfigPersistenceController', () => {
  it('builds webview config values from defined workspace entries', () => {
    const controller = new LatexConfigPersistenceController();
    const storedValues: Partial<Record<WorkspaceStateKey, unknown>> = {
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: false,
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: undefined,
      [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: 'fine',
      [WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY]: false,
      [WorkspaceStateKey.LATEX_FORMATTER]: 'tex-fmt',
    };

    assert.deepEqual(
      controller.buildConfigValues((key) => storedValues[key]),
      {
        workflowAutoCompile: false,
        latexdiffMathMarkup: 'fine',
        latexdiffChangesOnly: false,
        latexFormatter: 'tex-fmt',
      },
    );
  });

  it('drops invalid stored values from the webview config projection', () => {
    const controller = new LatexConfigPersistenceController();
    const storedValues: Partial<Record<WorkspaceStateKey, unknown>> = {
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: false,
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 1000,
      [WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS]: 25000,
      [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: 'invalid',
    };

    assert.deepEqual(
      controller.buildConfigValues((key) => storedValues[key]),
      {
        workflowAutoCompile: false,
        latexdiffTimeoutMs: 25000,
      },
    );
  });

  it('plans validated field updates using workspace storage keys', () => {
    const controller = new LatexConfigPersistenceController();

    assert.deepEqual(
      controller.planUpdate({
        field: 'latexdiffTimeoutMs',
        value: 25000,
      }),
      {
        ok: true,
        update: {
          key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
          value: 25000,
        },
      },
    );
  });

  it('normalizes null writes to undefined so callers clear the key', () => {
    const controller = new LatexConfigPersistenceController();

    assert.deepEqual(
      controller.planUpdate({
        field: 'latexFormatter',
        value: null,
      }),
      {
        ok: true,
        update: {
          key: WorkspaceStateKey.LATEX_FORMATTER,
          value: undefined,
        },
      },
    );
  });

  it('rejects values that do not match the selected field schema', () => {
    const controller = new LatexConfigPersistenceController();
    const plan = controller.planUpdate({
      field: 'workflowAutoCompileTimeoutMs',
      value: 1000,
    });

    assert.equal(plan.ok, false);
  });
});
