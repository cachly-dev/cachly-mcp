"""Extracts raw text from various file types before sending to Ollama."""
import io
from pathlib import Path
import fitz  # PyMuPDF


def extract_text_from_pdf(content: bytes) -> str:
    doc = fitz.open(stream=content, filetype="pdf")
    pages = [page.get_text() for page in doc]
    return "\n".join(pages).strip()


def is_image(mime_type: str) -> bool:
    return mime_type.startswith("image/")


def is_pdf(mime_type: str) -> bool:
    return mime_type == "application/pdf"


def is_text(mime_type: str) -> bool:
    return mime_type.startswith("text/")
