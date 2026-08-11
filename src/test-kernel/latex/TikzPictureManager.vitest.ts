// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { pathToLocation } from '@utils/files/fileLocation';

async function extractFromPaper(content: string) {
  await installFakePlatform({
    workspacePath: '/workspace',
    files: { '/workspace/paper.tex': content },
  });
  return TikzPictureManager.extract(pathToLocation('paper.tex'));
}

describe('TikzPictureManager', () => {
  it('extracts labeled TikZ pictures from starred figure environments', async () => {
    const result = await extractFromPaper(String.raw`
\begin{figure*}[t]
  \centering
  \begin{tikzpicture}
    \node {wide};
  \end{tikzpicture}
  \caption{Wide figure}
  \label{fig:wide}
\end{figure*}
`);

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
    const result = await extractFromPaper(String.raw`
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
`);

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
