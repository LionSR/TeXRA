import { strict as assert } from 'assert';

import { ReadConfigTool, UpdateConfigTool } from '@tools/setup/ConfigTools';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';

import { createFakeSetupPlatform } from './fixtures';

interface UpdateRecord {
  key: string;
  value: unknown;
  target: 'user' | 'workspace';
}

function createPlatform(initial: Record<string, unknown> = {}): {
  platform: SetupPlatform;
  store: Record<string, unknown>;
  updates: UpdateRecord[];
} {
  const store: Record<string, unknown> = { ...initial };
  const updates: UpdateRecord[] = [];
  const platform = createFakeSetupPlatform({
    config: {
      get(key) {
        return store[key];
      },
      async update(key, value, target) {
        updates.push({ key, value, target });
        store[key] = value;
      },
    },
  });
  return { platform, store, updates };
}

describe('ConfigTools — read_config', () => {
  it('reads an existing texra.* key', async () => {
    const { platform } = createPlatform({ 'texra.bib.zoteroPort': 23119 });
    setSetupPlatform(platform);
    const tool = new ReadConfigTool();

    const result = await tool.call({ key: 'texra.bib.zoteroPort' });

    assert.ok(!('isError' in result) || !result.isError);
    assert.match(result.output ?? '', /23119/);
  });

  it('rejects keys not starting with texra.', async () => {
    const { platform } = createPlatform();
    setSetupPlatform(platform);
    const tool = new ReadConfigTool();

    const result = await tool.call({ key: 'editor.fontSize' });

    assert.ok(result.isError, 'should report an error');
  });
});

describe('ConfigTools — update_config allowlist', () => {
  it('writes an allowlisted key when the value matches its schema', async () => {
    const { platform, store, updates } = createPlatform({
      'texra.bib.zoteroPort': 23119,
    });
    setSetupPlatform(platform);
    const tool = new UpdateConfigTool();

    const result = await tool.call({
      key: 'texra.bib.zoteroPort',
      value: 23200,
      target: 'user',
    });

    assert.ok(!('isError' in result) || !result.isError);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].key, 'texra.bib.zoteroPort');
    assert.equal(updates[0].value, 23200);
    assert.equal(updates[0].target, 'user');
    assert.equal(store['texra.bib.zoteroPort'], 23200);
    // Output reports both before and after values for the educative summary.
    assert.match(result.output ?? '', /23119/);
    assert.match(result.output ?? '', /23200/);
  });

  it('rejects non-allowlisted keys at schema parse time (no write)', async () => {
    const { platform, updates } = createPlatform();
    setSetupPlatform(platform);
    const tool = new UpdateConfigTool();

    const result = await tool.call({
      key: 'texra.model.useImprovedConnection',
      value: true,
      target: 'user',
    });

    assert.ok(result.isError, 'should reject off-allowlist key');
    assert.equal(updates.length, 0, 'must not call platform.update');
  });

  it('rejects type-mismatched values for an allowlisted key', async () => {
    const { platform, updates } = createPlatform();
    setSetupPlatform(platform);
    const tool = new UpdateConfigTool();

    const result = await tool.call({
      key: 'texra.bib.zoteroPort',
      value: 'not a number',
      target: 'user',
    });

    assert.ok(result.isError, 'string value should be rejected');
    assert.equal(updates.length, 0);
  });

  it('rejects out-of-range numeric values', async () => {
    const { platform, updates } = createPlatform();
    setSetupPlatform(platform);
    const tool = new UpdateConfigTool();

    // Port range is 1..65535
    for (const port of [0, -1, 70000]) {
      const result = await tool.call({
        key: 'texra.bib.zoteroPort',
        value: port,
        target: 'user',
      });
      assert.ok(result.isError, `${port} should be rejected`);
    }

    assert.equal(updates.length, 0);
  });

  it('honors target=workspace scope', async () => {
    const { platform, updates } = createPlatform();
    setSetupPlatform(platform);
    const tool = new UpdateConfigTool();

    await tool.call({
      key: 'texra.bib.defaultPath',
      value: 'refs.bib',
      target: 'workspace',
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].target, 'workspace');
  });
});
