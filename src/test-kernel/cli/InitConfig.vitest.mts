import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import {
  buildInitConfig,
  gitignoreWithTexra,
  serializeInitConfig,
  type InitAnswers,
} from '@cli/runtime/initConfig';

const ANSWERS: InitAnswers = {
  agent: 'chat',
  model: 'deepseekT',
  approvalPolicy: 'ask',
  outputFormat: 'json',
};

describe('buildInitConfig', () => {
  it('maps answers to the canonical config shape', () => {
    expect(buildInitConfig(ANSWERS)).toEqual({
      model: 'deepseekT',
      outputFormat: 'json',
      approvalPolicy: 'ask',
      chat: { agent: 'chat', model: 'deepseekT' },
    });
  });
});

describe('serializeInitConfig', () => {
  it('produces pretty JSON with a trailing newline', () => {
    const text = serializeInitConfig(buildInitConfig(ANSWERS));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildInitConfig(ANSWERS));
    expect(text).toContain('  "chat": {');
  });
});

describe('workspaceTexraConfigPath', () => {
  it('resolves the workspace path under cwd', () => {
    expect(workspaceTexraConfigPath('/projects/paper')).toBe(
      path.join('/projects/paper', '.texra', 'config.json'),
    );
  });
});

describe('gitignoreWithTexra', () => {
  it('appends .texra/ to a non-empty file', () => {
    expect(gitignoreWithTexra('node_modules\ndist\n')).toBe(
      'node_modules\ndist\n.texra/\n',
    );
  });

  it('creates content from an empty file', () => {
    expect(gitignoreWithTexra('')).toBe('.texra/\n');
  });

  it('returns null when .texra/ is already ignored', () => {
    expect(gitignoreWithTexra('node_modules\n.texra/\n')).toBeNull();
  });

  it('treats a bare .texra entry as already ignored', () => {
    expect(gitignoreWithTexra('.texra\n')).toBeNull();
  });
});
