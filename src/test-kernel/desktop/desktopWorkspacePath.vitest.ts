import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';

import { resolveWorkspacePath } from '../../../packages/desktop/src/main/platform/paths';
import {
  hasResolvedWorkspacePath,
  hasWorkspacePath,
  serializeWorkspacePresenceArg,
  withWorkspacePathArg,
} from '../../../packages/desktop/src/workspacePath';

describe('desktop workspace path', () => {
  it('resolves CLI workspace path before env and stored workspace', () => {
    assert.equal(
      resolveWorkspacePath({
        argv: ['--texra-workspace', 'cli-workspace'],
        env: { TEXRA_WORKSPACE_PATH: 'env-workspace' },
        storedWorkspacePath: 'stored-workspace',
      }),
      resolve('cli-workspace'),
    );
  });

  it('resolves env workspace before stored workspace', () => {
    assert.equal(
      resolveWorkspacePath({
        argv: [],
        env: { TEXRA_WORKSPACE_PATH: 'env-workspace' },
        storedWorkspacePath: 'stored-workspace',
      }),
      resolve('env-workspace'),
    );
  });

  it('restores the last desktop-opened workspace when CLI and env are absent', () => {
    assert.equal(
      resolveWorkspacePath({
        argv: [],
        env: {},
        storedWorkspacePath: 'stored-workspace',
      }),
      resolve('stored-workspace'),
    );
    assert.equal(
      resolveWorkspacePath({
        argv: [],
        env: {},
      }),
      undefined,
    );
  });

  it('does not treat empty workspace flags as an opened workspace', () => {
    assert.equal(
      hasWorkspacePath({ argv: ['--texra-workspace'], env: {} }),
      false,
    );
    assert.equal(
      hasWorkspacePath({ argv: ['--texra-workspace='], env: {} }),
      false,
    );
    assert.equal(
      hasWorkspacePath({ argv: ['--texra-workspace', 'paper'], env: {} }),
      true,
    );
  });

  it('does not treat option-like positional workspace values as paths', () => {
    assert.equal(
      hasWorkspacePath({ argv: ['--texra-workspace', '--inspect'], env: {} }),
      false,
    );
    assert.equal(
      resolveWorkspacePath({
        argv: ['--texra-workspace', '--inspect'],
        env: {},
      }),
      undefined,
    );
  });

  it('does not treat desktop protocol callback URLs as workspace paths', () => {
    assert.equal(
      hasWorkspacePath({
        argv: ['--texra-workspace', 'texra://auth-callback?code=1'],
        env: {},
      }),
      false,
    );
    assert.equal(
      resolveWorkspacePath({
        argv: ['--texra-workspace', 'texra://auth-callback?code=1'],
        env: {},
      }),
      undefined,
    );
    assert.equal(
      hasWorkspacePath({
        argv: ['--texra-workspace=texra://auth-callback?code=1'],
        env: {},
      }),
      false,
    );
    assert.equal(
      resolveWorkspacePath({
        argv: ['--texra-workspace=texra://auth-callback?code=1'],
        env: {},
      }),
      undefined,
    );
  });

  it('uses main-process workspace resolution when exposing renderer state', () => {
    assert.equal(
      hasResolvedWorkspacePath({
        argv: [serializeWorkspacePresenceArg(true)],
      }),
      true,
    );
    assert.equal(
      hasResolvedWorkspacePath({
        argv: [
          '--texra-workspace',
          'renderer-process-argv-is-not-authoritative',
          serializeWorkspacePresenceArg(false),
        ],
      }),
      false,
    );
  });

  it('replaces existing workspace CLI args when relaunching into a selected folder', () => {
    assert.deepEqual(
      withWorkspacePathArg(
        [
          '/Applications/TeXRA.app',
          '--inspect',
          '--texra-workspace',
          'old-workspace',
          '--flag',
          'texra://texra-ai.texra/auth-callback?state=old',
          '--texra-workspace=/tmp/other-workspace',
        ],
        '/Users/ray/paper',
      ),
      [
        '/Applications/TeXRA.app',
        '--inspect',
        '--flag',
        '--texra-workspace',
        '/Users/ray/paper',
      ],
    );
  });
});
