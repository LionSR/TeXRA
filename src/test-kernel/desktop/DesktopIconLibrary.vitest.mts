// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - shared icon contract
import {
  CODICON_ALIASES,
  TEXRA_ICON_LIBRARY,
} from '@shared/wa/webAwesomeIcons';

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

/**
 * The TeXRA names that carry an explicit Lucide rename, read from the source
 * table. Read rather than exported: the table is module-private data with one
 * consumer (its own resolver), and exporting it only for a test would make a
 * contract out of an implementation detail.
 */
function readRenamedIconNames(): readonly string[] {
  const source = readFileSync(
    desktopSourcePath('renderer', 'desktopIconLibrary.ts'),
    'utf8',
  );
  const table = source.slice(
    source.indexOf('const LUCIDE_NAME_BY_TEXRA_NAME'),
    source.indexOf('const LUCIDE_ICON_NODES'),
  );
  return [...table.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'[a-z0-9-]+',/gm)].map(
    (match) => match[1]!,
  );
}

describe('desktop icon library', () => {
  it('renders mapped icons with the Lucide stroke treatment', async () => {
    const svg = decodeSvg(await resolve(texraResolver, 'file-lines'));

    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('fill="none"');
  });

  it('maps former icon-family gaps to Lucide glyphs', async () => {
    const svg = decodeSvg(await resolve(texraResolver, 'thumbtack-slash'));

    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).not.toContain('<path fill="currentColor"');
  });

  it('keeps aliases and unknown runtime names visible in both libraries', async () => {
    const aliasSvg = decodeSvg(await resolve(texraResolver, 'send'));
    const unknownSvg = decodeSvg(
      await resolve(defaultResolver, 'unexpected-runtime-icon'),
    );

    expect(aliasSvg).toContain('stroke-width="1.75"');
    expect(aliasSvg).not.toContain('<path fill="currentColor"');
    expect(unknownSvg).toContain('stroke-width="1.75"');
  });

  it('maps every renamed icon to a Lucide name the pinned release actually has', async () => {
    // A mapping whose target Lucide dropped or renamed would silently become
    // the unknown-icon marker. Walking the map catches that drift at build time.
    const unresolved: string[] = [];
    const renamedIconNames = readRenamedIconNames();
    const missingSvg = decodeSvg(
      await resolve(texraResolver, 'unexpected-runtime-icon'),
    );

    for (const name of renamedIconNames) {
      const svg = decodeSvg(await resolve(texraResolver, name));
      if (svg === missingSvg && name !== 'circle-question') {
        unresolved.push(name);
      }
    }

    expect(unresolved).toEqual([]);
    // Guards the parse itself: an empty list would make the loop above vacuous.
    expect(renamedIconNames.length).toBeGreaterThan(50);
  });

  it('resolves every codicon alias through to a stroke glyph', async () => {
    // Aliases take an extra hop (alias -> canonical -> Lucide). Skipping that
    // hop previously blanked 22 icons, so the whole table is walked.
    const unresolved: string[] = [];
    const missingSvg = decodeSvg(
      await resolve(texraResolver, 'unexpected-runtime-icon'),
    );

    for (const alias of Object.keys(CODICON_ALIASES)) {
      const svg = decodeSvg(await resolve(texraResolver, alias));
      if (svg === missingSvg && alias !== 'question') unresolved.push(alias);
    }

    expect(unresolved).toEqual([]);
  });
});
