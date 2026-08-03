export const meta = {
  name: 'tech-debt-tournament',
  description:
    'Recurring tech-debt tournament: seam mappers over a ROTATING slice of areas, architect lenses propose deletions, dedupe against known issues + do-not-do ledger, adversarial net-gain verification, output capped to a few issues per cycle.',
  whenToUse:
    'Claude Code Workflow script invoked by the tech-debt-tournament skill (scheduled campaign); this is not a TeXRA delegate_multi_agents. Args: { campaignDate, cursor?, rotationSize?, knownIssues?, doNotDo?, areas?, maxFile? }. Deliberately scoped small per run (a handful of areas, a few issues filed) — breadth comes from repeated cycles rotating through areas, not from one large sweep.',
  phases: [
    { title: 'Map', detail: 'one read-only seam mapper per rotated area' },
    { title: 'Propose', detail: 'four architect lenses over all maps' },
    { title: 'Dedupe', detail: 'merge + drop known issues and adjudicated do-not-dos' },
    { title: 'Verify', detail: 'three adversarial refuters per candidate; majority refute kills' },
  ],
}

const input = args && typeof args === 'object' ? args : {}

function readInteger(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const value = input[name]
  if (value == null) return fallback
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  ) {
    throw new Error(`${name} must be a number or numeric string`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${String(value)}`)
  }
  return parsed
}

function readStringArray(name, fallback = []) {
  const value = input[name]
  if (value == null) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value
}

function requireStageResults(results, stage) {
  const missingIndex = results.findIndex((result) => !result)
  if (missingIndex !== -1) {
    throw new Error(`${stage} agent ${missingIndex + 1}/${results.length} returned no result; aborting the cycle`)
  }
  return results
}

// The driver passes campaignDate because Date is unavailable inside workflow scripts.
const campaignDate = typeof input.campaignDate === 'string' && input.campaignDate.trim()
  ? input.campaignDate
  : 'unknown-date'
const knownIssues = readStringArray('knownIssues') // ["#8746 refactor(logger): ...", ...]
const doNotDo = readStringArray('doNotDo') // adjudicated NET_LOSS / held-back ledger entries
// One cap owns both verification fan-out and issue filing. With the default, a cycle
// launches at most 3 mappers + 4 lenses + 1 deduper + 9 refuters = 17 agents.
const MAX_FILE = readInteger('maxFile', 3, 1, 8)

const ALL_AREAS = [
  { name: 'agent-runtime', paths: ['src/agent/runtime/', 'src/agent/core/'] },
  { name: 'model-handlers', paths: ['src/agent/modelHandlers/', 'src/model/'] },
  { name: 'flows-tools', paths: ['src/agent/implementations/', 'src/tools/'] },
  { name: 'platform-infra', paths: ['src/platform/', 'src/logger/', 'src/eventBus/', 'src/utils/'] },
  { name: 'storage-transcript', paths: ['src/agent/storage/', 'src/agent/trace/', 'src/transcript/'] },
  { name: 'controllers-shared', paths: ['src/controllers/', 'src/shared/', 'src/hosts/'] },
  {
    name: 'extension-host',
    paths: [
      'packages/extension/src/commands/',
      'packages/extension/src/commands.ts',
      'packages/extension/src/extension.ts',
    ],
  },
  { name: 'webviews', paths: ['packages/extension/src/webview/', 'packages/extension/src/progressView/', 'packages/extension/src/settingsView/'] },
  { name: 'cli', paths: ['packages/cli/src/'] },
  { name: 'desktop', paths: ['packages/desktop/src/'] },
]

// Rotate a small slice of areas per cycle instead of sweeping the whole repo every run.
// The driving skill persists `cursor` (a GitHub ledger issue) and advances it by
// rotationSize each cycle, so full coverage happens over several cycles, not one.
function rotateAreas(all, cursor, size) {
  const start = ((cursor % all.length) + all.length) % all.length
  const picked = []
  for (let i = 0; i < Math.min(size, all.length); i++) picked.push(all[(start + i) % all.length])
  return picked
}

const areaByName = new Map(ALL_AREAS.map((area) => [area.name, area]))
const areaNames = readStringArray(
  'areas',
  ALL_AREAS.map((area) => area.name),
)
if (new Set(areaNames).size !== areaNames.length) {
  throw new Error('areas must not contain duplicate names')
}
const orderedAreas = areaNames.map((name) => {
  const area = areaByName.get(name)
  if (!area) throw new Error(`Unknown tournament area: ${name}`)
  return area
})
if (!orderedAreas.length) throw new Error('areas must contain at least one configured area')

const rotationSize = readInteger('rotationSize', 3, 1, orderedAreas.length)
const cursor = readInteger('cursor', 0, 0)
const areas = rotateAreas(orderedAreas, cursor, rotationSize)

const SEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    seams: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: [
              'pass-through',
              'dead-or-vestigial',
              'ritual',
              'duplicated-pipeline',
              'legacy-arm',
              'single-caller-helper',
              'coupling-violation',
              'config-never-set',
              'other',
            ],
          },
          what: { type: 'string', description: 'one sentence: the seam and why it smells' },
          evidence: { type: 'string', description: 'file:line citations plus the grep/git command that proves it' },
          estLoc: { type: 'number', description: 'estimated LoC removable (positive number)' },
        },
        required: ['kind', 'what', 'evidence', 'estLoc'],
      },
    },
    healthy: { type: 'string', description: 'what you checked that is clean, so lenses do not waste time there' },
  },
  required: ['area', 'seams', 'healthy'],
}

function mapperPrompt(area) {
  return [
    `READ-ONLY seam-mapping task on the TeXRA repo (tech-debt tournament ${campaignDate}). DO NOT EDIT ANY FILE; run no state-changing commands.`,
    ``,
    `Map tech-debt seams in the "${area.name}" area: ${area.paths.join(', ')}`,
    ``,
    `Hunt for, with hard evidence (file:line, caller counts via ripgrep, LoC via wc/awk):`,
    `- pass-throughs and one-call factories (the repo's abstraction-cost guardrails in CLAUDE.md/AGENTS.md)`,
    `- dead or vestigial code: exports with zero callers, config knobs never set, feature arms never taken`,
    `- rituals: call sites that all invoke something whose body is a no-op or already-lazy (e.g. the deleted logger.initialize ritual, #8746)`,
    `- duplicated pipelines: the same concept implemented N times where one implementation could serve`,
    `- legacy arms: dual-write/dual-read paths, migration leftovers, deprecated formats still branched on`,
    `- coupling violations: vscode imports or host leakage inside VS Code-free zones (see CLAUDE.md list)`,
    ``,
    `Rules: max 15 seams, quality over quantity, each needs verifiable evidence you actually collected (run the greps; do not estimate from memory). Prefer deletion-shaped findings — the campaign currency is negative LoC and removed named elements. Note explicitly what you checked and found healthy.`,
  ].join('\n')
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'issue-style title: refactor(scope): <what ceases to exist> (~-N LoC)' },
          spec: { type: 'string', description: 'the full work spec: what ceases to exist (exact symbols/files), why zero or acceptable observable change, sequencing constraints' },
          estLoc: { type: 'number', description: 'estimated net LoC removed (positive number)' },
          estElements: { type: 'number', description: 'estimated named elements removed' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          files: { type: 'array', items: { type: 'string' } },
          area: { type: 'string' },
        },
        required: ['title', 'spec', 'estLoc', 'estElements', 'risk', 'files', 'area'],
      },
    },
  },
  required: ['lens', 'candidates'],
}

