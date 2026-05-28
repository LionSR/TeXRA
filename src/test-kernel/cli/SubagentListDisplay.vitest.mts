import { describe, expect, it } from 'vitest';

import {
  childStatusColor,
  childStatusMarker,
} from '@cli/chat/tui/panes/SubagentListDisplay';

describe('CLI SubagentList display model', () => {
  it('renders a steady (non-animated) marker for every status', () => {
    // The marker is intentionally static: a blinking dot forced the whole live
    // region to repaint twice a second, which surfaced Ink repaint residue.
    expect(childStatusMarker()).toBe('● ');
  });

  it('maps status colors consistently', () => {
    expect(childStatusColor(undefined)).toBe('green');
    expect(childStatusColor('running')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('stopped')).toBe('red');
  });
});
