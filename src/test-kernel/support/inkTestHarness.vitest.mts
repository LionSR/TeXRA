// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  loadInk,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.mts';

describe('Ink test harness', () => {
  it('returns only the current frame after an effect-driven repaint', async () => {
    const { ink, React } = await loadInk();

    function RepaintingComponent(): any {
      const [frame, setFrame] = React.useState('old-frame');
      React.useEffect(() => setFrame('new-frame'), []);
      return React.createElement(ink.Text, null, frame);
    }

    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(RepaintingComponent),
      80,
      { until: (frame) => frame.includes('new-frame') },
    );

    expect(output).toBe('new-frame');
  });
});
