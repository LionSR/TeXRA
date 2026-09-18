import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { TikzPictureManager } from '@latex/TikzPictureManager';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { pathToLocationIn } from '@utils/files/fileLocation';

function extractFromPaper(content: string) {
  return Effect.promise(() =>
    installPlatform({
      workspacePath: fakePath('workspace'),
      files: { '/workspace/paper.tex': content },
    }),
  ).pipe(
    Effect.andThen(() =>
      TikzPictureManager.extract(
        pathToLocationIn(fakePath('workspace'), 'paper.tex'),
      ),
    ),
    Effect.provide(nodePlatformLayer),
  );
}

describe('TikzPictureManager', () => {
  it.live(
    'extracts labeled TikZ pictures from starred figure environments',
    () =>
      Effect.gen(function* () {
        const result = yield* extractFromPaper(String.raw`
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
      }),
  );

  it.live(
    'does not attribute an unlabeled figure to a later labeled figure',
    () =>
      Effect.gen(function* () {
        const result = yield* extractFromPaper(String.raw`
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
      }),
  );
});
