import base64
import sys


def get_base64_encoded_image(image_path: str) -> str:
    """Convert an image file to base64 encoded string.

    Args:
        image_path (str): Path to the image file

    Returns:
        str: Base64 encoded string of the image
    """
    with open(image_path, "rb") as image_file:
        binary_data = image_file.read()
        base_64_encoded_data = base64.b64encode(binary_data)
        base64_string = base_64_encoded_data.decode("utf-8")
        return base64_string


def truncate_base64(base64_string: str, max_length: int = 100) -> str:
    """Truncate a base64 string to specified length and add ellipsis.

    Args:
        base64_string (str): Base64 encoded string to truncate
        max_length (int): Maximum length of truncated string

    Returns:
        str: Truncated base64 string with ellipsis
    """
    if len(base64_string) <= max_length:
        return base64_string
    return base64_string[:max_length] + "..."


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python img2base64.py <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]
    try:
        base64_string = get_base64_encoded_image(image_path)
        truncated = truncate_base64(base64_string)
        print(truncated)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
