// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, vi } from 'vitest';

import { ReadConfigTool, UpdateConfigTool } from '@tools/setup/ConfigTools';

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(),
  update:
    vi.fn<
      (
        key: string,
        value: unknown,
        target: 'user' | 'workspace',
      ) => Promise<void>
    >(),
}));

const readTool = new ReadConfigTool();
const updateTool = new UpdateConfigTool();

vi.mock('@tools/setup/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tools/setup/platform')>();
  return {
    ...actual,
    texraScopedConfig: {
      get: mocks.get,
      update: mocks.update,
    },
  };
});

interface UpdateRecord {
  key: string;
  value: unknown;
  target: 'user' | 'workspace';
}

function createPlatform(initial: Record<string, unknown> = {}): {
  store: Record<string, unknown>;
  updates: UpdateRecord[];
} {
  const store: Record<string, unknown> = { ...initial };
  const updates: UpdateRecord[] = [];
  mocks.get.mockImplementation((key) => store[key]);
  mocks.update.mockImplementation(async (key, value, target) => {
    updates.push({ key, value, target });
    store[key] = value;
  });
  return { store, updates };
}

afterEach(() => {
  mocks.get.mockReset();
  mocks.update.mockReset();
});

describe('ConfigTools — read_config', () => {
  it('reads an existing texra.* key', async () => {
    createPlatform({ 'texra.bib.zoteroPort': 23119 });

    const result = await readTool.call({ key: 'texra.bib.zoteroPort' });

    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /23119/);
  });

  it('rejects keys not starting with texra.', async () => {
    createPlatform();

    const result = await readTool.call({ key: 'editor.fontSize' });

    assert.equal(result.status, 'error');
  });
});

describe('ConfigTools — update_config allowlist', () => {
  it('writes an allowlisted key when the value matches its schema', async () => {
    const { store, updates } = createPlatform({
      'texra.bib.zoteroPort': 23119,
    });

    const result = await updateTool.call({
      key: 'texra.bib.zoteroPort',
      value: 23200,
      target: 'user',
    });

    assert.equal(result.status, 'executed');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, 'texra.bib.zoteroPort');
    assert.equal(updates[0].value, 23200);
    assert.equal(updates[0].target, 'user');
    assert.equal(store['texra.bib.zoteroPort'], 23200);
    // Output reports both before and after values for the educative summary.
    assert.match(result.output ?? '', /23119/);
    assert.match(result.output ?? '', /23200/);
  });

  it.each([
    {
      case: 'a non-allowlisted key',
      key: 'texra.model.useOpenAIResponsesAPI',
      value: true,
    },
    {
      case: 'a type-mismatched value',
      key: 'texra.bib.zoteroPort',
      value: 'not a number',
    },
    // Port range is 1..65535
    { case: 'port 0', key: 'texra.bib.zoteroPort', value: 0 },
    { case: 'port -1', key: 'texra.bib.zoteroPort', value: -1 },
    { case: 'port 70000', key: 'texra.bib.zoteroPort', value: 70000 },
  ])('rejects $case without writing', async ({ key, value }) => {
    const { updates } = createPlatform();

    const result = await updateTool.call({ key, value, target: 'user' });

    assert.equal(result.status, 'error');
    assert.equal(updates.length, 0, 'must not call platform.update');
  });

  it('honors target=workspace scope', async () => {
    const { updates } = createPlatform();

    await updateTool.call({
      key: 'texra.bib.defaultPath',
      value: 'refs.bib',
      target: 'workspace',
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].target, 'workspace');
  });
});
