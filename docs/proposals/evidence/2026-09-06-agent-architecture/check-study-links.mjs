import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Verify local citations and pinned GitHub source paths against the actual clones.
// This is a document link check, not semantic validation of the cited claims.
const [repo, researchRoot] = process.argv.slice(2);
if (!repo || !researchRoot) {
  throw new Error('Usage: node check-study-links.mjs STUDY_REPO RESEARCH_ROOT');
}
const evidence = path.join(
  repo,
  'docs/proposals/evidence/2026-09-06-agent-architecture',
);
const manifest = JSON.parse(
  readFileSync(path.join(evidence, 'source-pins.json'), 'utf8'),
);
const clones = new Map(
  manifest.references.map((item) => [item.repository, item]),
);
for (const item of clones.values()) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(researchRoot, item.cloneDirectory),
    encoding: 'utf8',
  }).trim();
  assert.equal(actual, item.commit, item.repository);
}
const docs = [
  'docs/proposals/2026-09-06-agent-architecture-study.md',
  'docs/proposals/2026-09-06-agent-architecture-review.md',
  'docs/proposals/2026-09-06-agent-loop-architecture-study.md',
  'docs/proposals/2026-09-06-llm-package-architecture-study.md',
  'docs/proposals/2026-09-06-agent-architecture.html',
  'docs/proposals/evidence/2026-09-06-agent-architecture/README.md',
];
let localLinks = 0;
let pinnedSourceLinks = 0;
for (const file of docs) {
  const absolute = path.join(repo, file);
  const contents = readFileSync(absolute, 'utf8');
  for (const match of contents.matchAll(
    /\[[^\]]*\]\(([^)]+)\)|^\[[^\]]+\]:\s+(\S+)|href="([^"]+)"/gm,
  )) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target.startsWith('#')) continue;
    if (!target.startsWith('http')) {
      assert.ok(
        existsSync(path.resolve(path.dirname(absolute), target.split('#')[0])),
        `${file}: ${target}`,
      );
      localLinks += 1;
      continue;
    }
    const pinned = target.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([a-f0-9]{40})\/(.+?)(?:#.*)?$/u,
    );
    if (!pinned) continue;
    const [, repository, commit, sourcePath] = pinned;
    const item = clones.get(repository);
    assert.ok(item, `Unknown source repository: ${repository}`);
    assert.equal(commit, item.commit, target);
    assert.ok(
      existsSync(path.join(researchRoot, item.cloneDirectory, sourcePath)),
      target,
    );
    pinnedSourceLinks += 1;
  }
}
process.stdout.write(
  `${JSON.stringify({ documents: docs.length, localLinks, pinnedSourceLinks, clonesVerified: clones.size }, null, 2)}\n`,
);
