import { describe, expect, it } from 'vitest';

import {
  childStatusColor,
  childStatusMarker,
  childStatusPulses,
} from '@cli/chat/tui/panes/SubagentListDisplay';

describe('CLI SubagentList display model', () => {
  it('pulses running statuses', () => {
    expect(childStatusPulses(undefined)).toBe(true);
    expect(childStatusPulses('running')).toBe(true);
    expect(childStatusPulses('in_progress')).toBe(true);
    expect(childStatusPulses('waiting')).toBe(false);
  });

  it('alternates the marker only for active rows', () => {
    expect(childStatusMarker('running', true)).toBe('● ');
    expect(childStatusMarker('running', false)).toBe('○ ');
    expect(childStatusMarker('waiting', false)).toBe('● ');
  });

  it('maps status colors consistently', () => {
    expect(childStatusColor(undefined)).toBe('green');
    expect(childStatusColor('running')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('stopped')).toBe('red');
  });
});
