import xml.etree.ElementTree as ET
from termcolor import cprint

with open("polish_prompt2.xml") as file:
    xml_data = file.read()

# Parse the XML data
root = ET.fromstring(xml_data)

# Extract and print the data
prompts = root.find("prompts")
settings = root.find("settings")

system_prompt = prompts.find("system_prompt").text.strip()
user_prefix = prompts.find("user_prefix").text.strip()
user_request = prompts.find("user_request").text.strip()
user_reflect = prompts.find("user_reflect").text.strip()

document_tag = settings.find("document_tag").text.strip()
end_tag = settings.find("end_tag").text.strip()
output_ext = settings.find("output_ext").text.strip()
prefill = settings.get("prefill")

print("\nSettings:")
cprint(f"Document Tag: {document_tag}", "blue")
cprint(f"End Tag: {end_tag}", "blue")
cprint(f"Output Type: {output_ext}", "blue")
cprint(f"Prefill: {prefill}", "blue")

print("System Prompt:")
cprint(system_prompt, "green")
print("\nUser Prefix:")
cprint(user_prefix, "green")
print("\nUser Request:")
cprint(user_request, "green")
print("\nUser Reflect:")
cprint(user_reflect, "green")

cprint("Hello, World!", "white", "on_red")
