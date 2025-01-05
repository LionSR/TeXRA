import xml.etree.ElementTree as ET
import re
from termcolor import cprint
import os


def add_cdata_to_tags(xml_data, tags):
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


# Get the input XML filename
input_xml = "output_multiple.xml"

# Generate the thinking filename
thinking_filename = os.path.splitext(input_xml)[0] + "_thinking.xml"

# Read the XML file
with open(input_xml) as file:
    xml_data = file.read()

# Add CDATA sections to specified tags
tags_to_wrap = ["scratchpad", "document_content"]
xml_data = add_cdata_to_tags(xml_data, tags_to_wrap)

# Add a root element to the XML data
xml_data = f"<root>{xml_data}</root>"

# Parse the XML data
root = ET.fromstring(xml_data)

# Extract and print the scratchpad data
scratchpad = root.find("scratchpad")
print(f"Scratchpad content ({thinking_filename}):")
print("<scratchpad>")
cprint(scratchpad.text.strip(), "blue")
print("</scratchpad>")
print("\n" + "=" * 50 + "\n")

# Save scratchpad content to the thinking file
with open(thinking_filename, "w") as thinking_file:
    thinking_file.write("<scratchpad>\n")
    thinking_file.write(scratchpad.text.strip() + "\n")
    thinking_file.write("</scratchpad>")

print(f"Saved scratchpad content to {thinking_filename}")

# Extract and print the latex documents data
latex_documents = root.find("latex_documents")
for document in latex_documents.findall("document"):
    source = document.find("source").text
    document_content = document.find("document_content")

    print(f"\nLaTeX Document: {source}")
    cprint(document_content.text.strip(), "yellow")
    print("\n" + "=" * 50 + "\n")

    # Save the document content to a .tex file
    with open(source, "w") as tex_file:
        tex_file.write(document_content.text.strip())

    print(f"Saved LaTeX document to {source}")

print("Extraction process completed.")