const LENSES = [
  {
    key: 'deletion-first',
    brief:
      'What can simply cease to exist? Favor candidates where the fix is deletion plus mechanical call-site cleanup, no replacement machinery. Reject anything whose "fix" adds a new abstraction.',
  },
  {
    key: 'abstraction-cost',
    brief:
      'Apply the repo abstraction-cost guardrails: single-caller extractions, identity factories, pass-through layers, ports/facades that never earned a second implementation. Each candidate must name the caller-count grep that proves it.',
  },
  {
    key: 'duplication',
    brief:
      'Same concept implemented N times (pipelines, encodings, vocabularies, state shapes). Only propose unification when one existing implementation can absorb the others with net-negative LoC — never a new third implementation.',
  },
  {
    key: 'legacy-retirement',
    brief:
      'Dual-write/dual-read arms, migration leftovers, deprecated formats, decision reversals whose losing branch still ships. Candidates must state the compatibility story (persisted data, resume paths, headless parity).',
  },
]

function lensPrompt(lens, mapsJson) {
  return [
    `READ-ONLY architect task on the TeXRA repo (tech-debt tournament ${campaignDate}). DO NOT EDIT ANY FILE.`,
    ``,
    `Lens: ${lens.key}. ${lens.brief}`,
    ``,
    `Below are seam maps produced by per-area mappers this run. Turn the strongest seams matching your lens into concrete, issue-ready deletion/refactor candidates. Re-verify every citation in the actual source before including it — mappers can be wrong, and a candidate with unverified evidence is worthless. You may also add candidates the mappers missed, if you verify them yourself.`,
    ``,
    `Seam maps:`,
    mapsJson,
    ``,
    `Bar for inclusion: net LoC strictly negative after accounting for replacement code; behavior-preserving (or the behavior change is spelled out and trivially acceptable); spec concrete enough that an implementer needs no further discovery. Max 8 candidates; fewer strong ones beat many weak ones. Zero candidates is a valid answer.`,
  ].join('\n')
}

const DEDUPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kept: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          spec: { type: 'string' },
          estLoc: { type: 'number' },
          estElements: { type: 'number' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          files: { type: 'array', items: { type: 'string' } },
          area: { type: 'string' },
        },
        required: ['title', 'spec', 'estLoc', 'estElements', 'risk', 'files', 'area'],
      },
    },
    droppedAsKnown: { type: 'array', items: { type: 'string' }, description: 'candidate title -> which known issue it duplicates' },
    droppedAsDoNotDo: { type: 'array', items: { type: 'string' }, description: 'candidate title -> which ledger entry bans it' },
    merged: { type: 'array', items: { type: 'string' }, description: 'notes on candidates merged into one' },
  },
  required: ['kept', 'droppedAsKnown', 'droppedAsDoNotDo', 'merged'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
    corrections: {
      type: 'string',
      description: 'mandatory scope or estimate correction; any non-empty value makes the candidate contested and not fileable. Empty string if none.',
    },
  },
  required: ['refuted', 'confidence', 'reason', 'corrections'],
}

const REFUTER_LENSES = [
  {
    key: 'net-loc',
    brief:
      'Attack the accounting. Recount callers with your own greps, price the replacement code honestly, include test churn. Refute if net LoC is not clearly negative or the element count is inflated.',
  },
  {
    key: 'behavior-risk',
    brief:
      'Attack behavior preservation. Hunt for observable changes: persisted formats, resume/compatibilityKey paths, headless parity (texra run / --print byte-identical), webview contracts, error surfaces. Refute if any unaccounted observable change exists.',
  },
  {
    key: 'load-bearing-precedent',
    brief:
      'Attack the premise. Is the indirection a contract (Platform port, PocketFlow hook, test seam)? Was this tried and reverted (search git log), or adjudicated in docs/proposals or the do-not-do ledger? Refute if the seam is load-bearing or previously rejected.',
  },
]

function refuterPrompt(candidate, lens) {
  return [
    `READ-ONLY adversarial verification on the TeXRA repo. DO NOT EDIT ANY FILE. Your job is to REFUTE this tech-debt candidate; it only ships if it survives you. Default to refuted=true when uncertain.`,
    ``,
    `Refutation lens: ${lens.key}. ${lens.brief}`,
    ``,
    `Candidate: ${candidate.title}`,
    `Claimed: ~-${candidate.estLoc} LoC, -${candidate.estElements} elements, risk ${candidate.risk}`,
    `Files: ${candidate.files.join(', ')}`,
    `Spec:`,
    candidate.spec,
    ``,
    `Verify every claim against the actual source at HEAD. If the candidate survives but you found the spec's numbers or scope wrong, put the mandatory fixes in "corrections".`,
  ].join('\n')
}

// ---- Phase 1: Map ----------------------------------------------------------
phase('Map')
log(
  `Tournament ${campaignDate}: mapping ${areas.length} rotated area(s) [${areas.map((a) => a.name).join(', ')}] (cursor=${cursor}); ${knownIssues.length} known issues and ${doNotDo.length} ledger entries loaded for dedupe`,
)

const maps = requireStageResults(
  await parallel(
    areas.map((area) => () =>
      agent(mapperPrompt(area), { label: `map:${area.name}`, phase: 'Map', schema: SEAM_SCHEMA }),
    ),
  ),
  'Map',
)

const totalSeams = maps.reduce((n, m) => n + m.seams.length, 0)
log(`Mapping done: ${totalSeams} seams across ${maps.length}/${areas.length} areas`)

// ---- Phase 2: Propose (barrier justified: every lens reads all maps) -------
phase('Propose')
const mapsJson = JSON.stringify(
  maps.map((m) => ({ area: m.area, seams: m.seams })),
  null,
  1,
)

const lensResults = requireStageResults(
  await parallel(
    LENSES.map((lens) => () =>
      agent(lensPrompt(lens, mapsJson), { label: `lens:${lens.key}`, phase: 'Propose', schema: CANDIDATE_SCHEMA }),
    ),
  ),
  'Propose',
)

const rawCandidates = lensResults.flatMap((r) => r.candidates.map((c) => ({ ...c, lens: r.lens })))
log(`Lenses proposed ${rawCandidates.length} raw candidates`)

