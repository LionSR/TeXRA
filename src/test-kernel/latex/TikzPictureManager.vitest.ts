// Third-party imports
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - tests
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - latex
import { tikzPictureManager } from '@latex/TikzPictureManager';

// Local imports - utils
import { pathToLocation } from '@utils/files';

async function installPlatform(files: Record<string, string>) {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform({ workspacePath: '/workspace', files }));
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

    const result = await tikzPictureManager.extract(
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

    const result = await tikzPictureManager.extract(
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
