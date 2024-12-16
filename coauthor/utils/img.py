import base64
import os
import io
import fitz

from PIL import Image
from typing import List, Optional

from ..logger import logger


def get_base64_encoded_image(image_path: str) -> str:
    """Converts an image file to base64 string."""
    with open(image_path, "rb") as image_file:
        binary_data = image_file.read()
        base_64_encoded_data = base64.b64encode(binary_data)
        base64_string = base_64_encoded_data.decode("utf-8")
        return base64_string


def single_page_pdf_to_png(pdf_path: str, page_num: int = 0, quality: int = 300, max_size: tuple = (1024, 1024)) -> str:
    """Converts a single PDF page to base64-encoded PNG."""
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


def multi_page_pdf_to_png(pdf_path: str, quality: int = 300, max_size: tuple = (1024, 1024), max_pages: int = 100) -> list[str]:
    """Converts multiple PDF pages to base64-encoded PNGs."""
    doc = fitz.open(pdf_path)

    base64_encoded_pngs = []

    for page_num in range(min(doc.page_count, max_pages)):
        base64_encoded = single_page_pdf_to_png(pdf_path, page_num, quality, max_size)
        base64_encoded_pngs.append(base64_encoded)

    doc.close()

    return base64_encoded_pngs


def process_pdf_input(pdf_path: str, max_pages: int | None = None, quality: int | None = None, max_size: tuple | None = None):
    """Processes PDF file and returns base64-encoded PNG(s)."""
    try:
        doc = fitz.open(pdf_path)
        page_count = doc.page_count
        doc.close()

        quality = 300 if quality is None else quality
        max_size = (1024, 1024) if max_size is None else max_size

        if page_count == 1:
            return single_page_pdf_to_png(pdf_path, quality=quality, max_size=max_size)
        else:
            return multi_page_pdf_to_png(pdf_path, quality=quality, max_size=max_size, max_pages=max_pages)
    except (fitz.FileDataError, fitz.EmptyFileError):
        logger.warning(f"The PDF file '{pdf_path}' is empty or non-existent. Skipping this file.")
        return None


def page_count_pdf(pdf_path: str):
    """Returns the number of pages in a PDF file."""
    if os.path.exists(pdf_path):
        doc = fitz.open(pdf_path)
        return doc.page_count
    else:
        return 0
