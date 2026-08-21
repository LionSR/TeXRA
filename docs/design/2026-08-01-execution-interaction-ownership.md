# Interaction Ownership on the Execution Registry

Status: implemented (D3/T5 of the runtime gold-standard program). This note
records the accepted shape only; the retired
`docs/prds/2026-06-29-prd-runtime-gold-standard.md` must not be implemented
from.

## The fact being owned

A host attaches one set of interaction surfaces per run generation: a
presentation host, a `HostInteractions` adapter, a terminal-result presenter.
The question those surfaces need answered is not "is the root run finished" but
"is any execution that inherited this generation's surfaces still alive". A
stopped root can leave detached children running, and those children must keep
an answerable approval path after the root promise settles — while a later root
generation must not inherit them.

Before this change the answer lived in the CLI chat controller: two maps
(execution id and stream id to an owner token), two live sets (tracked handles
and reserved child activations), and two registry listeners, all rebuilt per
run-host generation. That is run-lifecycle bookkeeping, and the runtime already
owns every input it reads — handle registration, child-activation reservation,
and the parent/child stream lineage on `AgentExecutionHandle`.

## Shape

`ExecutionRegistry.interactionOwnership` is one index per session
(`src/agent/runtime/executionInteractionOwnership.ts`):

- `open(onRelease)` starts an owner generation and returns a scope. The scope
  object _is_ the owner token, so there is no second identity to keep in sync.
- `scope.claim(executionId)` claims a run and everything it goes on to spawn.
  Inheritance is by stream lineage: a handle whose `parentStreamId` is a stream
  this scope owns joins the scope, and its `childStreamId` becomes owned too,
  so grandchildren inherit without the host walking the tree.
- `scope.finish()` states that no further root claims are coming. Release
  happens when the last claimed handle is untracked and the last reserved child
  activation is released — immediately, when none is left.
- `scope.release()` drops every claim now and fires `onRelease` exactly once.
- `ownerOf(executionId)` is the read side.

That is the whole surface, per the accepted ruling: owner token, refcount,
`ownedBy` query, release notification. No host-facing port, no per-host
adapter, no speculative API.

## Who writes, who reads

The CLI chat controller (`packages/cli/src/chat/chatSessionController.ts`) is
the only writer. It opens one scope per run-host generation, claims the root
execution, and calls `finish()` when the root run settles; the release callback
tears down the presentation host, the interaction adapter, and the
terminal-result presenter.

The extension and desktop hosts stay read-only. They neither claim nor query:
their run-scoped views are fed by the transcript plane and the session-fact
rail (`SessionEventHub`, `@agent/trace`), which already carry every fact those
UIs render. Adding a host port for them would freeze an unvalidated surface for
a consumer that does not exist.

## Why a refcount rather than a run promise

A run promise settles when the root turn finishes, which is earlier than the
last inheriting execution ends and later than the root handle is untracked.
Both directions have shipped as bugs: releasing on the root promise closed the
approval path for detached children, and holding until every execution ended
kept a finished root turn pending. The refcount separates the two facts —
"this generation accepts no more claims" (`finish`) and "this generation still
has live work" (the count) — and only their conjunction releases.

Reserved child activations count toward the refcount because a child loop
starts synchronously but constructs its first handle asynchronously; without
that reservation the gap between the two reads as idle and releases the
surfaces the child is about to need.
