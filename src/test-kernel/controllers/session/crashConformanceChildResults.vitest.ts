/**
 * The crash-point conformance suite over TeXRA's plugins (`texraPlugins`),
 * the list every TeXRA host composes its process from: a child's
 * result read once across a crash, a detached command a dead process left,
 * and one job's appends.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['child-results']);
