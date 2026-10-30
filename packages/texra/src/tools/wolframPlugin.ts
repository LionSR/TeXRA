/** The Wolfram plugin: a probe and a card; agents run `wolframscript` in `bash`. */

// Local imports
import { WOLFRAM_AVAILABILITY } from '@texra/tools/pluginAvailability';
import type { TexraPlugin } from '@texra/tools/registry';

export const wolfram: TexraPlugin = {
  id: 'wolfram',
  availability: WOLFRAM_AVAILABILITY,
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