// ---- Phase 3: Dedupe (barrier justified: needs the full candidate set) -----
phase('Dedupe')
const dedupe = rawCandidates.length
  ? requireStageResults(
      [
        await agent(
          [
            `Merge and dedupe tech-debt candidates for the TeXRA tournament ${campaignDate}. READ-ONLY; no edits.`,
            ``,
            `1. Merge near-duplicate candidates (same deletion proposed by different lenses) into the single strongest spec.`,
            `2. Drop any candidate that duplicates an EXISTING issue below (report which). Titles will not match verbatim — judge by substance, and check the issue on GitHub or in the repo docs when unsure.`,
            `3. Drop any candidate banned by the DO-NOT-DO ledger below (report which). Ledger entries are adjudicated verdicts; do not relitigate them here.`,
            ``,
            `Existing issues:`,
            knownIssues.length ? knownIssues.map((s) => `- ${s}`).join('\n') : '- (none provided)',
            ``,
            `Do-not-do ledger:`,
            doNotDo.length ? doNotDo.map((s) => `- ${s}`).join('\n') : '- (none provided)',
            ``,
            `Candidates (JSON):`,
            JSON.stringify(rawCandidates, null, 1),
          ].join('\n'),
          { label: 'dedupe', phase: 'Dedupe', schema: DEDUPE_SCHEMA },
        ),
      ],
      'Dedupe',
    )[0]
  : { kept: [], droppedAsKnown: [], droppedAsDoNotDo: [], merged: [] }

const riskRank = { low: 0, medium: 1, high: 2 }
const ranked = dedupe.kept.toSorted(
  (a, b) => riskRank[a.risk] - riskRank[b.risk] || b.estLoc - a.estLoc,
)
const toVerify = ranked.slice(0, MAX_FILE)
if (ranked.length > toVerify.length) {
  log(`Capping this cycle at ${MAX_FILE}: not selecting ${ranked.length - toVerify.length} additional candidate(s): ${ranked
    .slice(MAX_FILE)
    .map((c) => c.title)
    .join(' | ')}`)
}
log(`Dedupe done: ${dedupe.kept.length} kept, ${dedupe.droppedAsKnown.length} already tracked, ${dedupe.droppedAsDoNotDo.length} ledger-banned; verifying ${toVerify.length}`)

// ---- Phase 4: Verify (pipeline: each candidate verifies independently) -----
phase('Verify')
const verified = requireStageResults(
  await pipeline(toVerify, (candidate) =>
    parallel(
      REFUTER_LENSES.map((lens) => () =>
        agent(refuterPrompt(candidate, lens), {
          label: `verify:${lens.key}:${candidate.area}`,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }),
      ),
    ).then((votes) => {
      const cast = requireStageResults(votes, `Verify ${candidate.title}`)
      const refutes = cast.filter((v) => v.refuted)
      const corrections = cast.map((v) => v.corrections).filter((text) => text && text.trim())
      let verdict = 'CONTESTED'
      if (refutes.length >= 2) verdict = 'NET_LOSS'
      else if (refutes.length === 0 && corrections.length === 0) verdict = 'REAL_NET_GAIN'
      return {
        ...candidate,
        verdict,
        votes: cast,
        corrections,
      }
    }),
  ),
  'Verify',
)

const allSurvivors = verified.filter((candidate) => candidate.verdict === 'REAL_NET_GAIN')
const rejected = verified.filter((candidate) => candidate.verdict === 'NET_LOSS')
const contested = verified.filter((candidate) => candidate.verdict === 'CONTESTED')

// Every verified survivor is filed. The single pre-verification cap guarantees this
// cannot exceed MAX_FILE and avoids a second persisted carry-forward queue.
const toFile = allSurvivors.toSorted(
  (a, b) => riskRank[a.risk] - riskRank[b.risk] || b.estLoc - a.estLoc,
)

// NET_LOSS with a confident majority becomes a ledger entry so future sweeps stop re-proposing it.
const newDoNotDo = rejected
  .filter((c) => c.votes.filter((v) => v.refuted && v.confidence !== 'low').length >= 2)
  .map(
    (c) =>
      `${c.title}: NET_LOSS (tournament ${campaignDate}) — ${c.votes
        .filter((vote) => vote.refuted)
        .map((vote) => vote.reason.replaceAll(/\s+/g, ' ').trim())
        .join('; ')}`,
  )

log(
  `Verification done: ${allSurvivors.length} REAL_NET_GAIN (${toFile.length} to file, ~-${toFile.reduce((n, c) => n + c.estLoc, 0)} LoC), ${rejected.length} NET_LOSS, ${contested.length} contested (not filed)`,
)

return {
  campaignDate,
  areasThisCycle: areas.map((a) => a.name),
  nextCursor: cursor + areas.length,
  toFile,
  contested,
  rejected,
  newDoNotDo,
  droppedAsKnown: dedupe.droppedAsKnown,
  droppedAsDoNotDo: dedupe.droppedAsDoNotDo,
  merged: dedupe.merged,
  seamCount: totalSeams,
}
