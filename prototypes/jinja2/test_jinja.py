from jinja2 import Template, Environment, meta


def check_template_variables(template_str: str, variables: dict) -> tuple[set[str], set[str]]:
    """
    Check for missing and extra variables in the template.
    Returns (missing_vars, extra_vars)
    """
    env = Environment()
    ast = env.parse(template_str)
    template_vars = meta.find_undeclared_variables(ast)

    provided_vars = set(variables.keys())
    missing_vars = template_vars - provided_vars
    extra_vars = provided_vars - template_vars

    return missing_vars, extra_vars


def read_template(file_path: str) -> str:
    """Read template content from a file."""
    with open(file_path) as f:
        return f.read()


def simple_template_test():
    # Read template from file
    template_str = read_template("template_jinja.txt")

    # Test Case 1: All variables present
    print("Test Case 1: All required variables")
    variables = {
        "title": "My Research Paper",
        "author": "John Doe",
        "year": "2024",
        "content": "This is the main content.",
    }

    # Test Case 2: Missing variables
    print("\nTest Case 2: Missing variables")
    incomplete_vars = {
        "title": "My Research Paper",
        "author": "John Doe",
        # year and content are missing
    }

    # Test Case 3: Extra variables
    print("\nTest Case 3: Extra variables")
    extra_vars = {
        "title": "My Research Paper",
        "author": "John Doe",
        "year": "2024",
        "content": "This is the main content.",
        "keywords": ["AI", "ML"],  # Extra variable
        "abstract": "This is an abstract",  # Extra variable
    }

    # Process each test case
    for case_num, vars_dict in enumerate([variables, incomplete_vars, extra_vars], 1):
        print(f"\nProcessing Case {case_num}:")
        missing, extra = check_template_variables(template_str, vars_dict)

        if missing:
            print(f"Missing variables: {missing}")
        if extra:
            print(f"Extra variables: {extra}")

        try:
            template = Template(template_str)
            result = template.render(**vars_dict)
            print("\nRendered template:")
            print(result)
        except Exception as e:
            print(f"Rendering error: {str(e)}")


if __name__ == "__main__":
    simple_template_test()
