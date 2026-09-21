#!/usr/bin/env node
// CI gate: a note under `.agents/docs/proposed/` must not declare itself done.
//
// `.agents/docs/` is organized by lifecycle, and the lifecycle is typed, not
// derived: a note sits in `proposed/` until someone moves it. Nothing enforced
// that, so on 2026-09-20 all 29 notes under `proposed/` said `proposed` while
// at least seven of them had shipped — the run ledger and the two Effect run
// programs are current architecture and CLAUDE.md describes them as such. An
// agent reading the tree cannot tell a live direction from an executed one,
// and a shipped design read as a proposal is a confidently wrong answer.
//
// The gate is keyed on an explicit completion marker the note writes about
// ITSELF, never on citations: a note may cite a merged PR as evidence or as a
// prerequisite and stay open, because a proposal can rest on landed work. Two
// markers fail:
//
//   1. Its status line names a settled lifecycle — "implemented", "landed",
//      "superseded", "rejected" and friends. The note belongs in the matching
//      directory.
//   2. It has a "Landed" section and no section that says anything is still
//      open. A landed section beside an open one is a progress record, which
//      is exactly what a live proposal keeps.
//
// Dependency-free (bare Node) so it runs without installing anything.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkFiles } from './walkFiles.mjs';

const repoRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const proposedRoot = join(repoRoot, '.agents', 'docs', 'proposed');

/** Status values that name a lifecycle other than `proposed/`. */
const SETTLED_STATUS = new Map([
  ['implemented', 'implemented'],
  ['complete', 'implemented'],
  ['completed', 'implemented'],
  ['landed', 'implemented'],
  ['shipped', 'implemented'],
  ['delivered', 'implemented'],
  ['executed', 'implemented'],
  ['done', 'implemented'],
  ['archived', 'archived'],
  ['superseded', 'archived'],
  ['obsolete', 'archived'],
  ['rejected', 'rejected'],
  ['declined', 'rejected'],
  ['withdrawn', 'rejected'],
]);

const LANDED_HEADING = /^#{1,6}\s+(?:what\s+)?landed\b/iu;
const OPEN_HEADING =
  /^#{1,6}\s+(?:\d+(?:\.\d+)*\.?\s+)?(?:open|remaining|outstanding|still|not\s+landed|next|todo|to\s+do|deferred|unresolved)\b/iu;

/**
 * The status line, as `.agents/docs/README.md` defines it: a frontmatter
 * `status:` key, or a `Status: <value>` line in the header block — the prose
 * between the first heading and the first section heading. Looking no further
 * keeps a sentence about some other note's status out of the gate.
 */
function statusValue(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) {
      for (const line of lines.slice(1, end)) {
        const match = /^status:\s*(.+)$/iu.exec(line.trim());
        if (match) return match[1];
      }
    }
  }
  let seenHeading = false;
  for (const line of lines) {
    if (/^#{2,6}\s/u.test(line)) break;
    if (/^#\s/u.test(line)) {
      seenHeading = true;
      continue;
    }
    if (!seenHeading) continue;
    const match = /^\**status:?\**:?\s*(.+)$/iu.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

/** The first word of a status value, which is what names the lifecycle. */
function statusWord(value) {
  const match = /^[*_`"']*([a-z-]+)/iu.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function headings(text) {
  let inFence = false;
  const found = [];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith('#')) found.push(line);
  }
  return found;
}

if (!existsSync(proposedRoot)) {
  console.error(`No proposals directory at ${proposedRoot}.`);
  process.exit(1);
}

const failures = [];

for (const entry of walkFiles(proposedRoot, {
  include: (relativePath) => relativePath.endsWith('.md'),
})) {
  const file = relative(repoRoot, entry.absolutePath).replaceAll('\\', '/');
  const text = readFileSync(entry.absolutePath, 'utf8');

  const value = statusValue(text);
  const word = value ? statusWord(value) : null;
  const lifecycle = word ? SETTLED_STATUS.get(word) : undefined;
  if (lifecycle) {
    failures.push({
      file,
      marker: `status line says "${word}"`,
      lifecycle,
    });
    continue;
  }

  const sections = headings(text);
  if (
    sections.some((heading) => LANDED_HEADING.test(heading)) &&
    !sections.some((heading) => OPEN_HEADING.test(heading))
  ) {
    failures.push({
      file,
      marker: 'a "Landed" section with nothing left open',
      lifecycle: 'implemented',
    });
  }
}

if (failures.length > 0) {
  console.error(
    'Notes under .agents/docs/proposed/ declare themselves done:\n',
  );
  for (const { file, marker, lifecycle } of failures) {
    const target = file.replace('/proposed/', `/${lifecycle}/`);
    console.error(`  ${file}\n    ${marker} → git mv it to ${target}`);
  }
  console.error(
    `\n${failures.length} note(s) in the wrong lifecycle directory. Move the note with`,
  );
  console.error(
    '`git mv`, add the archive marker if it lands in archived/, and update its row in',
  );
  console.error(
    '.agents/docs/INDEX.md. Citing a merged PR as evidence or as a prerequisite is not a',
  );
  console.error(
    'completion marker: keep a "Landed" section beside the section that says what is open.',
  );
  process.exit(1);
}
