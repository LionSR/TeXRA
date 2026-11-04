/** The Wolfram plugin: a probe and a card; agents run `wolframscript` in `bash`. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { TexraPlugin } from '@texra/tools/registry';
import { probeCommand } from '@texra/utils/system/toolChecks';

export const wolfram: TexraPlugin = {
  id: 'wolfram',
  // Interruption reaches the spawned `wolframscript -version`, so an
  // interrupted dashboard refresh kills the probe instead of abandoning it.
  availability: {
    check: () =>
      Effect.map(probeCommand('wolframscript', ['-version']), (available) => ({
        available,
      })),
  },
  card: {
    name: 'Wolfram Language',
    description:
      'Wolfram Language through wolframscript, which agents run from the shell for symbolic math, computation, and data analysis.',
    setup: {
      installGuide:
        'Requires the "wolframscript" command-line tool.\n\n' +
        'Install the free Wolfram Engine:\n' +
        '  Mac:     brew install --cask wolfram-engine\n' +
        '  Ubuntu:  Download from wolfram.com/engine\n' +
        '  Windows: Download from wolfram.com/engine\n\n' +
        'Note: A Mathematica installation alone is not enough: you\n' +
        'need WolframScript on your PATH. The Wolfram Engine includes\n' +
        'it automatically. Free licenses are available for development use.',
      installUrl: 'https://www.wolfram.com/engine/',
      configNotes: 'Requires the free Wolfram Engine (provides wolframscript).',
    },
  },
};
