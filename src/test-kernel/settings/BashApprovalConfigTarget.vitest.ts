// Standard library imports
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import type {
  ConfigInspection,
  ConfigTarget,
  StateStore,
} from '@platform/interfaces';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  setBashApprovalEnabled,
} from '@shared/settingsView/handlers/approvalHandlers';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class RecordingConfigProvider {
  readonly updateCalls: Array<{
    key: string;
    value: unknown;
    target: ConfigTarget | undefined;
  }> = [];

  get<T>(_key: string, defaultValue?: T): T {
    return defaultValue as T;
  }

  async update<T>(key: string, value: T, target?: ConfigTarget): Promise<void> {
    this.updateCalls.push({ key, value, target });
  }

  inspect<T = unknown>(_key: string): ConfigInspection<T> | undefined {
    return undefined;
  }

  isExplicitlySet(): boolean {
    return false;
  }

  watch(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

/** Index of the `)` matching the `(` at `openParenIndex`, accounting for nesting. */
function findMatchingParenEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`No matching ')' found for '(' at index ${openParenIndex}`);
}

describe('bash-approval config target', () => {
  it('is scoped per-workspace, not global', () => {
    // Bash approval gating is a security-adjacent bypass: disabling it in one
    // workspace must never disable it everywhere (issue #7085).
    expect(BASH_APPROVAL_CONFIG_TARGET).toBe('workspace');
  });

  it('setBashApprovalEnabled forwards the given target to config.update', async () => {
    const config = new RecordingConfigProvider();
    const ports = {
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      config,
    };

    await setBashApprovalEnabled(ports, false, BASH_APPROVAL_CONFIG_TARGET);

    expect(config.updateCalls).toHaveLength(1);
    expect(config.updateCalls[0]).toMatchObject({
      value: false,
      target: 'workspace',
    });
  });

  it('both the extension and desktop hosts pass the shared constant, not a literal', async () => {
    // Regression guard for issue #7085: the extension previously hardcoded
    // 'global' and desktop hardcoded 'workspace' at their respective call
    // sites, silently giving the same toggle different scopes per host. Pin
    // both call sites to reference BASH_APPROVAL_CONFIG_TARGET so they can
    // never drift apart again.
    const repoRoot = process.cwd();
    // NOTE: this list is hardcoded to the current hosts that wire the
    // bash-approval toggle. If a new host entry point starts calling
    // setBashApprovalEnabled, add its path here too, or this regression
    // guard will not see it and the scope-mismatch bug could reappear
    // unnoticed on the new host.
    const sites = [
      'packages/extension/src/settingsView/SettingsViewMessageHandler.ts',
      'packages/desktop/src/main/desktopSettingsIpc.ts',
    ];

    for (const relativePath of sites) {
      const source = await readFile(path.join(repoRoot, relativePath), 'utf8');

      assert.match(
        source,
        /BASH_APPROVAL_CONFIG_TARGET/,
        `${relativePath} must import/use BASH_APPROVAL_CONFIG_TARGET`,
      );

      // Find the actual invocation (identifier immediately followed by `(`),
      // as opposed to the import statement or the command-dispatch-table key
      // (both of which name the identifier without calling it); slice the
      // full call expression -- up to its matching closing paren, not a
      // fixed-width window -- and make sure it passes the shared constant,
      // not a raw 'global'/'workspace' string literal, as its target
      // argument. Matching the actual parens (rather than guessing a
      // character count) keeps this robust if the call site grows more
      // arguments or wraps onto more lines.
      const callSites = [...source.matchAll(/setBashApprovalEnabled\w*\(/g)];
      assert.ok(
        callSites.length > 0,
        `${relativePath} must call setBashApprovalEnabled`,
      );
      const lastCallSite = callSites.at(-1)!;
      const callSiteIndex = lastCallSite.index;
      const openParenIndex = callSiteIndex + lastCallSite[0].length - 1;
      const closeParenIndex = findMatchingParenEnd(source, openParenIndex);
      const callSiteWindow = source.slice(callSiteIndex, closeParenIndex + 1);

      assert.match(
        callSiteWindow,
        /BASH_APPROVAL_CONFIG_TARGET/,
        `${relativePath} must pass BASH_APPROVAL_CONFIG_TARGET as the call's target argument`,
      );
      assert.doesNotMatch(
        callSiteWindow,
        /['"](?:global|workspace)['"]/,
        `${relativePath} must not hardcode the bash-approval config target`,
      );
    }
  });
});
