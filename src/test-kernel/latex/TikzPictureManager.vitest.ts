import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { pathToLocationIn } from '@texra-ai/harness/host';
import { TikzPictureManager } from '@latex/TikzPictureManager';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';

function extractFromPaper(content: string) {
  return Layer.build(
    FakeHost.layer({
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
