
import xml.etree.ElementTree as ET

# Define the XML structure with dummy data
xml_data = '''<documents>
<document index="1">
<source>annual_report_2023.pdf</source>
<document_content>
ANNUAL_REPORT_CONTENT
</document_content>
</document>
<document index="2">
<source>competitor_analysis_q2.xlsx</source>
<document_content>
COMPETITOR_ANALYSIS_CONTENT
</document_content>
</document>
</documents>'''

# Parse the XML data
root = ET.fromstring(xml_data)

# Extract and print the data
for document in root.findall('document'):
    index = document.get('index')
    source = document.find('source').text
    content = document.find('document_content').text
    print(f"Document Index: {index}")
    print(f"Source: {source}")
    print(f"Content: {content}")
    print()
