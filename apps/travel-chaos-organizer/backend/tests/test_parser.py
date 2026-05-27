"""
Unit tests for app/services/parser.py

Covers:
  extract_text_from_pdf – real minimal PDF bytes, multi-page join
  is_image / is_pdf / is_text – mime type routing guards

Run: pytest tests/test_parser.py -v
"""

import pytest
from app.services.parser import extract_text_from_pdf, is_image, is_pdf, is_text


# ── MIME type guards ───────────────────────────────────────────────────────────

def test_is_pdf():
    assert is_pdf("application/pdf") is True
    assert is_pdf("application/octet-stream") is False
    assert is_pdf("image/png") is False


def test_is_image():
    assert is_image("image/jpeg") is True
    assert is_image("image/png") is True
    assert is_image("image/webp") is True
    assert is_image("application/pdf") is False
    assert is_image("text/plain") is False


def test_is_text():
    assert is_text("text/plain") is True
    assert is_text("text/html") is True
    assert is_text("text/csv") is True
    assert is_text("application/pdf") is False
    assert is_text("image/jpeg") is False


# ── PDF extraction ─────────────────────────────────────────────────────────────

def _minimal_pdf(text: str) -> bytes:
    """Creates a minimal valid 1-page PDF containing `text`."""
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    return doc.tobytes()


def test_extract_text_from_pdf_single_page():
    content = _minimal_pdf("Booking confirmation LH400")
    result = extract_text_from_pdf(content)
    assert "LH400" in result
    assert "Booking" in result


def test_extract_text_from_pdf_strips_whitespace():
    content = _minimal_pdf("   some text   ")
    result = extract_text_from_pdf(content)
    assert result == result.strip()


def test_extract_text_from_pdf_multi_page():
    import fitz
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "Page one content")
    doc.new_page().insert_text((72, 72), "Page two content")
    content = doc.tobytes()

    result = extract_text_from_pdf(content)
    assert "Page one" in result
    assert "Page two" in result
