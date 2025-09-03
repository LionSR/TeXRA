import * as assert from 'assert';
import { describe, it, before } from 'mocha';
import * as vscode from 'vscode';
import {
  executeAgent,
  executeMergeAgent,
} from '../../agent/runtime/executeAgent';
import { SecretManager } from '../../frontend/secretManager';
import { bus } from '../../eventBus/ProgressEventBus';

const stubContext: any = {
  secrets: {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
  },
};

function patchMessageApis() {
  (vscode.window as any).showInformationMessage = async () => undefined;
  (vscode.window as any).showErrorMessage = async () => undefined;
}

async function expectNoProgress(fn: () => Promise<unknown>) {
  const events: string[] = [];
  const originalEmit = (bus as any).emit.bind(bus);
  (bus as any).emit = (event: string, payload: unknown) => {
    events.push(event);
    originalEmit(event, payload);
  };
  await assert.rejects(fn(), /Missing API key/);
  assert.deepStrictEqual(events, []);
  (bus as any).emit = originalEmit;
}

describe('API key validation', () => {
  before(() => {
    SecretManager.initialize(stubContext);
    patchMessageApis();
  });

  it('executeAgent fails before progress events when key missing', async () => {
    await expectNoProgress(() =>
      executeAgent(
        { agent: 'polish', model: 'gpt-4o-mini', inputFile: 'input.tex' },
        {} as any,
      ),
    );
  });

  it('executeMergeAgent fails before progress events when key missing', async () => {
    await expectNoProgress(() =>
      executeMergeAgent('gpt-4o-mini', 'input.tex', 'edited.tex', {} as any),
    );
  });
});
