import { strict as assert } from 'node:assert';
import * as path from 'node:path';

import { describe, it } from 'vitest';

import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';

const controller = new SettingsAgentFileController();
const CUSTOM_DIR = path.join(path.sep, 'repo', 'custom-agents');

describe('SettingsAgentFileController', () => {
  it.each([
    ['', 'Name cannot be empty'],
    ['dir/agent', 'Name cannot contain path separators'],
    ['bad name', 'Use underscores instead of spaces'],
    ['bad:name', 'Name cannot contain YAML-special characters'],
    ['good_name', null],
  ])('validates template agent name %j', (name, expected) => {
    assert.equal(controller.validateTemplateName(name), expected);
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
