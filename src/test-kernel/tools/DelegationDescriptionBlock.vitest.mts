import { describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '@model';
import { replaceDelegationDescriptionBlock } from '@tools/delegationDescriptionBlock';

const LINE = /^Anchor:.*$/m;

describe('replaceDelegationDescriptionBlock', () => {
  it('leaves non-delegation tools untouched (same reference)', () => {
    const tool: ToolDefinition = {
      name: 'read_file',
      description: 'Anchor: x',
    };
    expect(
      replaceDelegationDescriptionBlock(tool, LINE, 'Anchor: y', {
        appendIfMissing: true,
      }),
    ).toBe(tool);
  });

  it('leaves a delegation tool without a description untouched', () => {
    const tool: ToolDefinition = { name: 'delegate_agent' };
    expect(
      replaceDelegationDescriptionBlock(tool, LINE, 'Anchor: y', {
        appendIfMissing: true,
      }),
    ).toBe(tool);
  });

  it('replaces the matched block in place', () => {
    const tool: ToolDefinition = {
      name: 'delegate_agent',
      description: 'Intro.\nAnchor: old\nOutro.',
    };
    expect(
      replaceDelegationDescriptionBlock(tool, LINE, 'Anchor: new', {
        appendIfMissing: true,
      }).description,
    ).toBe('Intro.\nAnchor: new\nOutro.');
  });

  it('keeps a $ in the replacement literal', () => {
    const tool: ToolDefinition = {
      name: 'delegate_agent',
      description: 'Anchor: old',
    };
    expect(
      replaceDelegationDescriptionBlock(tool, LINE, 'Anchor: $P=NP$', {
        appendIfMissing: true,
      }).description,
    ).toBe('Anchor: $P=NP$');
  });

  it('appends the block when missing and appendIfMissing is true', () => {
    const tool: ToolDefinition = {
      name: 'delegate_agent',
      description: 'Intro only.',
    };
    expect(
      replaceDelegationDescriptionBlock(tool, LINE, 'Anchor: added', {
        appendIfMissing: true,
      }).description,
    ).toBe('Intro only.\n\nAnchor: added');
  });

  it('leaves the description unchanged when missing and append is off', () => {
    const tool: ToolDefinition = {
      name: 'delegate_agent',
      description: 'Intro only.',
    };
    const result = replaceDelegationDescriptionBlock(
      tool,
      LINE,
      'Anchor: added',
      { appendIfMissing: false },
    );
    expect(result.description).toBe('Intro only.');
  });

  it('never evaluates the replacement thunk when the tool is skipped', () => {
    const thunk = vi.fn(() => 'Anchor: computed');

    // Replace-only, anchor absent → thunk must not run (mirrors the worktree
    // annotation reading its config setting only when the line is present).
    replaceDelegationDescriptionBlock(
      { name: 'delegate_agent', description: 'Intro only.' },
      LINE,
      thunk,
      { appendIfMissing: false },
    );
    // Non-delegation tool → thunk must not run.
    replaceDelegationDescriptionBlock(
      { name: 'read_file', description: 'Anchor: x' },
      LINE,
      thunk,
      { appendIfMissing: true },
    );
    expect(thunk).not.toHaveBeenCalled();

    // Anchor present → thunk runs exactly once.
    const out = replaceDelegationDescriptionBlock(
      { name: 'delegate_agent', description: 'Anchor: x' },
      LINE,
      thunk,
      { appendIfMissing: false },
    );
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(out.description).toBe('Anchor: computed');
  });
});
