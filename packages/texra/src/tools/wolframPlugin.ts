/** The Wolfram plugin: a probe and a card; agents run `wolframscript` in `bash`. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { TexraPlugin } from '@texra/tools/registry';
import { texraPlugin } from '@texra/tools/texraPlugin';
import { probeCommand } from '@texra/utils/system/toolChecks';

export const wolfram: TexraPlugin = texraPlugin({
  id: 'wolfram',
  prompt: ({ offered }) =>
    offered.includes('bash')
      ? "Run Wolfram Language through bash with `wolframscript -code '...'` or `wolframscript -file script.wl`; each run is a fresh session, so write a .wl script for iterative work. Check a symbolic result by substituting test values or taking limiting cases, and convert a final result with TeXForm before putting it in a document."
      : '',
  // Interruption reaches the spawned `wolframscript -version`, so an
  // interrupted dashboard refresh kills the probe instead of abandoning it.
  availability: {
    check: () =>
      Effect.map(probeCommand('wolframscript', ['-version']), (available) => ({
        available,
      })),
  },
  dashboard: {
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
});
