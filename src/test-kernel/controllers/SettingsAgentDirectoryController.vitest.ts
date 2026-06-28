// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - controllers
import {
  SettingsAgentDirectoryController,
  type SettingsAgentDirectoryEntry,
} from '@controllers/settingsView/SettingsAgentDirectoryController';

const AGENTS = new Map<string, SettingsAgentDirectoryEntry>([
  [
    'builtInWorkflow:writer',
    {
      path: '/repo/resources/agents/writer.yaml',
    },
  ],
  [
    'custom:draft',
    {
      path: '/repo/custom-agents/draft.yaml',
    },
  ],
  ['custom:pathless', {}],
]);

function createController(options?: {
  configuredCustomDir?: string;
  customDir?: string;
  sourceDirs?: Record<string, string | undefined>;
  agents?: Map<string, SettingsAgentDirectoryEntry>;
}): {
  controller: SettingsAgentDirectoryController;
  getConfiguredCustomDir: () => string | undefined;
} {
  let configuredCustomDir = options?.configuredCustomDir;
  const agents = options?.agents ?? AGENTS;
  return {
    controller: new SettingsAgentDirectoryController({
      state: {
        getConfiguredCustomDir: () => configuredCustomDir,
        setConfiguredCustomDir: async (path) => {
          configuredCustomDir = path;
        },
        getCustomDir: async () => options?.customDir ?? '/repo/custom-agents',
        getSourceDir: async (source) => options?.sourceDirs?.[source],
        getAgent: (source, name) => agents.get(`${source}:${name}`) ?? null,
      },
    }),
    getConfiguredCustomDir: () => configuredCustomDir,
  };
}

describe('SettingsAgentDirectoryController', () => {
  it('reports default custom directory status from blank persisted state', async () => {
    const { controller } = createController({
      configuredCustomDir: '  ',
      customDir: '/repo/.texra/agents',
    });

    assert.deepEqual(await controller.getCustomDirStatus(), {
      path: '/repo/.texra/agents',
      isDefault: true,
    });
  });

  it('reports configured custom directory status from trimmed persisted state', async () => {
    const { controller } = createController({
      configuredCustomDir: ' /repo/custom ',
      customDir: '/repo/custom',
    });

    assert.deepEqual(await controller.getCustomDirStatus(), {
      path: '/repo/custom',
      isDefault: false,
    });
  });

  it('resets configured custom directory state', async () => {
    const { controller, getConfiguredCustomDir } = createController({
      configuredCustomDir: '/repo/custom',
    });

    await controller.resetCustomDir();

    assert.equal(getConfiguredCustomDir(), '');
  });

  it('sets configured custom directory state through the controller', async () => {
    const { controller, getConfiguredCustomDir } = createController();

    await controller.setCustomDir('/repo/custom');

    assert.equal(getConfiguredCustomDir(), '/repo/custom');
  });

  it('plans YAML open for a built-in agent', () => {
    const { controller } = createController();

    assert.deepEqual(
      controller.planOpenAgentYaml({
        source: 'builtInWorkflow',
        name: 'writer',
      }),
      { ok: true, path: '/repo/resources/agents/writer.yaml' },
    );
  });

  it('distinguishes missing agents from missing YAML paths', () => {
    const { controller } = createController();

    assert.deepEqual(
      controller.planOpenAgentYaml({ source: 'custom', name: 'unknown' }),
      { ok: false, reason: 'missingAgent' },
    );
    assert.deepEqual(
      controller.planOpenAgentYaml({ source: 'custom', name: 'pathless' }),
      { ok: false, reason: 'missingPath' },
    );
  });

  it('plans reveal file only for agents with a primary path', () => {
    const { controller } = createController();

    assert.deepEqual(
      controller.planRevealAgentFile({
        source: 'builtInWorkflow',
        name: 'writer',
      }),
      { ok: true, path: '/repo/resources/agents/writer.yaml' },
    );
    assert.deepEqual(
      controller.planRevealAgentFile({
        source: 'custom',
        name: 'pathless',
      }),
      { ok: false, reason: 'missingFile' },
    );
  });

  it('plans source directory opens only for local directories', async () => {
    const { controller } = createController({
      sourceDirs: {
        builtInWorkflow: '/repo/resources/agents',
        remote: undefined,
      },
    });

    assert.deepEqual(await controller.planOpenAgentFolder('builtInWorkflow'), {
      ok: true,
      path: '/repo/resources/agents',
    });
    assert.deepEqual(await controller.planOpenAgentFolder('remote'), {
      ok: false,
      reason: 'missingLocalDirectory',
    });
  });

  it('resolves customize input through agent, custom, and source directories', async () => {
    const { controller } = createController({
      customDir: '/repo/custom-agents',
      sourceDirs: {
        builtInWorkflow: '/repo/resources/agents',
      },
    });

    assert.deepEqual(
      await controller.resolveCustomizeAgentFileInput({
        source: 'builtInWorkflow',
        name: 'writer',
      }),
      {
        ok: true,
        input: {
          entry: { path: '/repo/resources/agents/writer.yaml' },
          customDir: '/repo/custom-agents',
          sourceDir: '/repo/resources/agents',
        },
      },
    );
  });

  it('refuses customize and delete inputs when an agent has no file', async () => {
    const { controller } = createController();

    assert.deepEqual(
      await controller.resolveCustomizeAgentFileInput({
        source: 'custom',
        name: 'pathless',
      }),
      { ok: false, reason: 'missingFile' },
    );
    assert.deepEqual(
      await controller.resolveDeleteCustomAgentFileInput('pathless'),
      { ok: false, reason: 'missingFile' },
    );
  });

  it('resolves delete input only from the custom agent namespace', async () => {
    const { controller } = createController({
      customDir: '/repo/custom-agents',
    });

    assert.deepEqual(
      await controller.resolveDeleteCustomAgentFileInput('draft'),
      {
        ok: true,
        input: {
          entry: { path: '/repo/custom-agents/draft.yaml' },
          customDir: '/repo/custom-agents',
        },
      },
    );
    assert.deepEqual(
      await controller.resolveDeleteCustomAgentFileInput('writer'),
      { ok: false, reason: 'missingFile' },
    );
  });
});
