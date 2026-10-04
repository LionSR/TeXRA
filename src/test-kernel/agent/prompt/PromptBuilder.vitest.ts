import { describe, expect, it } from 'vitest';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';

describe('PromptBuilder', () => {
  it('keeps pinned-memory consultation unconditional even for self-contained requests', () => {
    // Regression test for #7957: relevance gating (added in #7855) must not
    // silently drop pinned memories, which are documented as loading every
    // session (docs/guide/memory.md, MemoryTool's description).
    const instructionSuffix = memoryPromptSection({
      offered: ['memory'],
      isChild: false,
      isAnthropic: false,
      config: new MemoryConfigProvider(),
    });

    // Behavioral contract, not exact prose (review note on #7959): pinned
    // files must be individually viewed at session start — a directory
    // listing alone does not load their content — and this must hold even
    // for self-contained-looking requests.
    expect(instructionSuffix).toMatch(/Pinned memories are always loaded/);
    expect(instructionSuffix).toMatch(
      /`view` each \[pinned\] file|`view` each pinned file|read each pinned memory file/,
    );
    expect(instructionSuffix).toMatch(
      /regardless of how self-contained|even for requests that otherwise look self-contained/,
    );
    expect(instructionSuffix).not.toMatch(
      /When memory is relevant, consult pinned memories first/,
    );
    expect(instructionSuffix).toMatch(
      /When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history/,
    );
    expect(instructionSuffix).not.toMatch(
      /^ +- When git is available, look into git history/m,
    );
  });
});
