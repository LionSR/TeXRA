<script setup>
// Frameless GitHub-PR review card for guide/code-review.md ("What you'll see
// on a PR"). The TeXRA Code Review GitHub Action posts a SINGLE review from
// github-actions[bot]: (1) a top-level summary / verdict comment, and (2)
// inline comments anchored to specific flagged lines. On the next push to the
// same PR the threads are updated in place rather than re-posted — conveyed
// here by the "Updated on re-push" badge on the inline thread.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// (defined in theme/mockup.css on `.mockup`) resolve here and the card flips
// cleanly between the docs light / dark themes. Static strings only — no live
// dates, no synthetic ids at render time. Diff-line styling (.dl / .gut / .add)
// follows the same idiom as CompareHero.
</script>

<template>
  <div
    class="mockup pr"
    role="group"
    aria-label="TeXRA code review on a pull request"
  >
    <!-- Bot conversation row: avatar + actor + what it did -->
    <div class="pr-head">
      <span class="pr-avatar" aria-hidden="true">
        <wa-icon library="texra" name="robot"></wa-icon>
      </span>
      <div class="pr-head-body">
        <div class="pr-head-line">
          <span class="pr-actor">github-actions</span>
          <span class="pr-bot">bot</span>
          <span class="pr-action">reviewed</span>
          <span class="pr-time">2 hours ago</span>
        </div>
        <div class="pr-head-sub">
          <wa-icon class="pr-sub-ic" library="texra" name="robot"></wa-icon>
          TeXRA Code Review
        </div>
      </div>
      <span class="pr-verdict">Changes requested</span>
    </div>

    <!-- Top-level summary / verdict comment -->
    <div class="pr-summary">
      <div class="pr-summary-bar"></div>
      <div class="pr-summary-body">
        2 issues worth a look, otherwise looks good. The new
        <code class="pr-code">summarize()</code> path needs an empty-input guard
        before it indexes, and one log line leaks a token.
      </div>
    </div>

    <!-- Inline comment anchored to a specific diff hunk -->
    <div class="pr-inline">
      <div class="pr-file">
        <wa-icon class="pr-file-ic" library="texra" name="file-code"></wa-icon>
        <span class="pr-file-name">src/agent/summarize.ts</span>
      </div>

      <div class="pr-diff">
        <div class="dl">
          <span class="gut">41</span><span class="kw">export function</span>
          summarize(items) {
        </div>
        <div class="dl add">
          <span class="gut">42</span>&nbsp;&nbsp;<span class="kw">const</span>
          first = items[<span class="m">0</span>].text;
        </div>
        <div class="dl">
          <span class="gut">43</span>&nbsp;&nbsp;<span class="kw">return</span>
          first.slice(<span class="m">0</span>, <span class="m">80</span>);
        </div>
      </div>

      <!-- Comment bubble pinned to the flagged line -->
      <div class="pr-thread">
        <div class="pr-comment">
          <span class="pr-c-avatar" aria-hidden="true">
            <wa-icon library="texra" name="robot"></wa-icon>
          </span>
          <div class="pr-c-body">
            <div class="pr-c-head">
              <span class="pr-c-actor">github-actions[bot]</span>
              <span class="pr-c-badge">
                <wa-icon library="texra" name="rotate-right"></wa-icon>
                Updated on re-push
              </span>
            </div>
            <div class="pr-c-text">
              Guard against the empty-array case here —
              <code class="pr-code">items[0]</code> throws when
              <code class="pr-code">items</code> is
              <code class="pr-code">[]</code>. Return early or default the
              slice.
            </div>
          </div>
        </div>
        <div class="pr-reply">Reply to this thread…</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone frameless card. Tokens come from `.mockup` (theme/mockup.css). */
.pr {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14) var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

/* Bot conversation header */
.pr-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
  padding-bottom: var(--mk-space-10);
  border-bottom: 1px solid var(--mk-border);
}
.pr-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--mk-size-30);
  height: var(--mk-size-30);
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-82);
}
.pr-head-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  min-width: 0;
  flex: 1;
}
.pr-head-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
  font-size: var(--mk-fs-82);
}
.pr-actor {
  font-weight: 600;
  color: var(--mk-text);
}
.pr-bot {
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-pill);
  padding: 0 var(--mk-space-6);
}
.pr-action,
.pr-time {
  font-size: var(--mk-fs-74);
  color: var(--color-text-secondary);
}
.pr-time {
  color: var(--color-text-tertiary);
}
.pr-head-sub {
  display: flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-72);
  color: var(--color-text-tertiary);
}
.pr-sub-ic {
  font-size: var(--mk-space-11);
  color: var(--mk-accent);
}
.pr-verdict {
  flex-shrink: 0;
  align-self: flex-start;
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--color-warning);
  background: rgba(210, 153, 34, 0.13);
  border: 1px solid rgba(210, 153, 34, 0.3);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-9);
}

/* Top-level summary / verdict comment */
.pr-summary {
  display: flex;
  gap: var(--mk-space-10);
  margin-top: var(--mk-space-12);
}
.pr-summary-bar {
  flex-shrink: 0;
  width: 2px;
  border-radius: var(--mk-radius-pill);
  background: var(--mk-accent);
  opacity: 0.6;
}
.pr-summary-body {
  font-size: var(--mk-fs-80);
  line-height: 1.5;
  color: var(--color-text-secondary);
}

/* Inline comment block */
.pr-inline {
  margin-top: var(--mk-space-14);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-lg);
  overflow: hidden;
}
.pr-file {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-7) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-text);
}
.pr-file-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-accent);
}
.pr-file-name {
  font-weight: 500;
}

/* Diff hunk (reuses the .dl/.gut/.add idiom from CompareHero) */
.pr-diff {
  padding: var(--mk-space-6) 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-82);
  line-height: 1.7;
  color: var(--wa-color-text-normal);
}
.dl {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
  padding: 0 var(--mk-space-14) 0 0;
  white-space: pre-wrap;
}
.gut {
  flex-shrink: 0;
  width: var(--mk-size-24);
  text-align: right;
  padding-right: var(--mk-space-6);
  color: var(--color-text-tertiary);
  border-right: 1px solid var(--color-border);
  user-select: none;
}
.dl.add {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}
.dl .kw {
  color: var(--mk-syn-fn);
}
.dl .m {
  color: var(--mk-accent);
}

/* Comment bubble pinned to the flagged line */
.pr-thread {
  border-top: 1px solid var(--mk-border);
  background: var(--mk-bg-soft);
  padding: var(--mk-space-10) var(--mk-space-12) var(--mk-space-8);
}
.pr-comment {
  display: flex;
  gap: var(--mk-space-8);
}
.pr-c-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-70);
}
.pr-c-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
  min-width: 0;
}
.pr-c-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.pr-c-actor {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.pr-c-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-7);
}
.pr-c-badge wa-icon {
  font-size: var(--mk-space-10);
}
.pr-c-text {
  font-size: var(--mk-fs-78);
  line-height: 1.5;
  color: var(--color-text-secondary);
}

/* Inline-code chip used in comments + summary */
.pr-code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  background: var(--mk-bg-raised);
  padding: 1px var(--mk-space-4);
  border-radius: var(--mk-radius-sm);
  color: var(--mk-accent);
}

/* Reply affordance */
.pr-reply {
  margin-top: var(--mk-space-8);
  margin-left: calc(var(--mk-size-21) + var(--mk-space-8));
  padding: var(--mk-space-6) var(--mk-space-10);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-74);
  color: var(--color-text-tertiary);
}
</style>
