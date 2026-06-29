---
created: 2026-06-29
---

# Architecture Map: The Couplings Now (and the Program Order)

Visual companion to the consolidation program. The diagrams show the **current**
state - where the three hosts couple to the core and to each other, and where the
duplication the sub-PRDs remove actually lives. Mermaid renders on GitHub.

## How the documents fit (reading order vs execution order)

The three PRD layers are read top-down, even though the filename dates run the
other way (the patterns PRD is dated later but reads first).

```mermaid
flowchart TD
  P["Architecture Patterns PRD, 2026-06-28<br/>THE LENS: patterns, fewest-layers, resolve-once rule"]
  D["Runtime/Host Decoupling PRD, 2026-06-27<br/>THE BOUNDARY OF RECORD: shipped in PR 6697"]
  O["cross-host-consolidation / 00-overview<br/>THE FORWARD BACKLOG, hub"]
  subgraph Units["sub-PRDs, units of work"]
    direction LR
    S1["01 desktop adopts controllers"]
    S2["02 stream-resume"]
    S3["03 settings registries"]
    S4["04 identity resolve-once"]
    S6["06 resolve star layer-collapse"]
    S7["07 reactive projection"]
  end
  E["EXECUTION.md<br/>THE RUNBOOK: stacked worktree, bot-reviewed PRs"]
  P -->|governs| D
  P -->|governs| O
  D -->|continues into| O
  O --> Units
  Units --> E
```

Reading order: **patterns, then decoupling, then 00-overview, then sub-PRDs, then
EXECUTION.** Execution order is a different axis (see the last diagram).

## 1. The runtime to host boundary (the part that is already sound)

One host-agnostic core speaks to every host through a single typed protocol. This
is correct and stays verbatim; the consolidation does not touch it.

```mermaid
flowchart LR
  subgraph Core["host-agnostic core"]
    RC["agent/runtime star-Commands<br/>deep modules"]
    RH["AgentRuntimeHost.emit<br/>typed ProgressEventPayloads protocol"]
    RC --> RH
  end
  RH --> NOOP["noopAgentRuntimeHost<br/>headless null object"]
  RH --> EXT["extension host adapter"]
  RH --> DESK["desktop main adapter"]
  RH --> CLI["cli Ink adapter"]
  EXT -->|typed intent| RC
  DESK -->|typed intent| RC
  CLI -->|typed intent| RC
```

