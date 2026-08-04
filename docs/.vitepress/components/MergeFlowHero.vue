<script setup>
// The mental model behind Intelligent Merge: a PARTIAL agent output
// (r1/spectral-gap.tex — only the sections the agent touched) plus the FULL
// Base File feed the `merge` agent, which synthesizes a COMPLETE document
// (r0/spectral-gap.tex) that is the valid latexdiff input against the original
// basename.tex.
//
// Root carries `.mockup`, so the shared `--mk-*` tokens and the
// .surface/.cl/.kw mono-code vocabulary in theme/mockup.css resolve here and
// flip with the docs light / dark theme. Static strings only.
import StatusPill from './StatusPill.vue';
</script>

<template>
  <div
    class="mockup merge-flow"
    role="group"
    aria-label="intelligent merge pipeline"
  >
    <!-- Inputs: full base + partial edit -->
    <div class="mf-inputs">
      <article class="mf-doc">
        <header class="mf-doc-head">
          <wa-icon
            class="mf-fi t-tex"
            library="texra"
            name="file-code"
          ></wa-icon>
          <span class="mf-name">spectral-gap.tex</span>
          <StatusPill variant="info" shape="pill">Base · full</StatusPill>
        </header>
        <div class="surface mf-code">
          <div class="cl"><span class="kw">\section</span>{Introduction}</div>
          <div class="cl indent">Spectral graph theory studies…</div>
          <div class="cl"><span class="kw">\section</span>{Preliminaries}</div>
          <div class="cl indent">Let G be a d-regular graph…</div>
          <div class="cl"><span class="kw">\section</span>{Spectral Gap}</div>
          <div class="cl indent">The gap d − λ₂ governs…</div>
        </div>
      </article>

      <article class="mf-doc">
        <header class="mf-doc-head">
          <wa-icon
            class="mf-fi t-tex"
            library="texra"
            name="file-code"
          ></wa-icon>
          <span class="mf-name">r1/spectral-gap.tex</span>
          <StatusPill variant="warning" shape="pill"
            >Edited · partial</StatusPill
          >
        </header>
        <div class="surface mf-code">
          <div class="cl mf-gap">
            <span class="cmt">% only the revised section</span>
          </div>
          <div class="cl"><span class="kw">\section</span>{Spectral Gap}</div>
          <div class="cl indent">
            The gap d − λ₂ <span class="ins">tightly bounds</span>
          </div>
          <div class="cl indent">the mixing time of the random walk…</div>
          <div class="cl mf-gap">
            <span class="cmt">% (other sections omitted)</span>
          </div>
        </div>
      </article>
    </div>

    <!-- Both inputs converge on the merge agent -->
    <div class="mf-arrow" aria-hidden="true">
      <wa-icon library="texra" name="arrow-right"></wa-icon>
    </div>

    <div class="mf-agent">
      <wa-icon class="mf-agent-ic" library="texra" name="robot"></wa-icon>
      <span class="mf-agent-name">merge</span>
      <StatusPill variant="accent" shape="chip">Claude Opus 5</StatusPill>
      <span class="mf-agent-sub">synthesizes a complete document</span>
    </div>

    <div class="mf-arrow" aria-hidden="true">
      <wa-icon library="texra" name="arrow-right"></wa-icon>
    </div>

    <!-- Output: the complete merged document -->
    <article class="mf-doc mf-out">
      <header class="mf-doc-head">
        <wa-icon class="mf-fi t-tex" library="texra" name="file-code"></wa-icon>
        <span class="mf-name">r0/spectral-gap.tex</span>
        <StatusPill variant="success" shape="pill">Complete</StatusPill>
      </header>
      <div class="surface mf-code">
        <div class="cl"><span class="kw">\section</span>{Introduction}</div>
        <div class="cl"><span class="kw">\section</span>{Preliminaries}</div>
        <div class="cl"><span class="kw">\section</span>{Spectral Gap}</div>
        <div class="cl indent">
          The gap d − λ₂ <span class="ins">tightly bounds</span>
        </div>
        <div class="cl indent">the mixing time of the random walk…</div>
      </div>
      <footer class="mf-out-foot">
        <wa-icon
          class="mf-foot-ic"
          library="texra"
          name="diff-single"
        ></wa-icon>
        <span
          >valid <code>latexdiff</code> input vs
          <code>spectral-gap.tex</code></span
        >
      </footer>
    </article>
  </div>
</template>

<style scoped>
/* Standalone pipeline. Tokens + .surface/.cl/.kw/.cmt/.t-tex from `.mockup`. */
.merge-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-8);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}

/* The two inputs stack vertically and feed the agent together. */
.mf-inputs {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  flex: 1 1 var(--mk-size-180);
  min-width: 0;
}

.mf-doc {
  display: flex;
  flex-direction: column;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  overflow: hidden;
}
.mf-out {
  flex: 1 1 var(--mk-size-180);
  min-width: 0;
}
.mf-doc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-6) var(--mk-space-10);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
}
.mf-fi {
  font-size: var(--mk-space-12);
  flex-shrink: 0;
}
.mf-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--color-text-link);
  margin-right: auto;
}
.mf-code {
  padding: var(--mk-space-8) var(--mk-space-10);
  font-size: var(--mk-fs-70);
  line-height: 1.55;
}
.mf-code .ins {
  color: var(--mk-ins-text);
}
.mf-gap {
  color: var(--mk-text-faint);
}

.mf-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
  font-size: var(--mk-space-14);
  flex-shrink: 0;
}

/* Center merge-agent node. */
.mf-agent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--mk-space-4);
  text-align: center;
  flex: 0 0 auto;
  max-width: var(--mk-size-168);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid var(--mk-accent);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
}
.mf-agent-ic {
  font-size: var(--mk-space-18);
  color: var(--mk-accent);
}
.mf-agent-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 700;
  color: var(--mk-text);
}
.mf-agent-sub {
  font-size: var(--mk-fs-66);
  line-height: 1.4;
  color: var(--color-text-secondary);
}

.mf-out-foot {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-6) var(--mk-space-10);
  border-top: 1px solid var(--mk-border);
  font-size: var(--mk-fs-66);
  color: var(--color-text-secondary);
}
.mf-out-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-64);
  color: var(--color-text-link);
}
.mf-foot-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-accent);
  flex-shrink: 0;
}

/* Stack the whole pipeline on narrow screens, arrows pointing down. */
@media (max-width: 720px) {
  .merge-flow {
    flex-direction: column;
    align-items: stretch;
  }
  .mf-inputs,
  .mf-out,
  .mf-agent {
    flex: none;
    max-width: none;
  }
  .mf-arrow {
    transform: rotate(90deg);
  }
}
</style>
