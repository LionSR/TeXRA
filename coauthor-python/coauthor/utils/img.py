import base64
import os
import io
import fitz

from PIL import Image

from ..logger import logger


def getBase64EncodedImage(image_path: str) -> str:
    """Convert image file to base64 string."""
    with open(image_path, "rb") as image_file:
        binary_data = image_file.read()
        base_64_encoded_data = base64.b64encode(binary_data)
        base64_string = base_64_encoded_data.decode("utf-8")
        return base64_string


def singlePagePdf2Png(pdfPath: str, pageNum: int = 0, quality: int = 300, maxSize: tuple[int, int] = (1024, 1024)) -> str:
    """Convert a single PDF page to base64-encoded PNG with optional resizing."""
    doc = fitz.open(pdfPath)
    page = doc.load_page(pageNum)

    # Render the page as a PNG image
    pix = page.get_pixmap(matrix=fitz.Matrix(300 / 72, 300 / 72))

    # Save the PNG image to a BytesIO object
    image_data = io.BytesIO(pix.tobytes())
    image = Image.open(image_data)

    # Resize the image if it exceeds the maximum size
    if image.size[0] > maxSize[0] or image.size[1] > maxSize[1]:
        image.thumbnail(maxSize, Image.Resampling.LANCZOS)

    # Save the resized image to a BytesIO object
    resized_image_data = io.BytesIO()
    image.save(resized_image_data, format="PNG", optimize=True, quality=quality)
    resized_image_data.seek(0)

    # Encode the image to base64
    base64_encoded = base64.b64encode(resized_image_data.getvalue()).decode("utf-8")

    doc.close()

    return base64_encoded


def multiPagePdf2Png(pdfPath: str, quality: int = 300, maxSize: tuple[int, int] = (1024, 1024), maxPages: int = 100) -> list[str]:
    """Convert multiple PDF pages to base64-encoded PNGs with size and page limits."""
    doc = fitz.open(pdfPath)
    num_pages = min(len(doc), maxPages)
    base64_images = []

    for pageNum in range(num_pages):
        base64_image = singlePagePdf2Png(pdfPath, pageNum, quality, maxSize)
        base64_images.append(base64_image)

    doc.close()
    return base64_images


def processPdfInput(pdfPath: str, maxPages: int | None = None, quality: int | None = None, maxSize: tuple[int, int] | None = None) -> list[str] | str:
    """Process PDF file and return base64-encoded PNG images with configurable settings."""
    if not os.path.exists(pdfPath):
        logger.error(f"PDF file not found: {pdfPath}")
        return []

    quality = quality or 300
    maxSize = maxSize or (1024, 1024)
    maxPages = maxPages or 100

    try:
        pageCount = countPdfPages(pdfPath)
        if pageCount == 1:
            return singlePagePdf2Png(pdfPath, quality=quality, maxSize=maxSize)
        else:
            return multiPagePdf2Png(pdfPath, quality=quality, maxSize=maxSize, maxPages=maxPages)
    except Exception as e:
        logger.error(f"Error processing PDF {pdfPath}: {str(e)}")
        return []


def countPdfPages(pdfPath: str) -> int:
    """Return the number of pages in a PDF file."""
    try:
        doc = fitz.open(pdfPath)
        pageCount = doc.page_count
        doc.close()
        return pageCount
    except Exception as e:
        logger.error(f"Error counting PDF pages in {pdfPath}: {str(e)}")
        return 0
