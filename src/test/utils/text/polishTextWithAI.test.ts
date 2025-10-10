// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent runtime
import { ModelFactory } from '@agent/runtime/ModelFactory';

// Local imports - models
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

// Local imports - utilities
import { polishTextWithAI } from '@utils/text/textEnhancementUtils';

describe('polishTextWithAI', () => {
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  const originalCreateHandler = ModelFactory.createHandler;
  const configValues = new Map<string, unknown>();
  const stubCapabilities = { ...DEFAULT_MODEL_CAPABILITIES };
  const stubModelConfig: ModelConfig = {
    name: 'test-polish',
    fullName: 'stub-provider/test-polish',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 4096,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 8192,
    capabilities: stubCapabilities,
    openRouterOnly: false,
  };
  const originalStubConfig = MODEL_CONFIGS['test-polish'];
  let lastHandler: StubModelHandler | undefined;

  class StubModelHandler {
    public prefix: string | undefined;
    public request: string | undefined;
    constructor(public readonly config: ModelConfig) {}

    setOutputStreaming(): void {
      // no-op for tests
    }

    async getClient(): Promise<Record<string, never>> {
      return {};
    }

    async initializeMessages(
      prefix: string,
      request: string,
    ): Promise<Array<{ role: string; content: string }>> {
      this.prefix = prefix;
      this.request = request;
      const content = prefix ? `${prefix}\n${request}` : request;
      return [{ role: 'user', content }];
    }

    async createResponse(): Promise<string> {
      return '<corrected_text>Polished instruction</corrected_text>';
    }

    extractResponse(response: string): [string, undefined, 'stop'] {
      return [response, undefined, 'stop'];
    }
  }

  function getConfigValue(
    section: string | undefined,
    key: string | undefined,
  ): unknown {
    if (!key) {
      return undefined;
    }
    if (section) {
      const direct = `${section}.${key}`;
      if (configValues.has(direct)) {
        return configValues.get(direct);
      }
    }
    if (configValues.has(key)) {
      return configValues.get(key);
    }
    if (section) {
      const prefixed = `texra.${key}`;
      if (configValues.has(prefixed)) {
        return configValues.get(prefixed);
      }
    } else {
      const prefixed = `texra.${key}`;
      if (configValues.has(prefixed)) {
        return configValues.get(prefixed);
      }
    }
    return undefined;
  }

  before(() => {
    MODEL_CONFIGS['test-polish'] = stubModelConfig;
    (vscode.workspace as any).getConfiguration = (section?: string) => ({
      get: (key?: string) => getConfigValue(section, key),
      update: () => Promise.resolve(),
      inspect: () => undefined,
    });
  });

  after(() => {
    (vscode.workspace as any).getConfiguration = originalGetConfiguration;
    (ModelFactory as any).createHandler = originalCreateHandler;
    if (originalStubConfig) {
      MODEL_CONFIGS['test-polish'] = originalStubConfig;
    } else {
      delete MODEL_CONFIGS['test-polish'];
    }
  });

  beforeEach(() => {
    configValues.clear();
    configValues.set('model.useCopilot', false);
    configValues.set('texra.model.useCopilot', false);
    configValues.set('texra.model.instructionPolishModel', 'test-polish');
    configValues.set('model.instructionPolishModel', 'test-polish');
    lastHandler = undefined;
  });

  it('uses the configured model name when polishing instructions', async () => {
    let capturedConfigName: string | undefined;

    (ModelFactory as any).createHandler = (config: ModelConfig) => {
      const handler = new StubModelHandler(config);
      capturedConfigName = config.name;
      lastHandler = handler;
      return handler;
    };

    const result = await polishTextWithAI('draft instructions');

    assert.equal(result.success, true, 'should succeed when stub handler resolves');
    assert.equal(
      result.text,
      'Polished instruction',
      'should extract the corrected text from the stub response',
    );
    assert.equal(
      capturedConfigName,
      'test-polish',
      'should instantiate a handler for the configured model name',
    );

    assert.ok(lastHandler, 'expected the handler to be captured');
    assert.equal(
      lastHandler?.prefix,
      '',
      'should not apply a redundant polishing prefix',
    );
    assert.ok(
      lastHandler?.request?.includes('draft instructions'),
      'should include the original text in the polishing prompt',
    );
  });

  it('returns a clear error when the configured model is missing', async () => {
    configValues.set('model.instructionPolishModel', 'unknown-model');
    configValues.set('texra.model.instructionPolishModel', 'unknown-model');
    (ModelFactory as any).createHandler = () => {
      throw new Error('createHandler should not run for unknown models');
    };

    const result = await polishTextWithAI('draft instructions');

    assert.equal(result.success, false, 'should fail when the model short name is unknown');
    assert.ok(result.error?.includes('unknown-model'));
  });
});
