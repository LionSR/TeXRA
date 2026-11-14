import { it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { pathToLocationIn } from '@texra-ai/harness/host';
import { extractTikzPictures } from '@latex/tikzPictures';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';

function extractFromPaper(content: string) {
  return Layer.build(
    FakeHost.layer({ files: { '/workspace/paper.tex': content } }),
  ).pipe(
    Effect.andThen((context) =>
      extractTikzPictures(
        pathToLocationIn(
          Context.get(context, FakeHost).path('workspace'),
          'paper.tex',
        ),
      ),
    ),
    Effect.provide(nodePlatformLayer),
  );
}

describe('extractTikzPictures', () => {
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
