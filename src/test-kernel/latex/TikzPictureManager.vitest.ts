import { describe, expect, it } from 'vitest';

import { TikzPictureManager } from '@latex/TikzPictureManager';
import { installPlatform } from '@test/support/setupPlatform';
import { pathToLocation } from '@utils/files/fileLocation';

async function extractFromPaper(content: string) {
  await installPlatform({
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

    expect(result).toEqual([
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

    expect(result).toEqual([
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
