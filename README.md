# SQL Schema Viewer

Web-Anwendung, die eine Microsoft-SQL-Server-Datenbank als interaktives ER-Diagramm darstellt.
Server, Instanz, Datenbank und Zugangsdaten werden beim Login manuell eingegeben.

## Funktionen

- **Login-Maske**: Server/Host, Port, Instanz (optional), Datenbank (optional)
- **Authentifizierung**: SQL-Server-Login oder Windows/Domäne (NTLM)
- Optionen „Verbindung verschlüsseln“ und „Serverzertifikat vertrauen“ (für selbstsignierte Zertifikate)
- **Diagramm**: Tabellen mit Spalten, Datentypen, PK/FK, NOT NULL (`*`), Zeilenanzahl
- Beziehungen als Linien mit Krähenfuß-Notation (1:n), Spalte-zu-Spalte verbunden
- Automatisches Layout (horizontal/vertikal), Tabellen per Kopfzeile verschiebbar (Positionen werden im Browser gemerkt)
- Zoom (Mausrad), Verschieben (Hintergrund ziehen), „Einpassen“
- Suche nach Tabellen **und** Spalten (`/` fokussiert die Suche, Enter springt zum ersten Treffer)
- Klick auf eine Tabelle: Nachbartabellen hervorheben, Detailpanel mit Spalten, Defaults, Beziehungen
- **Datenvorschau** (Top 100, nur lesend)
- Filter: Views ein/aus, nur Schlüsselspalten, Tabellen ohne Beziehung ein/aus
- **SVG-Export** des aktuellen Diagramms (z. B. für Dokumentation)
- Datenbank-Auswahl im Kopf (alle DBs, auf die der Login Zugriff hat)
- Hell/Dunkel-Modus nach Systemeinstellung

## Start

### Docker (empfohlen)

```bash
docker compose up -d --build
```

Danach erreichbar unter `http://<host>:3000`. In Portainer als Stack mit der `docker-compose.yml` anlegbar.

### Ohne Docker

```bash
npm install
npm start          # PORT=8080 npm start für anderen Port
```

### Portable Windows-EXE (ohne Installation)

```bash
npm install
npm run build:exe
```

Erzeugt `dist/SQL-Schema-Viewer.exe` (~95 MB, enthält Node.js, Server und Frontend). Die Datei kann einfach in ein
beliebiges Verzeichnis kopiert und per Doppelklick gestartet werden – Node.js muss auf dem Zielrechner nicht installiert sein.
Der Browser öffnet sich automatisch mit `http://localhost:3000`; zum Beenden das Konsolenfenster schließen.
Anderer Port: Umgebungsvariable `PORT` setzen, automatisches Öffnen des Browsers abschalten mit `NO_BROWSER=true`.

## Hinter Nginx Proxy Manager (HTTPS)

Proxy Host auf `sql-schema-viewer:3000` (bzw. Host-IP:3000) anlegen, SSL aktivieren und in der Compose-Datei setzen:

```yaml
TRUST_PROXY: "true"
COOKIE_SECURE: "true"
SESSION_SECRET: "<langer zufälliger Wert>"
```

## Berechtigungen auf dem SQL Server

Für die Schemaanzeige reicht ein Login mit Lesezugriff auf die Metadaten, z. B.:

```sql
CREATE LOGIN schema_viewer WITH PASSWORD = '...';
USE [MeineDB];
CREATE USER schema_viewer FOR LOGIN schema_viewer;
GRANT VIEW DEFINITION TO schema_viewer;     -- Schema sehen
ALTER ROLE db_datareader ADD MEMBER schema_viewer;  -- nur nötig für die Datenvorschau
```

Die Zeilenanzahl stammt aus `sys.partitions` (schnell, ohne `COUNT(*)`).

## Hinweise

- Zugangsdaten liegen nur im Arbeitsspeicher der Server-Sitzung (4 h Gültigkeit), nicht auf der Platte.
  Im Browser werden Server und Benutzername für den nächsten Login vorbelegt, **nie das Passwort**.
- Die App erlaubt Verbindungen zu jedem SQL Server, den der Container erreicht. Daher nur intern
  betreiben bzw. per Proxy/VPN absichern.
- Named Instances (`SERVER\INSTANZ`) benötigen den SQL Server Browser-Dienst (UDP 1434);
  alternativ Instanz leer lassen und den festen Port angeben.
- Bei sehr vielen Spalten werden pro Tabelle maximal 30 im Diagramm gezeigt, alle im Detailpanel.

## Aufbau

```
server.js          Express-Backend (Login, Metadaten aus sys.*-Views, Datenvorschau)
public/index.html  Login + Oberfläche
public/app.js      Diagramm (eigener Renderer, Layout via dagre), Zoom/Pan, Suche, Export
public/style.css   Styles
```
