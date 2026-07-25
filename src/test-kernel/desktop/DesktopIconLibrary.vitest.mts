// Third-party imports
import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - shared icon contract
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type IconResolver = NonNullable<ReturnType<typeof getIconLibrary>>['resolver'];

let texraResolver: IconResolver;
let defaultResolver: IconResolver;

beforeAll(async () => {
  await import(
    moduleFileUrl(desktopSourcePath('renderer', 'desktopIconLibrary.ts'))
  );
  const texraLibrary = getIconLibrary(TEXRA_ICON_LIBRARY);
  const defaultLibrary = getIconLibrary('default');
  if (!texraLibrary || !defaultLibrary) {
    throw new Error('Desktop icon libraries were not registered.');
  }
  texraResolver = texraLibrary.resolver;
  defaultResolver = defaultLibrary.resolver;
});

async function resolve(resolver: IconResolver, name: string): Promise<string> {
  return resolver(name, 'classic', 'solid', false);
}

function decodeSvg(uri: string): string {
  expect(uri).toMatch(/^data:image\/svg\+xml,/);
  return decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
}

describe('desktop icon library', () => {
  it('renders mapped icons with the Lucide stroke treatment', async () => {
    const svg = decodeSvg(await resolve(texraResolver, 'file-lines'));

    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('fill="none"');
  });

  it('falls back to the offline Font Awesome glyph for Lucide gaps', async () => {
    // lucide-static has no `thumbtack-slash`, while the shared TeXRA library
    // intentionally supports it. Re-registering the desktop resolver used to
    // discard that fallback and return an empty string.
    const svg = decodeSvg(await resolve(texraResolver, 'thumbtack-slash'));

    expect(svg).toContain('<path fill="currentColor"');
  });

  it('keeps aliases and unknown runtime names visible in both libraries', async () => {
    const aliasSvg = decodeSvg(await resolve(texraResolver, 'send'));
    const unknownSvg = decodeSvg(
      await resolve(defaultResolver, 'unexpected-runtime-icon'),
    );

    expect(aliasSvg).toContain('<path fill="currentColor"');
    expect(unknownSvg).toContain('stroke-width="1.75"');
  });
});
