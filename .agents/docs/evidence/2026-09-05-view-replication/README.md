# Fold and replication probe evidence

These probes support the [September 5, 2026 view-replication evaluation](../../rejected/architecture/2026-09-05-event-fold-versus-view-replication-evaluation.md).
They run the actual TeXRA fold and Pi immutable applicator against synthetic inputs.
The checked-in `.out` files contain the measurements cited in the proposal;
they are evidence from individual runs, not CI performance thresholds. The two
components are measured separately and their timings are not comparable end to end.

## TeXRA fold

The source pin is `3958a96edd453938e023f163c1aa5b358854d89d`, with Node.js
**v26.6.0**. The build script takes a clean checkout at that exact commit, resolves
esbuild and the TypeScript path aliases from it, and bundles the production fold.
A build-only plugin exports the private `SessionEventSchema` for fixture validation;
it changes no source files or fold logic. The probe is deliberately outside the
product test suite and is not a supported API consumer.

Run from the TeXRA repository root. The checkout used to obtain this evidence had
its locked dependencies installed. Prepare a separate pinned checkout and install
its dependencies if needed:

```sh
TEXRA_PROBE_DIR="$(mktemp -d)"
git worktree add --detach "$TEXRA_PROBE_DIR/source" \
  3958a96edd453938e023f163c1aa5b358854d89d
corepack pnpm --dir "$TEXRA_PROBE_DIR/source" install --frozen-lockfile
node .agents/docs/evidence/2026-09-05-view-replication/texra-fold-build.mjs \
  "$TEXRA_PROBE_DIR/source" "$TEXRA_PROBE_DIR/probe.cjs"
node --expose-gc "$TEXRA_PROBE_DIR/probe.cjs" \
  > "$TEXRA_PROBE_DIR/texra-fold-probe.fresh.out"
```

The fixture has 10,000 schema-validated, completed assistant rows in one flat
stream. The fold consumes batches of 64 inputs. Validation and a warmup replay
precede timing; five trials measure one, three or ten sequential replays. The
`readers` field in the output names these hypothetical observer repetitions,
not concurrent clients. Timing excludes parsing, storage, transport, rendering
and immutable publication. The probe also records retained-array mutation,
runtime-relative `readOnly` values and JSON serialization of the Map-backed view.

[texra-fold-probe.out](./texra-fold-probe.out) is a fresh captured run made while
preparing this evidence, using the same fixture as the initial investigation.
Its medians are the ones reported in the evaluation. The source and build files
are [texra-fold-probe.ts](./texra-fold-probe.ts) and
[texra-fold-build.mjs](./texra-fold-build.mjs).

## Chord source and environment

The measurements used Node.js **v26.6.0** with `--expose-gc` and Pi **v0.85.1**,
commit **`d981de1229ef899957bbe968bc8dcda02a21f477`**. The scripts import TypeScript
directly using Node's built-in type stripping. No Pi build or dependency
installation is needed for these imports.

- [Chord immutable applicator](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/delta/index.ts#L1014-L1063)
- [Chord replicated-state implementation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/chord/src/services/state.ts#L85-L109)
- [Pi's placement of the active streaming message](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/reducer.ts#L93-L115)

The original scripts used imports relative to the investigation directory. The
preserved versions take the Pi source root as their first positional argument and use
portable dynamic imports. Apart from that import setup, invocation checks and
formatting, their measurement and assertion logic is unchanged.

## Reproduce the Chord probes

Run from the TeXRA repository root with Node v26.6.0. Retrieve the exact source
archive into a temporary directory:

```sh
PI_PROBE_DIR="$(mktemp -d)"
PI_SOURCE_COMMIT=d981de1229ef899957bbe968bc8dcda02a21f477
curl --fail --location --silent --show-error \
  "https://codeload.github.com/earendil-works/pi/tar.gz/$PI_SOURCE_COMMIT" \
  --output "$PI_PROBE_DIR/pi-source.tar.gz"
tar -xzf "$PI_PROBE_DIR/pi-source.tar.gz" -C "$PI_PROBE_DIR"
PI_SOURCE_ROOT="$PI_PROBE_DIR/pi-$PI_SOURCE_COMMIT"
```

Run both probes, writing new output outside the repository so the historical
measurements remain intact:

```sh
node --version
node --expose-gc \
  .agents/docs/evidence/2026-09-05-view-replication/chord-replica-probe.mjs \
  "$PI_SOURCE_ROOT" > "$PI_PROBE_DIR/chord-replica-probe.fresh.out"
node --expose-gc \
  .agents/docs/evidence/2026-09-05-view-replication/chord-active-shape-probe.mjs \
  "$PI_SOURCE_ROOT" > "$PI_PROBE_DIR/chord-active-shape-probe.fresh.out"
```

Each script prints JSON measurements followed by a correctness-assertion result.
A failed assertion exits unsuccessfully. The scripts trust the supplied source
root; use the pinned archive above or independently verify a checkout's commit.

## What is measured

Each sample reports the median of five trials. A trial warms up with 100 batches,
then measures 500 batches of prebuilt, decoded operations. Timing covers operation
application and, when selected, retention of previous revisions. Forced garbage
collection occurs outside the timed interval. Heap growth is the difference in
`heapUsed` after forced collection before and after the measured loop; explicit
global references keep the selected revisions reachable during collection.

- `chord-replica-probe.mjs` places the active messages inside an array of 100,
  1,000, 10,000 or 50,000 messages. It applies either one or eight text-append
  operations per batch, retaining or releasing previous revisions. Assertions
  check prior values, shared untouched identities, atomic failure of a replica
  update, sequence-gap clearing and explicit rehydration.
- `chord-active-shape-probe.mjs` places one active message beside the historical
  transcript. It applies one text append per batch with 1,000, 10,000 or 50,000
  historical messages. Assertions check that history retains its identity and
  that retained active revisions remain unchanged. This synthetic shape follows
  Pi's separation of `operation.streamingMessage` from history; it does not run
  Pi's full transcript provider.

The first shape exposes ancestor-array copying. The second shows that separating
active state from history avoids that copying during token updates. The first
shape is therefore **not a measurement of Pi's normal streaming path**. Retaining
500 revisions is a deliberate sensitivity case, not a claim that either product
retains that many revisions in normal use.

The probes exclude producer tracking and publication, path codecs, serialization,
transport, durable storage, business folds and UI rendering. They do not compare
end-to-end Pi and TeXRA performance. Timing and heap values depend on the machine,
Node/V8, garbage collection and system load; small differences are not evidence
of a product improvement.

## Historical output and portable-script validation

`chord-replica-probe.out` and `chord-active-shape-probe.out` are byte-for-byte copies
of the original September 5 outputs, including the original Node version and
assertion results. They support the proposal's numbers and were not replaced by
fresh timings during evidence preparation.

The portable scripts were separately rerun against the same pinned source on
Node v26.6.0 with `--expose-gc`. Both completed with their correctness assertions
passing. Those fresh smoke-run timings were not substituted for the historical
results and are not additional performance claims.
