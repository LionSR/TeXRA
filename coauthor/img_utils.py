import base64
from PIL import Image
import os
import io
import fitz

from typing import Union, List


def get_base64_encoded_image(image_path: str) -> str:
    with open(image_path, "rb") as image_file:
        binary_data = image_file.read()
        base_64_encoded_data = base64.b64encode(binary_data)
        base64_string = base_64_encoded_data.decode("utf-8")
        return base64_string


def single_page_pdf_to_png(pdf_path: str, page_num: int = 0, quality: int = 300, max_size: tuple = (1024, 1024)) -> str:
    """
    Convert a single page of a PDF to a PNG image.

    Args:
        pdf_path (str): Path to the PDF file.
        page_num (int): Page number to convert (0-indexed).
        quality (int): Quality of the output PNG image (default: 300).
        max_size (tuple): Maximum size of the output image (default: (1024, 1024)).

    Returns:
        str: Base64 encoded PNG image.
    """
    doc = fitz.open(pdf_path)
    page = doc.load_page(page_num)

    # Render the page as a PNG image
    pix = page.get_pixmap(matrix=fitz.Matrix(300 / 72, 300 / 72))

    # Save the PNG image to a BytesIO object
    image_data = io.BytesIO(pix.tobytes())
    image = Image.open(image_data)

    # Resize the image if it exceeds the maximum size
    if image.size[0] > max_size[0] or image.size[1] > max_size[1]:
        image.thumbnail(max_size, Image.Resampling.LANCZOS)

    # Save the resized image to a BytesIO object
    resized_image_data = io.BytesIO()
    image.save(resized_image_data, format="PNG", optimize=True, quality=quality)
    resized_image_data.seek(0)

    # Encode the image to base64
    base64_encoded = base64.b64encode(resized_image_data.getvalue()).decode("utf-8")

    doc.close()

    return base64_encoded


def multi_page_pdf_to_png(pdf_path: str, quality: int = 300, max_size: tuple = (1024, 1024), max_pages: int = 20) -> List[str]:
    """
    Convert multiple pages of a PDF to PNG images.

    Args:
        pdf_path: str - Path to the PDF file.
        quality: int - Quality of the output PNG images (default: 300).
        max_size: tuple - Maximum size of the output images (default: (1024, 1024)).
        max_pages: int - Maximum number of pages to convert (default: 20).

    Returns:
        List[str] - List of base64 encoded PNG images.
    """
    doc = fitz.open(pdf_path)

    base64_encoded_pngs = []

    for page_num in range(min(doc.page_count, max_pages)):
        base64_encoded = single_page_pdf_to_png(pdf_path, page_num, quality, max_size)
        base64_encoded_pngs.append(base64_encoded)

    doc.close()

    return base64_encoded_pngs


def process_pdf_input(pdf_path: str, is_openai_compatible: bool = False, **kwargs):
    """
    Process a PDF file and return base64 encoded PNG image(s).

    Args:
        pdf_path (str): Path to the PDF file.
        is_openai_compatible (bool): Whether to use OpenAI Compatible API.
        **kwargs: Additional arguments to pass to the conversion functions.

    Returns:
        Union[str, List[str], None]: Base64 encoded PNG image(s) or None if the file is empty or non-existent.
    """
    try:
        doc = fitz.open(pdf_path)
        page_count = doc.page_count
        doc.close()

        if page_count == 1:
            return single_page_pdf_to_png(pdf_path, **kwargs)
        else:
            max_pages = kwargs.get("max_pages", 100 if not is_openai_compatible else float("inf"))
            return multi_page_pdf_to_png(pdf_path, max_pages=max_pages, **kwargs)
    except (fitz.FileDataError, fitz.EmptyFileError):
        print(f"Warning: The PDF file '{pdf_path}' is empty or non-existent. Skipping this file.")
        return None


def page_count_pdf(pdf_path: str) -> int:
    """
    Get the number of pages in a PDF file.

    Args:
        pdf_path (str): Path to the PDF file.

    Returns:
        int: Number of pages in the PDF.
    """
    if os.path.exists(pdf_path):
        doc = fitz.open(pdf_path)
        return doc.page_count
    else:
        return 0
