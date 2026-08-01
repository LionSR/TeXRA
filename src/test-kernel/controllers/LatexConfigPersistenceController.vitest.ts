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
});
