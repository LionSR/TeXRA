// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { beforeEach, describe, it } from 'vitest';

// Local imports - controllers and state keys
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

describe('LatexConfigPersistenceController', () => {
  let controller: LatexConfigPersistenceController;

  beforeEach(() => {
    controller = new LatexConfigPersistenceController();
  });

  const configProjectionCases: Array<{
    name: string;
    storedValues: Partial<Record<WorkspaceStateKey, unknown>>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: 'builds webview config values from defined workspace entries',
      storedValues: {
        [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: false,
        [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: undefined,
        [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: 'fine',
        [WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY]: false,
        [WorkspaceStateKey.LATEX_FORMATTER]: 'tex-fmt',
      },
      expected: {
        workflowAutoCompile: false,
        latexdiffMathMarkup: 'fine',
        latexdiffChangesOnly: false,
        latexFormatter: 'tex-fmt',
      },
    },
    {
      name: 'drops invalid stored values from the webview config projection',
      storedValues: {
        [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: false,
        [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 1000,
        [WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS]: 25000,
        [WorkspaceStateKey.LATEXDIFF_MATH_MARKUP]: 'invalid',
      },
      expected: {
        workflowAutoCompile: false,
        latexdiffTimeoutMs: 25000,
      },
    },
  ];

  it.each(configProjectionCases)('$name', ({ storedValues, expected }) => {
    assert.deepEqual(
      controller.buildConfigValues((key) => storedValues[key]),
      expected,
    );
  });

  const planUpdateCases: Array<{
    name: string;
    input: Parameters<LatexConfigPersistenceController['planUpdate']>[0];
    expected: unknown;
  }> = [
    {
      name: 'plans validated field updates using workspace storage keys',
      input: { field: 'latexdiffTimeoutMs', value: 25000 },
      expected: {
        ok: true,
        update: { key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS, value: 25000 },
      },
    },
    {
      name: 'normalizes null writes to undefined so callers clear the key',
      input: { field: 'latexFormatter', value: null },
      expected: {
        ok: true,
        update: { key: WorkspaceStateKey.LATEX_FORMATTER, value: undefined },
      },
    },
  ];

  it.each(planUpdateCases)('$name', ({ input, expected }) => {
    assert.deepEqual(controller.planUpdate(input), expected);
  });

  it('rejects values that do not match the selected field schema', () => {
    const plan = controller.planUpdate({
      field: 'workflowAutoCompileTimeoutMs',
      value: 1000,
    });

    assert.equal(plan.ok, false);
  });
});
