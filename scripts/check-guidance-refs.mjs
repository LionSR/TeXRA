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
// Scope note: it checks that backticked repo paths and local Markdown link
// destinations resolve (the latter relative to their guidance file). It cannot
// check that the
// surrounding claim is still true — that still needs a human.
//
// Dependency-free (bare Node) so it runs without installing anything.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The optional root argument keeps fixture tests hermetic without duplicating
// the production path-prefix configuration.
const repoRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');

// Files whose prose is read as instructions by an agent or contributor.
const GUIDANCE_FILES = ['CLAUDE.md', 'AGENTS.md', 'src/README.md'];
// Standing docs: architecture notes and the published guide. Dated proposals
// and PRDs stay out — they are historical by design (see issue #9730).
const GUIDANCE_DIRS = [
  '.claude/skills',
  'docs/dev',
  'docs/architecture',
  'docs/guide',
];

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
  // Both are cited from CLAUDE.md/AGENTS.md and both are shipped surfaces:
  // skills/ is packaged into the client, prompts/agents/remote/ is the declared
  // public home for the hosted agent YAMLs. Without these prefixes a stale
  // citation to either tree rots silently.
  'skills/',
  'prompts/',
];

// Generated or installed at build time, so absent in a clean checkout.
const BUILD_OUTPUT = /(^|\/)(dist|out|releases|node_modules)(\/|$)/;

/**
 * Collect .md files under a directory, recursively.
 *
 * Keys stay POSIX-separated regardless of host OS: they are compared against
 * the forward-slash literals in ARCHIVAL_DIRS and printed in failure output.
 * Building them with `join()` would yield backslashes on Windows, silently
 * defeating the archival carve-out there while Linux CI stayed green. Only the
 * absolute path handed to the filesystem goes through `join()`, which accepts
 * forward slashes on every platform.
 */
function markdownFilesIn(dir) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const found = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
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

function localMarkdownDestination(rawDestination) {
  let destination = rawDestination.trim();
  if (destination.startsWith('<')) {
    const end = destination.indexOf('>');
    if (end === -1) return null;
    destination = destination.slice(1, end);
  } else {
    destination = destination.split(/\s+["'(]/u, 1)[0];
  }
  if (
    !destination ||
    destination.startsWith('#') ||
    destination.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(destination)
  ) {
    return null;
  }
  return destination;
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function closingBracket(line, start) {
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === ']' && !isEscaped(line, i)) return i;
  }
  return -1;
}

function closingParenthesis(line, start) {
  let depth = 0;
  for (let i = start; i < line.length; i += 1) {
    if (isEscaped(line, i)) continue;
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')' && depth > 0) depth -= 1;
    else if (line[i] === ')') return i;
  }
  return -1;
}

function referenceLabel(value) {
  return value.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

function referenceDefinitions(lines) {
  const definitions = new Map();
  for (const line of lines) {
    const match = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/u.exec(line.trimEnd());
    if (!match) continue;
    const destination = localMarkdownDestination(match[2]);
    if (destination) definitions.set(referenceLabel(match[1]), destination);
  }
  return definitions;
}

/** Collect complete inline, full, collapsed, and shortcut links and images. */
function relativeMarkdownLinks(line, definitions) {
  if (/^\s{0,3}\[[^\]]+\]:/u.test(line)) return [];

  const links = [];
  for (let open = line.indexOf('['); open !== -1;) {
    if (isEscaped(line, open)) {
      open = line.indexOf('[', open + 1);
      continue;
    }
    const close = closingBracket(line, open + 1);
    if (close === -1) break;

    const textLabel = line.slice(open + 1, close);
    let next = close + 1;
    let destination;
    if (line[next] === '(') {
      const end = closingParenthesis(line, next + 1);
      if (end !== -1) {
        destination = localMarkdownDestination(line.slice(next + 1, end));
        next = end + 1;
      }
    } else if (line[next] === '[') {
      const referenceEnd = closingBracket(line, next + 1);
      if (referenceEnd !== -1) {
        const explicitLabel = line.slice(next + 1, referenceEnd);
        destination = definitions.get(
          referenceLabel(explicitLabel || textLabel),
        );
        next = referenceEnd + 1;
      }
    } else {
      destination = definitions.get(referenceLabel(textLabel));
    }

    if (destination) links.push(destination);
    open = line.indexOf('[', Math.max(next, close + 1));
  }
  return links;
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
  const definitions = referenceDefinitions(lines);

  for (const [index, line] of lines.entries()) {
    if (ignored[index]) continue;

    for (const destination of relativeMarkdownLinks(line, definitions)) {
      const localDestination = destination.split(/[?#]/u, 1)[0];
      let decodedDestination;
      try {
        decodedDestination = decodeURIComponent(localDestination);
      } catch {
        decodedDestination = localDestination;
      }
      const absolute = resolve(repoRoot, dirname(file), decodedDestination);
      const withMarkdown =
        !decodedDestination.endsWith('.md') &&
        !existsSync(absolute) &&
        existsSync(`${absolute}.md`)
          ? `${absolute}.md`
          : absolute;
      const repoRelative = relative(repoRoot, withMarkdown).replaceAll(
        '\\',
        '/',
      );
      if (
        repoRelative === '..' ||
        repoRelative.startsWith('../') ||
        !existsSync(withMarkdown)
      ) {
        failures.push({
          file,
          line: index + 1,
          candidate: destination,
          missing: [repoRelative],
        });
      }
    }

    for (const [, token] of line.matchAll(/`([^`\n]+)`/g)) {
      // Trim trailing line cites (`:12`, `:73-80`, `:25-29,59-65`, `:18,27,28`),
      // then trailing sentence punctuation that fell inside the backticks.
      // Line numbers are not validated — only path existence (issue #9730).
      const candidate = token
        .trim()
        .replace(/:(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$/, '')
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

// `targets` are already repo-relative POSIX keys; re-deriving them against the
// process cwd would both depend on where the hook was invoked from and
// reintroduce backslashes on Windows.
console.log(
  `Guidance references OK — checked ${targets.length} file(s): ${targets.join(', ')}`,
);
