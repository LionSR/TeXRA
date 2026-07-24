#!/usr/bin/env node
// CI gate: every repo path cited in agent-facing guidance must actually exist.
//
// Guidance files (CLAUDE.md, AGENTS.md, .claude/skills/**, docs/dev/**) tell an
// agent where things live. Nothing compiles them, so when code moves the prose
// silently rots — and a confidently wrong path costs more than a missing one,
// because the reader trusts it. The 2026-07 context-engineering pass found six
// such references pointing at files and symbols that no longer existed
// (`src/common/webview/`, `src/shared/ipc/commonCommands.ts`,
// `src/logger/index.ts`, ...), plus a checklist rule banning a command the same
// docs instructed running. This gate turns that class of drift into a failed
// commit instead of a wrong answer months later.
//
// Scope note: it checks that cited *paths* resolve. It cannot check that the
// surrounding claim is still true — that still needs a human.
//
// Dependency-free (bare Node) so it runs without installing anything.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files whose prose is read as instructions by an agent or contributor.
const GUIDANCE_FILES = ['CLAUDE.md', 'AGENTS.md'];
const GUIDANCE_DIRS = ['.claude/skills', 'docs/dev'];

// Dated point-in-time records, not standing instructions. They describe the
// tree as it was and are expected to cite paths that have since moved; the same
// carve-out `docs/scripts/check-root-docs.mjs` makes for its timestamped dirs.
const ARCHIVAL_DIRS = ['docs/dev/audits'];

// Escape hatch for prose that names a path precisely because it is gone —
// e.g. CLAUDE.md's "`src/common/webview/` does not exist". Put
// `<!-- guidance-refs-ignore -->` anywhere in the paragraph. It scopes to the
// whole block (contiguous non-blank lines), not one line, because Prettier
// reflows this prose and would otherwise strand the marker.
const IGNORE_MARKER = '<!-- guidance-refs-ignore -->';

/** Map each line index to whether its containing block carries the marker. */
function ignoredLines(lines) {
  const ignored = new Array(lines.length).fill(false);
  let blockStart = 0;
  const closeBlock = (end) => {
    if (
      lines.slice(blockStart, end).some((line) => line.includes(IGNORE_MARKER))
    ) {
      for (let i = blockStart; i < end; i += 1) ignored[i] = true;
    }
  };
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      closeBlock(index);
      blockStart = index + 1;
    }
  }
  closeBlock(lines.length);
  return ignored;
}

// A backticked token is treated as a repo path when it starts with one of
// these. Anything else (bare prose, npm scripts, symbol names) is ignored.
const PATH_PREFIXES = [
  'src/',
  'packages/',
  'docs/',
  'config/',
  'patches/',
  'scripts/',
  'supabase/',
  '.github/',
  '.claude/',
];

// Generated or installed at build time, so absent in a clean checkout.
const BUILD_OUTPUT = /(^|\/)(dist|out|releases|node_modules)(\/|$)/;

/** Collect .md files under a directory, recursively. */
function markdownFilesIn(dir) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const found = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ARCHIVAL_DIRS.includes(rel)) continue;
      found.push(...markdownFilesIn(rel));
    } else if (entry.name.endsWith('.md')) found.push(rel);
  }
  return found;
}

/** Strip fenced code blocks — those are examples, not live references. */
function stripFencedBlocks(text) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** Expand a single level of `{a,b}` alternation, as used in doc paths. */
function expandBraces(path) {
  const match = /\{([^{}]+)\}/.exec(path);
  if (!match) return [path];
  return match[1]
    .split(',')
    .flatMap((option) =>
      expandBraces(
        path.slice(0, match.index) +
          option.trim() +
          path.slice(match.index + match[0].length),
      ),
    );
}

/** Resolve a path that may contain a single `*` segment; true if anything matches. */
function resolvesWithGlob(path) {
  const trimmed = path.replace(/\/$/, '');
  if (!trimmed.includes('*')) return existsSync(join(repoRoot, trimmed));

  const segments = trimmed.split('/');
  let candidates = [''];
  for (const segment of segments) {
    const next = [];
    for (const base of candidates) {
      const baseAbs = join(repoRoot, base);
      if (!existsSync(baseAbs)) continue;
      if (!segment.includes('*')) {
        next.push(base ? `${base}/${segment}` : segment);
        continue;
      }
      const pattern = new RegExp(
        `^${segment.split('*').map(escapeRegex).join('.*')}$`,
      );
      let entries;
      try {
        entries = readdirSync(baseAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (pattern.test(entry.name))
          next.push(base ? `${base}/${entry.name}` : entry.name);
      }
    }
    candidates = next;
    if (candidates.length === 0) return false;
  }
  return candidates.some((candidate) => existsSync(join(repoRoot, candidate)));
}

function escapeRegex(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const targets = [
  ...GUIDANCE_FILES.filter((file) => existsSync(join(repoRoot, file))),
  ...GUIDANCE_DIRS.flatMap((dir) => markdownFilesIn(dir)),
];

const failures = [];

for (const file of targets) {
  const body = stripFencedBlocks(readFileSync(join(repoRoot, file), 'utf8'));
  const lines = body.split('\n');
  const ignored = ignoredLines(lines);

  for (const [index, line] of lines.entries()) {
    if (ignored[index]) continue;

    for (const [, token] of line.matchAll(/`([^`\n]+)`/g)) {
      // Trim a trailing `:12` line cite, then trailing sentence punctuation
      // that fell inside the backticks.
      const candidate = token
        .trim()
        .replace(/:\d+$/, '')
        .replace(/[.,;:)]+$/, '');
      if (!PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix)))
        continue;
      // Must look like a path or directory, not prose that happens to have a slash.
      if (/\s/.test(candidate)) continue;
      // `<provider>` / `<view>` are placeholders the reader substitutes.
      if (candidate.includes('<') || candidate.includes('>')) continue;
      if (BUILD_OUTPUT.test(candidate)) continue;

      const expansions = expandBraces(candidate);
      const missing = expansions.filter((path) => !resolvesWithGlob(path));
      if (missing.length > 0) {
        failures.push({ file, line: index + 1, candidate, missing });
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Guidance references point at paths that do not exist:\n');
  for (const { file, line, candidate, missing } of failures) {
    const detail =
      missing.length === 1 && missing[0] === candidate
        ? ''
        : ` → ${missing.join(', ')}`;
    console.error(`  ${file}:${line}  ${candidate}${detail}`);
  }
  console.error(
    `\n${failures.length} stale reference(s). Update the path, or delete the claim if the thing is gone.`,
  );
  console.error(
    'Build outputs and fenced code examples are already exempt; if a path is legitimately absent',
  );
  console.error(
    'from a clean checkout, widen BUILD_OUTPUT in scripts/check-guidance-refs.mjs.',
  );
  process.exit(1);
}

console.log(
  `Guidance references OK — checked ${targets.length} file(s): ${targets.map((t) => relative('.', t)).join(', ')}`,
);
