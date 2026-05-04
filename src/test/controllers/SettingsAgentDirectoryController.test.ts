// Standard library imports
import { strict as assert } from 'assert';

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
      multiplePath: '/repo/resources/agents/writer_multiple.yaml',
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

  it('plans base and multiple YAML opens', () => {
    const { controller } = createController();

    assert.deepEqual(
      controller.planOpenAgentYaml({
        source: 'builtInWorkflow',
        name: 'writer',
        variant: 'base',
      }),
      { ok: true, path: '/repo/resources/agents/writer.yaml' },
    );
    assert.deepEqual(
      controller.planOpenAgentYaml({
        source: 'builtInWorkflow',
        name: 'writer',
        variant: 'multiple',
      }),
      { ok: true, path: '/repo/resources/agents/writer_multiple.yaml' },
    );
  });

  it('distinguishes missing agents from missing YAML paths', () => {
    const { controller } = createController();

    assert.deepEqual(
      controller.planOpenAgentYaml({
        source: 'custom',
        name: 'unknown',
        variant: 'base',
      }),
      { ok: false, reason: 'missingAgent' },
    );
    assert.deepEqual(
      controller.planOpenAgentYaml({
        source: 'custom',
        name: 'pathless',
        variant: 'base',
      }),
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
});
