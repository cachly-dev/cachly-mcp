FROM python:3.12-slim

# system deps for PyMuPDF and python-magic
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install shared monorepo package first (build context = repo root)
COPY packages/telegram-notify /packages/telegram-notify
RUN pip install --no-cache-dir /packages/telegram-notify

COPY apps/travel-chaos-organizer/backend/requirements.txt .
# Strip the file:// line — package is already installed above
RUN grep -v "telegram-notify" requirements.txt | pip install --no-cache-dir -r /dev/stdin

COPY apps/travel-chaos-organizer/backend/app/ ./app/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
