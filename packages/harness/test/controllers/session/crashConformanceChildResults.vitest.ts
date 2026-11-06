/**
 * The crash-point conformance suite over the harness's built-ins: a child's
 * result read once across a crash, a detached command a killed process left,
 * and one job's appends.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['child-results']);
