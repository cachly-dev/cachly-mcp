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

## Cachly-MCP Integration

TCO lässt sich direkt als MCP-Toolset in **cachly-mcp** einbinden — Claude kann dann über natürliche Sprache Trips verwalten, Dokumente importieren und den Chaos-Eingang bearbeiten.

### Setup

TCO und Cachly verwenden dieselbe Keycloak-Instanz. Das `CACHLY_JWT` wird direkt als Bearer-Token an die TCO-API weitergeleitet — keine separate Auth nötig.

```bash
# In cachly-mcp env (z.B. .env oder MCP-Config)
TCO_API_URL=http://localhost:8000
```

### Verfügbare MCP Tools

| Tool | Beschreibung |
|---|---|
| `tco_list_trips` | Alle Trips auflisten |
| `tco_create_trip` | Neuen Trip anlegen |
| `tco_get_timeline` | Timeline eines Trips abrufen |
| `tco_delete_trip` | Trip löschen |
| `tco_inbox_list` | Chaos Inbox anzeigen |
| `tco_inbox_assign` | Inbox-Item einem Trip zuweisen |
| `tco_inbox_reject` | Inbox-Item verwerfen |
| `tco_parse_url` | URL mit Ollama parsen und speichern |
| `tco_import_email` | E-Mail-Text importieren |

### Beispiel-Prompts für Claude

```
"Zeig mir meine Reisen"
"Erstelle einen Trip 'Tokyo 2025' vom 1. März bis 15. März"
"Was steht auf meiner Barcelona-Timeline?"
"Ich habe 3 ungelesene Buchungsbestätigungen im Posteingang — weise sie alle dem Paris-Trip zu"
"Importiere diese E-Mail-Bestätigung: [E-Mail einfügen]"
```

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
