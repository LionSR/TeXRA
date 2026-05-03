// Standard library imports
import { strict as assert } from 'assert';

// Local imports - utils
import { BinaryResolverService } from '../../../utils/system/binaryResolver';

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

  it('routes extensionless Windows TeX scripts through Perl', () => {
    const resolver = createResolver(
      { latexdiff: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff' },
      true,
    );

    assert.deepEqual(resolver.resolveOptionalCommand('latexdiff', ['a', 'b']), {
      command: 'perl',
      args: [
        'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff',
        'a',
        'b',
      ],
      resolvedPath: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff',
    });
  });

  it('routes extensionless Windows latexmk scripts through Perl', () => {
    const resolver = createResolver(
      { latexmk: 'C:\\texlive\\texmf-dist\\scripts\\latexmk\\latexmk' },
      true,
    );

    assert.deepEqual(resolver.resolveOptionalCommand('latexmk', ['-pdf']), {
      command: 'perl',
      args: ['C:\\texlive\\texmf-dist\\scripts\\latexmk\\latexmk', '-pdf'],
      resolvedPath: 'C:\\texlive\\texmf-dist\\scripts\\latexmk\\latexmk',
    });
  });

  it('routes extensionless Windows latexdiff-vc scripts through Perl', () => {
    const resolver = createResolver(
      {
        'latexdiff-vc':
          'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff-vc',
      },
      true,
    );

    assert.deepEqual(
      resolver.resolveOptionalCommand('latexdiff-vc', ['--git']),
      {
        command: 'perl',
        args: [
          'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff-vc',
          '--git',
        ],
        resolvedPath:
          'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff-vc',
      },
    );
  });

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
