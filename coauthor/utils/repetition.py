import difflib

from ..logger import logger


def check_for_massive_repetition(last_response: str, new_response: str) -> bool:
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(0, len(last_response), 0, len(new_response))
    longest_matching_substring = last_response[longest_match.a : longest_match.a + longest_match.size]
    massive_repetition_detected = len(longest_matching_substring) > 1000

    if massive_repetition_detected:
        logger.error(f"Repetition ratio: {repetition_ratio}")
        logger.error(f"Longest matching substring: {longest_matching_substring}")
        logger.error("Massive repetition detected - stopping process.")

    return massive_repetition_detected
