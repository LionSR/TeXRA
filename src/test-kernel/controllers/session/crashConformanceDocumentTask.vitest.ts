/**
 * The crash-point conformance suite over TeXRA's plugins (`texraPlugins`),
 * the list every TeXRA host composes its process from: a document task
 * resumed from every commit point, a detached command a dead process left,
 * and one job's appends.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['document-task']);
