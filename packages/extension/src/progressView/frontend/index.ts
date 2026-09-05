/**
 * The progress webview entry (PRD one-fold-three-renderers, 7.7): the one
 * bundle the sidebar and the editor tab load. It registers the shell and
 * mounts the runtime onto the `<progress-app>` the host's HTML carries.
 */
// Web Awesome runtime (theme + token bridge); components are added per family.
import '@shared/wa';

// Third-party styles
import 'katex/dist/katex.min.css';

// Local imports - progress view frontend
import './ProgressApp';
import { mountProgressWebview } from './progressWebview';
import type { ProgressApp } from './ProgressApp';

const app = document.querySelector<ProgressApp>('progress-app');
if (!app)
  throw new Error('The progress webview HTML carries no <progress-app>');
mountProgressWebview(app);
