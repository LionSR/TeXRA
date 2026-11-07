/**
 * The crash-point conformance suite over the harness's built-ins: a child's
 * result read once across a crash, shard 2 of 3.
 */
import { crashConformanceSuite } from '@test/support/crashConformance';

crashConformanceSuite(['child-results'], { index: 1, count: 3 });
