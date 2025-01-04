import difflib

from ..logger import logger


def check_for_massive_repetition(lastResponse: str, newResponse: str) -> bool:
    """Check if there is significant text repetition between responses."""
    sequence_matcher = difflib.SequenceMatcher(None, lastResponse, newResponse)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(0, len(lastResponse), 0, len(newResponse))
    longest_matching_substring = lastResponse[longest_match.a : longest_match.a + longest_match.size]
    massive_repetition_detected = len(longest_matching_substring) > 1000

    if massive_repetition_detected:
        logger.error(f"Repetition ratio: {repetition_ratio}")
        logger.error(f"Longest matching substring(preview): {longest_matching_substring[:400]}")
        logger.error("Massive repetition detected - stopping process.")

    return massive_repetition_detected
