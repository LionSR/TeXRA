// Node imports
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { registerExternalRoot } from '@utils/files/externalRoots';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';

describe('PromptBuilder', () => {
  it('keeps pinned-memory consultation unconditional even for self-contained requests', () => {
    // Regression test for #7957: relevance gating (added in #7855) must not
    // silently drop pinned memories, which are documented as applying to
    // every session (docs/guide/memory.md, MemoryTool's description).
    const instructionSuffix = memoryPromptSection({
      offered: ['memory'],
      isChild: false,
      config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog),
    });

    // Behavioral contract, not exact prose (review note on #7959): pinned
    // files must be individually viewed at session start — a directory
    // listing alone does not load their content — and this must hold even
    // for self-contained-looking requests.
    expect(instructionSuffix).toMatch(/Pinned memories apply to every session/);
    expect(instructionSuffix).toMatch(
      /`view` each \[pinned\] file|`view` each pinned file|read each pinned memory file/,
    );
    expect(instructionSuffix).toMatch(
      /regardless of how self-contained|even for requests that otherwise look self-contained/,
    );
    expect(instructionSuffix).not.toMatch(
      /When memory is relevant, consult pinned memories first/,
    );
  });

  it.effect(
    'names no shell or file tool to a run offered none (golden_child: executions)',
    () =>
      Effect.gen(function* () {
        const unregister = registerExternalRoot(join(os.tmpdir(), 'agents'), {
          kind: 'builtIn',
          writable: false,
          label: 'Built-in agents',
        });
        yield* Effect.addFinalizer(() => Effect.sync(unregister));
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
              BUILTIN_AGENTS_DIR: '',
              CUSTOM_AGENTS_DIR: '',
              AGENT_DOCS_DIR: '',
            },
            activated: [],
            attachedMemories: null,
            attachedMemoryMisses: [],
          },
          { roots, textOnly: false, offered: ['executions', 'plan'] },
        );
        expect(system).toContain('<tool_use_instructions>');
        // `Shell:` in `<workspace_info>` names the user's shell, not a tool.
        expect(system).not.toMatch(/bash tool|glob\/grep|read_file/);
        // Nor what not to write with a file tool it does not have.
        const { sections } = stepInstructions([], [], {
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
            inputs: {
              CWD: '/work',
              BUILTIN_AGENTS_DIR: '',
              CUSTOM_AGENTS_DIR: '',
              AGENT_DOCS_DIR: '',
            },
            activated: [],
            attachedMemories: null,
            attachedMemoryMisses: [],
          },
          { roots, textOnly: false, offered: ['bash'] },
        );
        expect(system).toContain('Work in /work.');
        expect(system).toContain('executes every command from /work.');
        expect(system).toContain('ws {{ 7 * 6 }}');
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
