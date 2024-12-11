import { checkRepetitionDMP, checkRepetitionDifflib, logMassiveRepetition } from './outputUtils';

// Test cases
const testCases = [
  {
    name: "Small repetition",
    lastResponse: "This is a test response.",
    newResponse: "This is a test response with some extra content.",
  },
  {
    name: "Large repetition",
    lastResponse: "A".repeat(2000),  // 2000 'A' characters
    newResponse: "A".repeat(2000) + "B",
  },
  {
    name: "Mixed content",
    lastResponse: "This is a test response with some content that might be repeated. " +
      "Here is a long section that could potentially be duplicated multiple times across responses.",
    newResponse: "This is a test response with some content that might be repeated. " +
      "Here is a long section that could potentially be duplicated multiple times across responses. " +
      "And here is some additional content that makes it different.",
  }
];

// Run tests
console.log("Testing both implementations:\n");

testCases.forEach(({ name, lastResponse, newResponse }) => {
  console.log(`\n=== Test Case: ${name} ===`);

  console.log("\nDiff-Match-Patch Results:");
  const dmpResult = checkRepetitionDMP(lastResponse, newResponse);
  console.log(`Massive repetition: ${dmpResult.massiveRepetitionDetected}`);
  console.log(`Similarity ratio: ${dmpResult.ratio.toFixed(4)}`);
  console.log(`Longest match length: ${dmpResult.longestMatch.length}`);

  console.log("\nDifflib Results:");
  const difflibResult = checkRepetitionDifflib(lastResponse, newResponse);
  console.log(`Massive repetition: ${difflibResult.massiveRepetitionDetected}`);
  console.log(`Similarity ratio: ${difflibResult.ratio.toFixed(4)}`);
  console.log(`Longest match length: ${difflibResult.longestMatch.length}`);

  // Log if massive repetition is detected
  if (dmpResult.massiveRepetitionDetected || difflibResult.massiveRepetitionDetected) {
    console.log("\nLogging massive repetition:");
    logMassiveRepetition(dmpResult);
  }
});