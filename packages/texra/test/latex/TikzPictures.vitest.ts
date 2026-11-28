import { readFileSync } from 'node:fs';

import { it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { pathToLocationIn } from '@texra-ai/worldline/plugins';
import { compileTikzPictures, extractTikzPictures } from '@latex/tikzPictures';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { nodePlatformLayer, rootedFsLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';

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

  it.live('skips a commented-out figure', () =>
    Effect.gen(function* () {
      const result = yield* extractFromPaper(String.raw`
% \begin{figure}
%   \begin{tikzpicture}
%     \node {old};
%   \end{tikzpicture}
%   \label{fig:old}
% \end{figure}
`);

      expect(result).toEqual([]);
    }),
  );

  // TeX drops a comment together with the line break after it and the next
  // line's indentation, so the picture handed to the compiler must too.
  // Joining after a control word would rename it (`\beta` + `x`).
  it.live('joins the lines a comment ends as TeX does', () =>
    Effect.gen(function* () {
      const result = yield* extractFromPaper(String.raw`
\begin{figure}
  \begin{tikzpicture}
    \node {micro% joined to the next line
      scope};
    \draw (0,0) % a comment inside a path
      -- (1,1);
    \node {$\beta% a control word keeps its line end, which ends its name
      x$};
    \node {first};% a blank line after a comment still ends the paragraph

    \node {last};
  \end{tikzpicture}
  \label{fig:joined}
\end{figure}
`);

      expect(result).toEqual([
        [
          'fig:joined',
          [
            String.raw`\begin{tikzpicture}
    \node {microscope};
    \draw (0,0) -- (1,1);
    \node {$\beta
      x$};
    \node {first};

    \node {last};
  \end{tikzpicture}`,
          ],
        ],
      ]);
    }),
  );
});

describe('compileTikzPictures', () => {
  // The template is a project setting: its `{{ tikzpicture }}` is the one
  // placeholder, and the rest is LaTeX, where `{#1}` is a macro argument.
  it.live('writes the picture into a template whose preamble has macros', () =>
    Effect.gen(function* () {
      const template = String.raw`\documentclass{standalone}
\newcommand{\vect}[1]{\mathbf{#1}}
\begin{document}
{{ tikzpicture }}
\end{document}`;
      const picture = String.raw`\begin{tikzpicture}\node {$\vect{x}$ costs \$5};\end{tikzpicture}`;
      const context = yield* Layer.build(
        FakeHost.layer({
          app: TEXRA_APP,
          config: { 'latex.tikzTemplate': template },
          files: { '/workspace/paper.tex': '' },
        }),
      );
      const host = Context.get(context, FakeHost);
      const paper = pathToLocationIn(host.roots.workspace, 'paper.tex');
      yield* compileTikzPictures(paper, [['fig', [picture]]], host.roots).pipe(
        Effect.provide([
          rootedFsLayer(host.roots),
          scriptedSpawnerLayer(() => ({ exitCode: 0 })).layer,
        ]),
      );

      expect(
        readFileSync(
          host.path('workspace', 'build', 'paper', 'fig.tex'),
          'utf8',
        ),
      ).toBe(template.replace('{{ tikzpicture }}', () => picture));
    }),
  );
});
