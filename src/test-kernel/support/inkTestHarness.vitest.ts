import { describe, expect, it } from 'vitest';

import {
  loadInk,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.ts';

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

  it('returns an empty current frame after an effect clears the output', async () => {
    const { ink, React } = await loadInk();
    let effectRan = false;

    function ClearingComponent(): any {
      const [visible, setVisible] = React.useState(true);
      React.useEffect(() => {
        effectRan = true;
        setVisible(false);
      }, []);
      return visible ? React.createElement(ink.Text, null, 'old-frame') : null;
    }

    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(ClearingComponent),
      80,
      { until: (frame) => frame === '' },
    );

    expect(effectRan).toBe(true);
    expect(output).toBe('');
  });
});
