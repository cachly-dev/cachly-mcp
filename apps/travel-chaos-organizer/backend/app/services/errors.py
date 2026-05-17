"""
Actionable error helpers — mirrors cachly's handleApiError pattern.
All user-facing messages include a concrete next step.
"""

from fastapi import HTTPException, status


def ollama_unavailable(url: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            f"Ollama nicht erreichbar unter {url}. "
            "Stelle sicher, dass Ollama läuft und OLLAMA_URL korrekt gesetzt ist."
        ),
    )


def ollama_model_not_found(model: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            f"Ollama-Modell '{model}' nicht gefunden. "
            f"Führe 'ollama pull {model}' auf deinem Server aus."
        ),
    )


def unsupported_file_type(mime: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail=(
            f"Dateityp '{mime}' wird nicht unterstützt. "
            "Unterstützt: application/pdf, image/*, text/*"
        ),
    )


def low_confidence_warning(confidence: float) -> dict:
    return {
        "warning": f"Niedrige Erkennungssicherheit ({confidence:.0%}). "
                   "Bitte parsed_data manuell prüfen.",
        "confidence": confidence,
    }
