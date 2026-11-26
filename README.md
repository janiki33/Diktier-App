# Diktat

Diktier-PWA fürs iPhone. Die Spracherkennung macht iOS-Safari selbst (Web Speech API, `de-CH`), ohne fremden API-Schlüssel. Der Text wird laufend in IndexedDB gesichert, fertige Diktate landen in Vercel Blob und sind per MCP für Claude lesbar. Ohne Spracherkennung (etwa wenn iOS sie in der Homescreen-App sperrt) diktiert man über das Mikrofon der Tastatur.

## Umgebungsvariablen (Vercel)

| Name | Zweck |
|---|---|
| `APP_TOKEN` | Code für die Ablage (einmal im iPhone unter Verlauf > Zugang eingeben) |
| `MCP_TOKEN` | Geheimer Token für `/api/mcp` |
| `BLOB_READ_WRITE_TOKEN` | setzt Vercel beim Verbinden des Blob-Stores |

## Seiten

- `/` App
- `/api/mcp?token=…` MCP-Server mit `list_transcripts` und `get_transcript`

## Test

`npm test`
