import base64
import os
import io
import fitz

from PIL import Image

from ..logger import logger


def get_base64_encoded_image(image_path: str) -> str:
    """Convert image file to base64 string."""
    with open(image_path, "rb") as image_file:
        binary_data = image_file.read()
        base_64_encoded_data = base64.b64encode(binary_data)
        base64_string = base_64_encoded_data.decode("utf-8")
        return base64_string


def single_page_pdf_to_png(pdf_path: str, page_num: int = 0, quality: int = 300, max_size: tuple[int, int] = (1024, 1024)) -> str:
    """Convert a single PDF page to base64-encoded PNG with optional resizing."""
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


def multi_page_pdf_to_png(pdf_path: str, quality: int = 300, max_size: tuple[int, int] = (1024, 1024), max_pages: int = 100) -> list[str]:
    """Convert multiple PDF pages to base64-encoded PNGs with size and page limits."""
    doc = fitz.open(pdf_path)
    num_pages = min(len(doc), max_pages)
    base64_images = []

    for page_num in range(num_pages):
        base64_image = single_page_pdf_to_png(pdf_path, page_num, quality, max_size)
        base64_images.append(base64_image)

    doc.close()
    return base64_images


def process_pdf_input(
    pdf_path: str, max_pages: int | None = None, quality: int | None = None, max_size: tuple[int, int] | None = None
) -> list[str] | str:
    """Process PDF file and return base64-encoded PNG images with configurable settings."""
    if not os.path.exists(pdf_path):
        logger.error(f"PDF file not found: {pdf_path}")
        return []

    quality = quality or 300
    max_size = max_size or (1024, 1024)
    max_pages = max_pages or 100

    try:
        page_count = count_pdf_pages(pdf_path)
        if page_count == 1:
            return single_page_pdf_to_png(pdf_path, quality=quality, max_size=max_size)
        else:
            return multi_page_pdf_to_png(pdf_path, quality=quality, max_size=max_size, max_pages=max_pages)
    except Exception as e:
        logger.error(f"Error processing PDF {pdf_path}: {str(e)}")
        return []


def count_pdf_pages(pdf_path: str) -> int:
    """Return the number of pages in a PDF file."""
    try:
        doc = fitz.open(pdf_path)
        page_count = doc.page_count
        doc.close()
        return page_count
    except Exception as e:
        logger.error(f"Error counting PDF pages in {pdf_path}: {str(e)}")
        return 0
