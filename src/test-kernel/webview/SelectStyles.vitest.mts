// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readSelectStyles(): string {
  return readFileSync(resolve(REPO_ROOT, 'src/shared/styles/selectStyles.ts'), {
    encoding: 'utf8',
  });
}

describe('shared select styles', () => {
  it('keeps Web Awesome select menus at IDE density', () => {
    const source = readSelectStyles();
    const listboxStart = source.indexOf('wa-select::part(listbox)');
    const optionStart = source.indexOf('wa-select wa-option::part(base)');
    const inputStart = source.indexOf('wa-input {');
    const menuRules = source.slice(listboxStart, inputStart);

    expect(listboxStart).toBeGreaterThanOrEqual(0);
    expect(optionStart).toBeGreaterThan(listboxStart);
    expect(inputStart).toBeGreaterThan(optionStart);
    expect(menuRules).toContain('padding-block: var(--wa-space-3xs)');
    expect(menuRules).toContain('min-height: 22px');
    expect(menuRules).toContain('padding: 2px 8px 2px 4px');
  });
});
