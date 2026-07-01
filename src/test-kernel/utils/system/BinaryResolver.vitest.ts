// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - utils
import { BinaryResolverService } from '@utils/system/binaryResolver';

function createResolver(
  paths: Record<string, string | null>,
  isWindows = false,
): BinaryResolverService {
  return new BinaryResolverService({
    findTool: (toolName) => paths[toolName] ?? null,
    isWindows,
  });
}

describe('BinaryResolverService', () => {
  it('resolves nullable tool paths', () => {
    const resolver = createResolver({ latexmk: '/usr/bin/latexmk' });

    assert.equal(resolver.findPath('latexmk'), '/usr/bin/latexmk');
    assert.equal(resolver.findPath('missing'), null);
  });

  it('routes Perl scripts through the Perl launcher', () => {
    const resolver = createResolver({
      latexindent: '/usr/local/texlive/scripts/latexindent/latexindent.pl',
    });

    assert.deepEqual(resolver.resolveOptionalCommand('latexindent', ['-w']), {
      command: 'perl',
      args: ['/usr/local/texlive/scripts/latexindent/latexindent.pl', '-w'],
      resolvedPath: '/usr/local/texlive/scripts/latexindent/latexindent.pl',
    });
  });

  it.each([
    {
      tool: 'latexdiff',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff',
      args: ['a', 'b'],
    },
    {
      tool: 'latexmk',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexmk\\latexmk',
      args: ['-pdf'],
    },
    {
      tool: 'latexdiff-vc',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff-vc',
      args: ['--git'],
    },
  ])(
    'routes extensionless Windows $tool scripts through Perl',
    ({ tool, path, args }) => {
      const resolver = createResolver({ [tool]: path }, true);

      assert.deepEqual(resolver.resolveOptionalCommand(tool, args), {
        command: 'perl',
        args: [path, ...args],
        resolvedPath: path,
      });
    },
  );

  it('launches extensionless Windows binaries directly', () => {
    const resolver = createResolver({ sox: 'C:\\msys64\\usr\\bin\\sox' }, true);

    assert.deepEqual(resolver.resolveOptionalCommand('sox'), {
      command: 'C:\\msys64\\usr\\bin\\sox',
      args: [],
      resolvedPath: 'C:\\msys64\\usr\\bin\\sox',
    });
  });

  it('builds commands from an already-resolved path', () => {
    const resolver = createResolver({}, true);

    assert.deepEqual(
      resolver.resolveOptionalCommand('latexindent', ['-w'], {
        resolvedPath:
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
      }),
      {
        command: 'perl',
        args: [
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
          '-w',
        ],
        resolvedPath:
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
      },
    );
  });

  it('returns null when a command cannot be resolved', () => {
    const resolver = createResolver({});

    assert.deepEqual(resolver.resolveOptionalCommand('tex-fmt'), null);
  });
});
