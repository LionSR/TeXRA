// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { pathToLocation } from '@utils/files';

function installPlatform(files: Record<string, string>) {
  return installFakePlatform({ workspacePath: '/workspace', files });
}

describe('TikzPictureManager', () => {
  it('extracts labeled TikZ pictures from starred figure environments', async () => {
    await installPlatform({
      '/workspace/paper.tex': String.raw`
\begin{figure*}[t]
  \centering
  \begin{tikzpicture}
    \node {wide};
  \end{tikzpicture}
  \caption{Wide figure}
  \label{fig:wide}
\end{figure*}
`,
    });

    const result = await TikzPictureManager.extract(
      pathToLocation('paper.tex'),
    );

    assert.deepStrictEqual(result, [
      [
        'fig:wide',
        [
          String.raw`\begin{tikzpicture}
    \node {wide};
  \end{tikzpicture}`,
        ],
      ],
    ]);
  });

  it('does not attribute an unlabeled figure to a later labeled figure', async () => {
    await installPlatform({
      '/workspace/paper.tex': String.raw`
\begin{figure}
  \begin{tikzpicture}
    \node {unlabeled};
  \end{tikzpicture}
\end{figure}

\begin{figure}
  \begin{tikzpicture}
    \node {labeled};
  \end{tikzpicture}
  \label{fig:labeled}
\end{figure}
`,
    });

    const result = await TikzPictureManager.extract(
      pathToLocation('paper.tex'),
    );

    assert.deepStrictEqual(result, [
      [
        'fig:labeled',
        [
          String.raw`\begin{tikzpicture}
    \node {labeled};
  \end{tikzpicture}`,
        ],
      ],
    ]);
  });
});
