import xml.etree.ElementTree as ET

with open("xml_file.txt", "r") as file:
    xml_data = file.read()

# Parse the XML data
root = ET.fromstring(xml_data)

# Extract and print the data
for document in root.findall("document"):
    index = document.get("index")
    source = document.find("source").text
    content = document.find("document_content").text
    print(f"Document Index: {index}")
    print(f"Source: {source}")
    print(f"Content: {content}")
    print()
