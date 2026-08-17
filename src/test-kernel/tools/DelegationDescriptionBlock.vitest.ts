import { describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '@shared/schemas';
import { replaceDelegationDescriptionBlock } from '@tools/delegation/delegationAvailability';

const LINE = /^Anchor:.*$/m;

function delegateTool(description: string): ToolDefinition {
  return { name: 'delegate_agent', description };
}

function replaceIn(
  tool: ToolDefinition,
  replacement: string | (() => string),
  appendIfMissing = true,
): ToolDefinition {
  return replaceDelegationDescriptionBlock(tool, LINE, replacement, {
    appendIfMissing,
  });
}

describe('replaceDelegationDescriptionBlock', () => {
  it('leaves non-delegation tools untouched (same reference)', () => {
    const tool: ToolDefinition = {
      name: 'read_file',
      description: 'Anchor: x',
    };
    expect(replaceIn(tool, 'Anchor: y')).toBe(tool);
  });

  it('leaves a delegation tool without a description untouched', () => {
    const tool: ToolDefinition = { name: 'delegate_agent' };
    expect(replaceIn(tool, 'Anchor: y')).toBe(tool);
  });

  it('replaces the matched block in place', () => {
    const tool = delegateTool('Intro.\nAnchor: old\nOutro.');
    expect(replaceIn(tool, 'Anchor: new').description).toBe(
      'Intro.\nAnchor: new\nOutro.',
    );
  });

  it('keeps a $ in the replacement literal', () => {
    const tool = delegateTool('Anchor: old');
    expect(replaceIn(tool, 'Anchor: $P=NP$').description).toBe(
      'Anchor: $P=NP$',
    );
  });

  it('appends the block when missing and appendIfMissing is true', () => {
    const tool = delegateTool('Intro only.');
    expect(replaceIn(tool, 'Anchor: added').description).toBe(
      'Intro only.\n\nAnchor: added',
    );
  });

  it('leaves the description unchanged when missing and append is off', () => {
    const tool = delegateTool('Intro only.');
    expect(replaceIn(tool, 'Anchor: added', false).description).toBe(
      'Intro only.',
    );
  });

  it('never evaluates the replacement thunk when the tool is skipped', () => {
    const thunk = vi.fn(() => 'Anchor: computed');

    // Replace-only, anchor absent → thunk must not run (mirrors the worktree
    // annotation reading its config setting only when the line is present).
    replaceIn(delegateTool('Intro only.'), thunk, false);
    // Non-delegation tool → thunk must not run.
    replaceIn({ name: 'read_file', description: 'Anchor: x' }, thunk);
    expect(thunk).not.toHaveBeenCalled();

    // Anchor present → thunk runs exactly once.
    const out = replaceIn(delegateTool('Anchor: x'), thunk, false);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(out.description).toBe('Anchor: computed');
  });
});
