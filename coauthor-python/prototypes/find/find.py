with open("1.xml") as file:
    content = file.read()

print("Original content:")
print(repr(content))  # Use repr to show special characters

# Perform the replacement
content = content.replace("\\end{document}\n\n<document name", "\\end{document}\n</document>\n\n<document name")

print("Modified content:")
print(repr(content))  # Use repr to show special characters

with open("1.xml", "w") as file:
    file.write(content)
