import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listExecutionEditedFiles,
  listExecutionWorkspaceFiles,
} from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { platform } from '@platform/platform';
import { setupPlatform } from '@test/support/setupPlatform';
import { AbsoluteFS } from '@utils/files';

const CONFIG = { workingDirectory: '/workspace' };
const TOOL_USE_CONFIG = {
  workingDirectory: '/workspace',
  agentCategory: AgentCategory.ToolUse,
} as const;
const WORKFLOW_CONFIG = {
  workingDirectory: '/workspace',
  agentCategory: AgentCategory.Workflow,
} as const;

describe('listExecutionWorkspaceFiles', () => {
  setupPlatform({ workspacePath: '/workspace' });
  afterEach(() => vi.restoreAllMocks());

  it('lists unique contained entries in path order and omits missing paths', async () => {
    await AbsoluteFS.createDir('/workspace/z-dir');
    await AbsoluteFS.write('/workspace/a-file.tex', 'content');

    await expect(
      listExecutionWorkspaceFiles(CONFIG, [
        'z-dir',
        'missing.tex',
        'a-file.tex',
        'a-file.tex',
        '../outside.tex',
      ]),
    ).resolves.toEqual([
      {
        path: 'a-file.tex',
        displayPath: 'workspace/a-file.tex',
        absolutePath: '/workspace/a-file.tex',
        size: 7,
        isDirectory: false,
      },
      {
        path: 'z-dir',
        displayPath: 'workspace/z-dir',
        absolutePath: '/workspace/z-dir',
        size: 0,
        isDirectory: true,
      },
    ]);
  });

  it('omits a path whose intermediate component is not a directory', async () => {
    const error = Object.assign(new Error('parent path is not a directory'), {
      code: 'ENOTDIR',
    });
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listExecutionWorkspaceFiles(CONFIG, ['file/child.tex']),
    ).resolves.toEqual([]);
  });

  it('propagates operational stat failures', async () => {
    const error = Object.assign(new Error('workspace file is unreadable'), {
      code: 'EACCES',
    });
    vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    await expect(
      listExecutionWorkspaceFiles(CONFIG, ['unreadable.tex']),
    ).rejects.toBe(error);
  });
});

describe('listExecutionEditedFiles', () => {
  setupPlatform({ workspacePath: '/workspace' });

  const conversation = [
    {
      role: 'assistant',
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'derived.tex' }),
          },
        },
      ],
    },
  ];

  beforeEach(() => AbsoluteFS.createDir('/workspace'));

  it('prefers the persisted list over the conversation for tool-use runs', async () => {
    await AbsoluteFS.write('/workspace/persisted.tex', 'persisted');
    await AbsoluteFS.write('/workspace/derived.tex', 'derived');

    await expect(
      listExecutionEditedFiles(
        TOOL_USE_CONFIG,
        ['persisted.tex'],
        conversation,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ displayPath: 'workspace/persisted.tex' }),
    ]);
  });

  it('derives tool-use edits from the conversation when nothing was persisted', async () => {
    await AbsoluteFS.write('/workspace/derived.tex', 'derived');

    await expect(
      listExecutionEditedFiles(TOOL_USE_CONFIG, [], conversation),
    ).resolves.toEqual([
      expect.objectContaining({ displayPath: 'workspace/derived.tex' }),
    ]);
  });

  it('leaves workflow runs empty instead of deriving from the conversation', async () => {
    await AbsoluteFS.write('/workspace/derived.tex', 'derived');

    await expect(
      listExecutionEditedFiles(WORKFLOW_CONFIG, [], conversation),
    ).resolves.toEqual([]);
  });
});
