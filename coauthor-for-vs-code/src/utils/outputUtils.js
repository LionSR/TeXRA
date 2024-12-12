'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.checkRepetitionDMP = checkRepetitionDMP;
exports.checkRepetitionDifflib = checkRepetitionDifflib;
exports.logMassiveRepetition = logMassiveRepetition;
var diff_match_patch_1 = require('diff-match-patch');
var difflib = require('difflib');
/**
 * Checks for massive repetition using diff-match-patch
 */
function checkRepetitionDMP(lastResponse, newResponse) {
  var dmp = new diff_match_patch_1.diff_match_patch();
  var diffs = dmp.diff_main(lastResponse, newResponse);
  // Find longest common substring
  var longestMatch = '';
  for (var _i = 0, diffs_1 = diffs; _i < diffs_1.length; _i++) {
    var _a = diffs_1[_i],
      type = _a[0],
      text = _a[1];
    if (type === 0 && text.length > longestMatch.length) {
      longestMatch = text;
    }
  }
  // Calculate similarity ratio
  var matchLength = diffs.reduce(function (sum, _a) {
    var type = _a[0],
      text = _a[1];
    return type === 0 ? sum + text.length : sum;
  }, 0);
  var ratio = (2.0 * matchLength) / (lastResponse.length + newResponse.length);
  return {
    massiveRepetitionDetected: longestMatch.length > 1000,
    ratio: ratio,
    longestMatch: longestMatch,
  };
}
/**
 * Checks for massive repetition using difflib (similar to Python implementation)
 */
function checkRepetitionDifflib(lastResponse, newResponse) {
  var sequenceMatcher = new difflib.SequenceMatcher(
    null,
    lastResponse,
    newResponse,
  );
  var ratio = sequenceMatcher.ratio();
  var match = sequenceMatcher.findLongestMatch(
    0,
    lastResponse.length,
    0,
    newResponse.length,
  );
  var longestMatch = lastResponse.slice(match[0], match[0] + match[2]);
  return {
    massiveRepetitionDetected: longestMatch.length > 1000,
    ratio: ratio,
    longestMatch: longestMatch,
  };
}
/**
 * Example usage with logging:
 */
function logMassiveRepetition(result) {
  if (result.massiveRepetitionDetected) {
    console.error('Repetition ratio: '.concat(result.ratio));
    console.error('Longest matching substring: '.concat(result.longestMatch));
    console.error('Massive repetition detected - stopping process.');
  }
}
// Example usage:
var lastResponse =
  'This is a test response with some content that might be repeated. Here is a long section that could potentially be duplicated multiple times across responses.';
var newResponse =
  'This is a test response with some content that might be repeated. Here is a long section that could potentially be duplicated multiple times across responses. And here is some additional content that makes it different.';
var resultDMP = checkRepetitionDMP(lastResponse, newResponse);
if (resultDMP.massiveRepetitionDetected) {
  logMassiveRepetition(resultDMP);
  // Handle the repetition...
}
var resultDifflib = checkRepetitionDifflib(lastResponse, newResponse);
if (resultDifflib.massiveRepetitionDetected) {
  logMassiveRepetition(resultDifflib);
  // Handle the repetition...
}
