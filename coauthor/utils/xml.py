import re
import xml.etree.ElementTree as ET

from ..utils.file import read_file


def get_xml_format_from_file(file: str) -> str:
    """Format file content as XML document with filename as attribute."""
    return f'<document name="{file}">\n' f"{read_file(file)}\n" f"</document>"


def get_xml_format_from_files(files: list[str]) -> str:
    """Convert multiple files to XML format, joining with newlines."""
    return "\n".join(get_xml_format_from_file(file) for file in files) if files else ""


def add_cdata_to_tags(xml_data: str, tags: list[str]) -> str:
    """Wrap content of specified tags with CDATA sections."""
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def add_cdata_to_tags_multiple(xml_data: str, tags: list[str]) -> str:
    """Wrap content of specified tags with CDATA sections, handling attributes."""
    for tag in tags:
        pattern = f"(<{tag}(?:\\s+[^>]*)?>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def extract_text_from_tags(input_content: str, documentTag: str) -> str:
    """Extract text between specified XML tags using regex."""
    match = re.search(rf"<{documentTag}>(.*?)</{documentTag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content


def filterTagsFromText(content: str, tags: list[str] | str) -> str:
    """Remove specified XML tags and their content from input string."""
    if isinstance(tags, str):
        tags = [tags]

    for tag in tags:
        content = re.sub(rf"<{tag}>.*?</{tag}>\s*", "", content, flags=re.DOTALL)

    return content


def extract_content_from_tag(root: ET.Element, documentTag: str) -> str | None:
    """Extract content from XML document element."""
    content = root.find(documentTag)
    if content is not None:
        return ET.tostring(content, encoding="unicode", method="text").strip()
    return None
