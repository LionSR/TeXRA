import re

from ..utils.file import read_file


def get_xml_format_from_file(file: str) -> str:
    return f'<document name="{file}">\n' f"{read_file(file)}\n" f"</document>"


def get_xml_format_from_files(files: list[str]) -> str:
    return "\n".join(get_xml_format_from_file(file) for file in files) if files else ""


def add_cdata_to_tags(xml_data: str, tags: list[str]) -> str:
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def add_cdata_to_tags_multiple(xml_data: str, tags: list[str]) -> str:
    for tag in tags:
        pattern = f"(<{tag}(?:\\s+[^>]*)?>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def extract_text_from_tags(input_content: str, document_tag: str) -> str:
    match = re.search(rf"<{document_tag}>(.*?)</{document_tag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content


def filter_tags_from_text(content: str, tags: list[str] | str) -> str:
    """Filter out specified XML tags and their content from a string.

    Args:
        content: Input string containing XML tags
        tags: Single tag name or list of tag names to filter out

    Returns:
        String with specified tags and their content removed
    """
    if isinstance(tags, str):
        tags = [tags]

    for tag in tags:
        content = re.sub(rf"<{tag}>.*?</{tag}>\s*", "", content, flags=re.DOTALL)

    return content
