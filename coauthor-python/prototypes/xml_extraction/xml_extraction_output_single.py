import xml.etree.ElementTree as ET
from termcolor import cprint
import re
import os


def add_cdata_to_tags(xml_data, tags):
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


# Get the input XML filename
input_xml = "output_single.xml"

# Generate the thinking and LaTeX filenames
base_name = os.path.splitext(input_xml)[0]
thinking_filename = f"{base_name}_thinking.xml"
latex_filename = f"{base_name}.tex"

# Read the XML file
with open(input_xml) as file:
    xml_data = file.read()

# Add CDATA sections to specified tags
tags_to_wrap = ["reflection", "idea", "latex_document"]
xml_data = add_cdata_to_tags(xml_data, tags_to_wrap)

# Add a root element to the XML data
xml_data = f"<root>{xml_data}</root>"

# Parse the XML data
root = ET.fromstring(xml_data)

# Extract and print the data
scratchpad = root.find("scratchpad")
reflection = scratchpad.find("reflection")
idea = scratchpad.find("idea")
latex_document = root.find("latex_document")

print(f"Scratchpad content ({thinking_filename}):")
print("<scratchpad>")
print("<reflection>")
cprint(reflection.text.strip(), "blue")
print("</reflection>")
print("<idea>")
cprint(idea.text.strip(), "green")
print("</idea>")
print("</scratchpad>")

# Save scratchpad content to the thinking file
with open(thinking_filename, "w") as thinking_file:
    thinking_file.write("<scratchpad>\n")
    thinking_file.write("<reflection>\n")
    thinking_file.write(reflection.text.strip() + "\n")
    thinking_file.write("</reflection>\n\n")
    thinking_file.write("<idea>\n")
    thinking_file.write(idea.text.strip() + "\n")
    thinking_file.write("</idea>\n")
    thinking_file.write("</scratchpad>")

print(f"\nSaved scratchpad content to {thinking_filename}")

print("\nLaTeX Document:")
cprint(latex_document.text.strip(), "yellow")

# Save the LaTeX document content to a .tex file
with open(latex_filename, "w") as tex_file:
    tex_file.write(latex_document.text.strip())

print(f"\nSaved LaTeX document to {latex_filename}")

print("\nExtraction process completed.")
