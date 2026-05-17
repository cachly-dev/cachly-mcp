# Travel Chaos Organizer

Reisechaos automatisch organisieren — Screenshots, Buchungen, PDFs und Tickets in einer smarten Timeline.

## Stack

| Layer | Tech |
|---|---|
| Mobile | React Native + Expo SDK 52 |
| Auth | Keycloak (self-hosted, OIDC + PKCE) |
| Backend | Python 3.12 + FastAPI |
| Datenbank | PostgreSQL 16 |
| AI Parsing | Ollama (Vision-Modell, konfigurierbar) |
| Offline | expo-sqlite + expo-file-system |

## Architektur

```
Expo App  ──OIDC──►  Keycloak
    │
    └──REST──►  FastAPI Backend
                    │
                    ├── PostgreSQL
                    ├── /data/uploads  (Dateien)
                    └── Ollama API  (AI Parsing)
```

## Lokales Setup

### 1. Voraussetzungen
- Docker + Docker Compose
- Ollama auf eurem Server mit Vision-Modell

### 2. Backend starten

```bash
cd apps/travel-chaos-organizer
cp .env.example .env
# OLLAMA_URL auf euren Server anpassen
docker compose up -d
```

Die API ist dann unter `http://localhost:8000` erreichbar.  
Swagger UI: `http://localhost:8000/docs`  
Keycloak Admin: `http://localhost:8080` (admin/admin)

### 3. Frontend starten

```bash
cd frontend
cp .env.example .env
# EXPO_PUBLIC_API_URL + Keycloak-URLs anpassen
npm install
npm start
```

## API Endpoints

### Trips
| Method | Path | Beschreibung |
|---|---|---|
| GET | `/api/v1/trips` | Alle Trips des Users |
| POST | `/api/v1/trips` | Neuen Trip anlegen |
| GET | `/api/v1/trips/{id}` | Trip Details |
| PATCH | `/api/v1/trips/{id}` | Trip updaten |
| DELETE | `/api/v1/trips/{id}` | Trip löschen |

### Trip Items (Timeline)
| Method | Path | Beschreibung |
|---|---|---|
| GET | `/api/v1/trips/{id}/items` | Timeline-Einträge |
| POST | `/api/v1/trips/{id}/items` | Manuell hinzufügen |
| PATCH | `/api/v1/trips/{id}/items/{item_id}` | Item updaten |
| DELETE | `/api/v1/trips/{id}/items/{item_id}` | Item löschen |

### AI Parsing
| Method | Path | Beschreibung |
|---|---|---|
| POST | `/api/v1/parse/file` | PDF / Bild / Text-Datei parsen |
| POST | `/api/v1/parse/text` | Raw-Text parsen |

### Chaos Inbox
| Method | Path | Beschreibung |
|---|---|---|
| GET | `/api/v1/inbox` | Unsortierten Eingang anzeigen |
| POST | `/api/v1/inbox/{id}/assign` | Item einem Trip zuweisen |
| DELETE | `/api/v1/inbox/{id}` | Item ablehnen |

## Aus dem Repo herauslösen

Das Projekt ist vollständig isoliert in `apps/travel-chaos-organizer/`.
Zum Herauslösen als eigenes Repo:

```bash
# Aus dem Monorepo extrahieren
git subtree split --prefix=apps/travel-chaos-organizer -b standalone-tco
git push <neues-remote> standalone-tco:main
```

Keine Abhängigkeiten zu cachly-mcp Code.

## Datenstruktur

```
trips           user_id, name, start_date, end_date
  └── trip_items  type, title, parsed_data (JSONB), event_at
        └── attachments  file_path, mime_type

chaos_inbox     raw_content, parsed_data, status
  └── attachments
```

## Ollama Modell konfigurieren

In `.env`:
```
OLLAMA_URL=http://dein-server:11434
OLLAMA_MODEL=llama3.2-vision   # oder llava, bakllava, etc.
```

Das Modell muss Vision-Fähigkeit haben für Screenshot-Parsing.
Für reines Text/PDF-Parsing reicht auch ein Text-only Modell.
