# Guelph Transit Pulse

Guelph Transit Pulse is a production-quality, mobile-first live transit tracker for Guelph, Ontario. It is built around the official City of Guelph open transit data feeds and designed to be a polished daily-use rider app, not a mock demo.

Important:
- This app uses official City of Guelph open transit data feeds.
- Feed URLs should be copied from the City of Guelph transit open-data page and pasted into local environment variables.
- This app is unofficial and not affiliated with the City of Guelph or Guelph Transit.

Official source page:
- City of Guelph transit GTFS data page: `https://explore.guelph.ca/pages/transit-gtfs-data`

## Features

- Live bus map with Leaflet, OpenStreetMap, and optional satellite imagery
- Official GTFS-Realtime vehicle positions, trip updates, and alerts ingestion on the backend
- Animated vehicle movement between feed refreshes
- Heading-aware vehicle markers
- Stop search by name or stop code
- Live arrivals with route, headsign, ETA, and delay state
- "Bus is X stops away" at the selected stop when derivable from live data
- Route filtering with favorite routes stored in `localStorage`
- Favorite stops stored in `localStorage`
- Nearby transit using browser geolocation
- Most reliable next departure card on the map
- Follow-this-bus mode with next-stop preview
- Address-to-stop lookup using the official City of Guelph address layer
- My Commute mode for direct and one-transfer trip recommendations
- Dark mode and responsive mobile-first layout
- Graceful empty/error/configuration states

## Architecture

### Stack

- Next.js App Router
- React + TypeScript
- Tailwind CSS
- Leaflet
- OpenStreetMap tiles
- Node.js runtime via Next.js route handlers
- `gtfs-realtime-bindings` for protobuf decoding

### Data flow

1. Route handlers under `app/api/*` call a shared transit service.
2. The transit service fetches official GTFS static and GTFS-Realtime feeds from environment-configured URLs.
3. Static GTFS is parsed and indexed server-side.
4. GTFS-Realtime protobuf feeds are decoded and normalized server-side.
5. The frontend consumes clean JSON endpoints instead of raw protobuf.
6. The map animates vehicle positions smoothly between refreshes.

### API surface

- `GET /api/routes`
- `GET /api/vehicles`
- `GET /api/stops?q=...`
- `GET /api/stops/:id/arrivals`
- `GET /api/stops/:id/arrivals?destinationStopId=...`
- `GET /api/alerts`
- `GET /api/nearby?lat=...&lng=...`

## Folder structure

```text
app/
  api/
    alerts/
    nearby/
    routes/
    stops/
    vehicles/
  globals.css
  layout.tsx
  page.tsx
components/
  TransitMap.tsx
  TransitPulseApp.tsx
lib/
  transit/
    config.ts
    csv.ts
    geo.ts
    gtfs-rt.ts
    gtfs-static.ts
    service.ts
    time.ts
    types.ts
  utils/
    api.ts
```

## Environment setup

Copy `.env.example` to `.env.local` and fill in the official City of Guelph feed URLs.

```bash
cp .env.example .env.local
```

Required variables:

```env
GTFS_STATIC_URL=
GTFS_RT_VEHICLE_POSITIONS_URL=
GTFS_RT_TRIP_UPDATES_URL=
GTFS_RT_ALERTS_URL=
GUELPH_ADDRESS_SEARCH_URL=https://services1.arcgis.com/B6yKvIZqzuOr0jBR/ArcGIS/rest/services/Guelph_Addresses_New/FeatureServer/28
CA_ADDRESS_FALLBACK_URL=https://geocode.ca
GEOCODER_AUTOCOMPLETE_URL=https://photon.komoot.io/api
GTFS_REFRESH_INTERVAL_MS=5000
TRANSIT_HISTORY_LOGGING=false
TRANSIT_HISTORY_LOG_DIR=data/ml
TRANSIT_ML_ARTIFACT_PATH=ml/artifacts/arrival_reliability_model.json
NEXT_PUBLIC_LIVE_POLL_INTERVAL_MS=5000
NEXT_PUBLIC_DEFAULT_LAT=43.5448
NEXT_PUBLIC_DEFAULT_LNG=-80.2482
NEXT_PUBLIC_DEFAULT_ZOOM=13
NEXT_PUBLIC_APP_NAME=Guelph Transit Pulse
```

Where to get the feed URLs:

1. Open the official City of Guelph transit open-data page.
2. Copy the latest URLs for:
   - Guelph Transit GTFS Scheduled Data
   - Guelph Transit GTFS-Realtime Vehicle Positions
   - Guelph Transit GTFS-Realtime Trip Updates
   - Guelph Transit GTFS-Realtime Service Alerts
3. Paste them into `.env.local`.

Do not replace these with unofficial mirrors or scraped feeds.

Optional variable:

- `GUELPH_ADDRESS_SEARCH_URL`
  Overrides the official City of Guelph address-points layer used as the primary source for local address lookup.
- `CA_ADDRESS_FALLBACK_URL`
  Overrides the Canada-focused fallback geocoder used only when the official local layer misses a real address.
- `GEOCODER_AUTOCOMPLETE_URL`
  Overrides the free Photon endpoint used only as a fallback if the official local address layer misses a query.
- `TRANSIT_HISTORY_LOGGING`
  Enables NDJSON snapshot logging so you can build a training dataset from live official feeds.
- `TRANSIT_HISTORY_LOG_DIR`
  Directory where the app writes arrival snapshot logs for the ML pipeline.
- `TRANSIT_ML_ARTIFACT_PATH`
  Optional JSON artifact path. If present, the backend blends the trained model into the rule-based reliability score.

## ML Reliability Layer

The app now includes an optional offline ML path for a better "take this bus or wait?" decision.

This is different from the feed ETA:
- GTFS-Realtime ETA tells you the provider's current predicted departure
- the ML layer estimates how trustworthy that ETA is based on historical patterns

What is included:
- live arrival snapshot logging from official feeds
- `pandas` + `scikit-learn` training pipeline in [`ml/README.md`](/Users/khalilbalgobin/Downloads/guelph transit tracker/ml/README.md)
- optional backend artifact loading via `TRANSIT_ML_ARTIFACT_PATH`
- time-based validation so retraining is evaluated on the newest logged window instead of a random split

Recommended operating model:
- log snapshots continuously while the app is running
- retrain offline on a schedule such as nightly or every few days
- review the latest metrics before replacing the existing artifact

Retrain command:

```bash
npm run retrain:ml
```

The retrain script writes a candidate artifact first and only promotes it if validation metrics do not regress beyond the configured tolerance.

## Local development

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm run start
```

Typecheck:

```bash
npm run typecheck
```

## Notes on behavior

- If feed URLs are missing, the app still runs locally but shows a configuration warning and empty live-data responses.
- Static GTFS is cached server-side and refreshed less frequently than realtime feeds.
- Realtime feeds are refreshed periodically and reused across API requests.
- The app now polls the live vehicle path every 5 seconds by default to stay close to the source feed cadence.
- If a feed request fails, the service falls back to the last successful cached response when possible.
- Route reliability is derived from currently observed live trip delays and stale vehicle counts.
- My Commute mode currently focuses on the best next direct trip rather than full multi-transfer trip planning.

## Product disclaimer

Guelph Transit Pulse is an unofficial rider tool for portfolio and local-use purposes. It is not endorsed by, sponsored by, or affiliated with the City of Guelph or Guelph Transit.
