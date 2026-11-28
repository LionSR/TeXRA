// Node imports
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { buildOpeningSystemPrompt } from '@agent/prompt/PromptBuilder';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

describe('PromptBuilder', () => {
  it.effect(
    "leaves the run's system text and the workspace's own facts as written",
    () =>
      Effect.gen(function* () {
        const storageRoot = mkdtempSync(join(os.tmpdir(), 'texra-prompt-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(storageRoot, { recursive: true })),
        );
        // A system text may be a model's (an `agent` call's) and a folder
        // name is the project's: an expression in either must reach the
        // model as written, never run in this process.
        const workspace = join(storageRoot, 'ws {{ 7 * 6 }}');
        mkdirSync(workspace);
        // cast: the opening reads only the workspace and the storage root.
        const roots = { workspace, storageRoot } as WorkspaceRoots;
        const system = yield* buildOpeningSystemPrompt('Work in {{ 6 * 7 }}.', {
          cwd: '/work',
          roots,
          textOnly: false,
          offered: ['bash'],
          memory: [],
        });
        expect(system).toContain('Work in {{ 6 * 7 }}.');
        expect(system).toContain('Working directory: /work');
        expect(system).toContain('ws {{ 7 * 6 }}');
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
  it.effect(
    "carries the person's own AGENTS.md with the project's, the project's last",
    () =>
      Effect.gen(function* () {
        const storageRoot = mkdtempSync(join(os.tmpdir(), 'texra-prompt-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(storageRoot, { recursive: true })),
        );
        const workspace = join(storageRoot, 'project');
        mkdirSync(workspace);
        writeFileSync(
          join(storageRoot, 'AGENTS.md'),
          'Use British spelling.\n',
        );
        writeFileSync(join(workspace, 'AGENTS.md'), 'Label equations eq:.\n');
        // cast: the opening reads only the workspace and the storage root.
        const roots = { workspace, storageRoot } as WorkspaceRoots;
        const system = yield* buildOpeningSystemPrompt('Answer the task.', {
          cwd: '/work',
          roots,
          textOnly: true,
          offered: [],
          memory: [],
        });
        expect(system.indexOf('Use British spelling.')).toBeGreaterThan(-1);
        expect(system.indexOf('Label equations eq:.')).toBeGreaterThan(
          system.indexOf('Use British spelling.'),
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
