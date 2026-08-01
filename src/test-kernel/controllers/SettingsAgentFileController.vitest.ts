// Standard library imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - controllers
import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';

const controller = new SettingsAgentFileController();
const CUSTOM_DIR = path.join(path.sep, 'repo', 'custom-agents');

describe('SettingsAgentFileController', () => {
  it('validates template agent names', () => {
    assert.equal(controller.validateTemplateName(''), 'Name cannot be empty');
    assert.equal(
      controller.validateTemplateName('dir/agent'),
      'Name cannot contain path separators',
    );
    assert.equal(
      controller.validateTemplateName('bad name'),
      'Use underscores instead of spaces',
    );
    assert.equal(
      controller.validateTemplateName('bad:name'),
      'Name cannot contain YAML-special characters',
    );
    assert.equal(controller.validateTemplateName('good_name'), null);
  });

  it('plans template agent files and render metadata', () => {
    assert.deepEqual(
      controller.planTemplateAgent({
        category: 'toolUse',
        name: 'reviewer.yaml',
        customDir: CUSTOM_DIR,
      }),
      {
        fileName: 'reviewer.yaml',
        filePath: path.join(CUSTOM_DIR, 'reviewer.yaml'),
        baseName: 'reviewer',
        description: 'reviewer — interactive tool-use agent',
        templateKind: 'toolUse',
      },
    );

    assert.deepEqual(
      controller.planTemplateAgent({
        category: 'workflow',
        name: 'writer',
        customDir: CUSTOM_DIR,
      }),
      {
        fileName: 'writer.yaml',
        filePath: path.join(CUSTOM_DIR, 'writer.yaml'),
        baseName: 'writer',
        description: 'writer — workflow agent',
        templateKind: 'workflowSingle',
      },
    );
  });
});
