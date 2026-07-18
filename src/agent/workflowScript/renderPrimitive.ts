// Third-party imports
import * as nunjucks from 'nunjucks';

// Isolated Nunjucks environment so `autoescape: false` does not leak into the
// shared singleton that `nunjucks.configure` / `nunjucks.renderString` would
// otherwise set for every other caller. Nunjucks is a host-side Node library,
// so `render` runs in the host and only the resulting string crosses into the
// sandbox realm. Rendering is deterministic and pure, so it is safe to expose
// as a synchronous primitive.
const env = new nunjucks.Environment(null, { autoescape: false });

/**
 * Render a Nunjucks template string with already-resolved JSON `data`, for the
 * workflow-script `render()` primitive. Lets a script template a prior stage's
 * structured result into the next prompt or a text artifact.
 */
export function renderWorkflowTemplate(
  templateString: string,
  data: Record<string, unknown>,
): string {
  if (typeof templateString !== 'string') {
    throw new Error(
      'render(templateString, data) requires templateString to be a string.',
    );
  }
  return env.renderString(templateString, data ?? {});
}
