// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - controllers
import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';

const controller = new SettingsAgentFileController();
const ROOT = path.join(path.sep, 'repo');
const BUILT_IN_DIR = path.join(ROOT, 'resources', 'agents');
const CUSTOM_DIR = path.join(ROOT, 'custom-agents');

describe('SettingsAgentFileController', () => {
  it('plans custom agent copies while preserving source-relative paths', () => {
    const result = controller.planCustomizeAgent({
      customDir: CUSTOM_DIR,
      sourceDir: BUILT_IN_DIR,
      entry: {
        path: path.join(BUILT_IN_DIR, 'writing', 'draft.yaml'),
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.plan.targetPath,
      path.join(CUSTOM_DIR, 'writing', 'draft.yaml'),
    );
  });

  it('rejects customize targets that would escape the custom directory', () => {
    const result = controller.planCustomizeAgent({
      customDir: CUSTOM_DIR,
      sourceDir: BUILT_IN_DIR,
      entry: {
        path: path.join(ROOT, 'other', 'outside.yaml'),
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'targetEscapesCustomDir' });
  });

  it('falls back to the basename when the source directory is unknown', () => {
    const result = controller.planCustomizeAgent({
      customDir: CUSTOM_DIR,
      entry: {
        path: path.join(ROOT, 'elsewhere', 'agent.yaml'),
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.targetPath, path.join(CUSTOM_DIR, 'agent.yaml'));
  });

  it('accepts child paths when the custom directory is the filesystem root', () => {
    const result = controller.planDeleteCustomAgent({
      customDir: path.parse(ROOT).root,
      entry: {
        path: path.join(ROOT, 'custom-agents', 'agent.yaml'),
      },
    });

    assert.deepEqual(result, {
      ok: true,
      plan: {
        path: path.join(ROOT, 'custom-agents', 'agent.yaml'),
      },
    });
  });

  it('plans custom agent deletion for a custom directory agent', () => {
    const result = controller.planDeleteCustomAgent({
      customDir: CUSTOM_DIR,
      entry: {
        path: path.join(CUSTOM_DIR, 'agent.yaml'),
      },
    });

    assert.deepEqual(result, {
      ok: true,
      plan: {
        path: path.join(CUSTOM_DIR, 'agent.yaml'),
      },
    });
  });

  it('rejects deletion outside the custom directory', () => {
    const result = controller.planDeleteCustomAgent({
      customDir: CUSTOM_DIR,
      entry: {
        path: path.join(ROOT, 'resources', 'agent.yaml'),
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'fileOutsideCustomDir' });
  });

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
