<script setup>
// Frameless Lean proof artifact — the payoff of guide/lean.md. The agent reads
// compiler diagnostics, inspects the tactic proof state, and iterates a .lean
// file until it compiles with 0 errors / 0 sorry.
//
// Two stacked panes, no VS Code window: (1) the diagnostics the agent reads
// BEFORE the fix ("unsolved goals" in red), and (2) the same proof AFTER —
// compiling, with the goal annotation inline. Reuses the `.term term-lean`
// surface already styled in theme/mockup.css (.term, .ln, .tac, .term-note,
// .term-ok). Root carries `.mockup` so the shared tokens resolve and the panes
// flip with the docs light / dark theme.
</script>

<template>
  <div class="mockup lean-proof" role="group" aria-label="Lean proof state">
    <!-- BEFORE: diagnostics the agent reads -->
    <div class="lp-pane">
      <div class="lp-cap">
        <wa-icon class="lp-cap-ic err" library="texra" name="alert"></wa-icon>
        <span class="lp-cap-name">SpectralGap.lean</span>
        <span class="lp-cap-tag">lean_diagnostics</span>
      </div>
      <div class="term term-lean">
        <div class="ln">
          <span class="kw">theorem</span> spectral_gap_pos
          <span class="kw">(hd</span> : 2 ≤ d) :
        </div>
        <div class="ln indent">
          d - mu2 G &gt; 0 := <span class="kw">by</span>
        </div>
        <div class="ln indent2"><span class="tac">sorry</span></div>
        <div class="term-note">
          <span class="lp-err">error: line 3 — unsolved goals</span>
          <div class="ln lp-goal">⊢ d - mu2 G &gt; 0</div>
        </div>
      </div>
    </div>

    <div class="lp-arrow">
      <wa-icon library="texra" name="arrow-down"></wa-icon>
      <span class="lp-arrow-lbl"
        >agent inspects the goal, finds the lemma, iterates</span
      >
    </div>

    <!-- AFTER: the proof compiles -->
    <div class="lp-pane">
      <div class="lp-cap">
        <span class="lp-cap-ic t-lean">λ</span>
        <span class="lp-cap-name">SpectralGap.lean</span>
        <span class="lp-cap-tag ok">compiles</span>
      </div>
      <div class="term term-lean">
        <div class="ln">
          <span class="kw">theorem</span> spectral_gap_pos
          <span class="kw">(hd</span> : 2 ≤ d) :
        </div>
        <div class="ln indent">
          d - mu2 G &gt; 0 := <span class="kw">by</span>
        </div>
        <div class="ln indent2">
          <span class="tac">have</span> hμ : mu2 G &lt; d := alon_boppana hd
        </div>
        <div class="ln indent2"><span class="tac">linarith</span></div>
        <div class="term-note">
          <span class="term-ok">✓ proof compiles · 0 errors · 0 sorry</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone frameless wrapper. The Lean panes (.term term-lean and its
   .ln/.tac/.term-note/.term-ok/.t-lean children) are styled in .mockup
   (theme/mockup.css); this file adds the wrapper, captions, and arrow. */
.lean-proof {
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
}

.lp-pane {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  overflow: hidden;
}

.lp-cap {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-12);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
}
.lp-cap-ic {
  font-size: var(--mk-space-13);
  flex-shrink: 0;
  color: var(--mk-syn-fn);
}
.lp-cap-ic.err {
  color: var(--color-error);
}
.lp-cap-name {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.lp-cap-tag {
  margin-left: auto;
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-6);
}
.lp-cap-tag.ok {
  color: var(--mk-ins-text);
  border-color: color-mix(in srgb, var(--color-success) 40%, transparent);
}

/* Tighten the bordered .term inside the captioned pane (no double frame). */
.lp-pane .term {
  margin: var(--mk-space-12);
  border: none;
}

.lp-err {
  color: var(--color-error);
  font-weight: 600;
}
.lp-goal {
  margin-top: var(--mk-space-4);
  color: var(--mk-syn-tac);
  font-family: var(--vp-font-family-mono);
}

.lp-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-7) 0;
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.lp-arrow wa-icon {
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
}
.lp-arrow-lbl {
  font-style: italic;
}
</style>
