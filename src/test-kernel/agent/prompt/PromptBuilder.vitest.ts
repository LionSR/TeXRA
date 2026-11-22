// Node imports
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  buildOpeningSystemPrompt,
  stepInstructions,
} from '@agent/prompt/PromptBuilder';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';

describe('PromptBuilder', () => {
  it.effect(
    'names no shell or file tool to a run offered none (golden_child: executions)',
    () =>
      Effect.gen(function* () {
        const storageRoot = mkdtempSync(join(os.tmpdir(), 'texra-prompt-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(storageRoot, { recursive: true })),
        );
        // cast: the opening reads only the workspace and the storage root.
        const roots = { workspace: undefined, storageRoot } as WorkspaceRoots;
        const system = yield* buildOpeningSystemPrompt(
          'Answer the task.',
          {
            inputs: {
              CWD: '/work',
            },
            activated: [],
          },
          {
            roots,
            textOnly: false,
            offered: ['executions', 'plan'],
            memory: [],
          },
        );
        expect(system).toContain('<tool_use_instructions>');
        // `Shell:` in `<workspace_info>` names the user's shell, not a tool.
        expect(system).not.toMatch(/bash tool|glob\/grep|read_file/);
        // Nor what not to write with a file tool it does not have.
        const { sections } = stepInstructions([], [], null, {
          offered: ['executions', 'plan'],
          isChild: true,
          config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog),
        });
        expect(sections['tool-call']).not.toMatch(/markdown files/);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    "renders the persona's prompt and leaves the workspace's own facts as written",
    () =>
      Effect.gen(function* () {
        const storageRoot = mkdtempSync(join(os.tmpdir(), 'texra-prompt-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(storageRoot, { recursive: true })),
        );
        // A folder name is the project's, like a branch name: an expression
        // in one must reach the model as written, never run in this process.
        const workspace = join(storageRoot, 'ws {{ 7 * 6 }}');
        mkdirSync(workspace);
        // cast: the opening reads only the workspace and the storage root.
        const roots = { workspace, storageRoot } as WorkspaceRoots;
        const system = yield* buildOpeningSystemPrompt(
          'Work in {{ CWD }}.',
          {
            inputs: { CWD: '/work' },
            activated: [],
          },
          { roots, textOnly: false, offered: ['bash'], memory: [] },
        );
        expect(system).toContain('Work in /work.');
        expect(system).toContain('executes every command from /work.');
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
        const system = yield* buildOpeningSystemPrompt(
          'Answer the task.',
          {
            inputs: { CWD: '/work' },
            activated: [],
          },
          { roots, textOnly: true, offered: [], memory: [] },
        );
        expect(system.indexOf('Use British spelling.')).toBeGreaterThan(-1);
        expect(system.indexOf('Label equations eq:.')).toBeGreaterThan(
          system.indexOf('Use British spelling.'),
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
