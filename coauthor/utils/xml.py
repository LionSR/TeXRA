import re
import xml.etree.ElementTree as ET


def addCdataToTags(xml_data: str, tags: list[str]) -> str:
    """Wrap content of specified tags with CDATA sections."""
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def addCdataToTagsMultiple(xml_data: str, tags: list[str]) -> str:
    """Wrap content of specified tags with CDATA sections, handling attributes."""
    for tag in tags:
        pattern = f"(<{tag}(?:\\s+[^>]*)?>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def extractTextFromTag(content: str, documentTag: str) -> str:
    """Extract text between specified XML tags using regex."""
    match = re.search(rf"<{documentTag}>(.*?)</{documentTag}>", content, re.DOTALL)
    return match.group(1) if match else content


def filterTagsFromText(content: str, tags: list[str] | str) -> str:
    """Remove specified XML tags and their content from input string."""
    if isinstance(tags, str):
        tags = [tags]

    for tag in tags:
        content = re.sub(rf"<{tag}>.*?</{tag}>\s*", "", content, flags=re.DOTALL)

    return content


def extractContentFromTag(root: ET.Element, documentTag: str) -> str | None:
    """Extract content from XML document element."""
    content = root.find(documentTag)
    if content is not None:
        return ET.tostring(content, encoding="unicode", method="text").strip()
    return None