Three-hop spine (see the patterns PRD's Overriding Objective).

## 2. The cross-host coupling map (the drift = the problem)

The residual change-amplification is one layer up, in host orchestration, and it
is concentrated in the extension/desktop pair. The extension routes board and
settings actions through the host-neutral owners; the **desktop re-implements the
same sequences inline and has drifted**; the CLI legitimately differs (Ink TUI,
not a webview rail).

```mermaid
flowchart TD
  subgraph Owners["intended single owners, controllers plus progressView backend"]
    CTRL["ProgressStreamLifecycleController<br/>createProgressViewCommandHandlers<br/>ProgressBackend"]
  end
  EXT["extension webview"] -->|routes through| CTRL
  CLI["cli Ink TUI"] -->|legit affordance, no IPC| CLISTATE["cliState signals, Ink-native"]
  DESK["desktop main, desktopAgentExecution.ts"]
  DESK -.->|forks inline instead of adopting| FORK["duplicated orchestration ~2.4k LOC<br/>delete-all 817-844<br/>desktopProgressEventBridge 745-751<br/>pending-permission mirror"]
  FORK -.->|3 shipped drift bugs| BUGS["delete-all skips stop plus reselect<br/>dropped warning severity 1110<br/>auto-open last vs max round 1133"]
  CTRL --> OK["one correct path"]
  classDef bad fill:#fdd,stroke:#c00;
  classDef good fill:#dfd,stroke:#0a0;
  class FORK,BUGS bad
  class CTRL,OK good
```

Sub-PRD 01 makes desktop _adopt_ `CTRL` and deletes `FORK`; the drift bugs land
first as tiny fixes (P0). The CLI fork is kept on purpose.

## 3. Agent identity: resolved once, carried at one site, re-derived at display sites (04)

(resume-id contract — see sub-PRD 04)

```mermaid
flowchart LR
  RAW["config.agent, RAW e.g. chat"]
  RES["resolveAgentForLaunch<br/>AgentLaunchContext.ts:273"]
  RAW --> RES
  RES -->|resolved name e.g. assistant| DROP["display name not carried today"]
  RAW -->|stays RAW, content-addressed key| KEY["getStreamTabId, getCleanAgentName<br/>StreamSnapshotStore matcher 761,770<br/>KEEP RAW, resume contract"]
  DROP -.->|re-derived at display sites| C1["sessionDescription label"]
  DROP -.->|re-derived| C2["isRemoteAgent 303, latent bug"]
  DROP -.->|re-derived| C3["executionQueries, category"]
  classDef bad fill:#fdd,stroke:#c00;
  classDef keep fill:#eef,stroke:#55a;
  class DROP,C1,C2,C3 bad
  class KEY keep
```

## 4. ProgressView: one event, four reducers (07)

The same `ProgressEventPayloads` event is reduced up to four times into three
stores plus a desktop fork. A board-state change must be authored in four places
and the copies lag.

```mermaid
flowchart TD
  EV["one ProgressEventPayloads event<br/>AgentRuntimeHost.emit"]
  EV --> R1["backend: ProgressEventHandler to ProgressViewState"]
  EV --> R2["frontend mirror: progressState.ts, 10 slices<br/>shared by extension and desktop renderer"]
  EV --> R3["desktop FORK: desktopProgressEventBridge"]
  EV --> R4["cli: subscribeRuntimeHost.applyToState to cliState"]
  classDef bad fill:#fdd,stroke:#c00;
  class R3 bad
```

Sub-PRD 07 (status-slice now, delta-patch deferred) folds status + display
identity + pending approvals into one projection, deletes the desktop fork (R3),
and unifies the backend/frontend shapes so the mirror reducer (R2) can be
collapsed later. The CLI reducer (R4) stays on the same status authority.

## 5. Target couplings (the new design) - the same views, cleaner

The boundary (diagram 1) is unchanged: it is already sound. The problem diagrams
above collapse to these. Fewer nodes, no red forks, no dashed drift edges - that
compression **is** the win. The one preserved nuance is the live-fact exception
(`RunContext.model` stays a getter; the CLI keeps its Ink-native render signal);
the target is "one owner," not "one host."

**5a. Cross-host: every host a thin adapter on one owner (after 01).**

```mermaid
flowchart TD
  subgraph Owner["one owner per sequence, controllers plus progressView backend"]
    CTRL["lifecycle plus command handlers plus ProgressBackend"]
  end
  EXT["extension, thin"] --> CTRL
  DESK["desktop, thin, fork deleted, now adopts"] --> CTRL
  CLI["cli, thin orchestration, keeps Ink render signal"] --> CTRL
  CTRL --> ONE["one path, drift impossible"]
  classDef good fill:#dfd,stroke:#0a0;
  class CTRL,ONE good
```

**5b. Identity: resolve once, store, read (after 04).**

```mermaid
flowchart LR
  RAW["config.agent, RAW"] --> KEY["stream-id key, unchanged, raw"]
  RAW --> RES["resolve ONCE at launch 273"]
  RES --> FIELD["resolvedAgentName stored on launch RunContext<br/>SSOT, branded"]
  FIELD --> READ["display consumers READ the field<br/>re-derivation deleted"]
  classDef good fill:#dfd,stroke:#0a0;
  class FIELD good
```

**5c. ProgressView: one reducer, hosts derive (after 07).**

```mermaid
flowchart TD
  EV["one event"] --> STORE["one projection<br/>getSnapshot, ProgressViewState"]
  STORE --> EXTV["extension renderer derives"]
  STORE --> DESKV["desktop renderer derives, fork gone"]
  STORE --> CLIV["cli signal derives, same authority"]
  classDef good fill:#dfd,stroke:#0a0;
  class STORE good
```

**5d. resolve star: collapse indirection layers (after 06).** The field audit
found no store-at-source wins (see sub-PRD 06 for the audit result); the real
subtractive move is deleting the `resolveRuntime star` wrapper layer over the
coordinator, not storing data.

```mermaid
flowchart LR
  subgraph Before["before, ~78 refs of pass-through"]
    direction TB
    H["host call-site"] --> W["resolveRuntime star wrapper"]
    W --> RCC["runCoordinatorCommands indirection"]
    RCC --> BPC["BasePromiseCoordinator.resolveRequest"]
  end
  subgraph After["after 06"]
    direction TB
    H2["host call-site"] --> BPC2["coordinator.resolveRequest"]
  end
  Before ==>|collapse one layer| After
  classDef good fill:#dfd,stroke:#0a0;
  class H2,BPC2 good
```

The visual test for "cleaner" is literal: count the edges and the red nodes in
sections 2-4 versus section 5. The program is done when the left side cannot be
drawn anymore.

## 6. The two tracks and the execution order

The discriminated-union PRs and the sub-PRDs are one program on two facets:
**SHAPES** (parse-once-at-the-edge DTOs) land first; **FLOW** (one owner per
sequence) consumes the canonical shapes.

```mermaid
flowchart LR
  subgraph SHAPES["SHAPES track, land first"]
    direction TB
    H1["6720 AgentDefinition types"]
    H2["6721 RunContext DU, plain TS"]
    H3["6722 ToolResultPayload DU"]
    H4["6723 ExternalInquiry DU"]
  end
  subgraph FLOW["FLOW track, consumes the shapes"]
    direction TB
    F0["drift bugs plus 01, desktop adopts"]
    FA["Runtime star alias-trim PR, net-LOC lever"]
    F4["04 identity, extends 6721 (design: GS-6)"]
    F5["05 inquiry, consumes 6723"]
    F7["07 status-slice, consumes 6722"]
    F6["06 resolve star wrapper-collapse (design: GS-3)"]
  end
  BIG["6697 decouple, approved, edits the same files"]
  BIG -->|stack 6721 and 6722| SHAPES
  BIG -->|6720 and 6723 vs main, a hedge| SHAPES
  SHAPES --> FLOW
  F4 --> F6
```

Merge/execution order lives in `EXECUTION.md`. Add `npm run typecheck` to the merge gate (esbuild strips
types; no branch protection).

> **Resolve star audit:** see sub-PRD 06 for the audit result. The data model is
> already SSOT-clean; the subtractive budget is the `resolveRuntime star`
> wrapper-collapse plus two CLI inline culls, not any new store.
