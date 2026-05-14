# Indian Courier Tracking API

A unified REST API that tracks shipments across **12 Indian couriers** from a single endpoint. Give it any AWB / tracking number — it auto-detects the courier and returns normalised status, timeline, events, and location.

Live interactive docs available at **`/docs`** (Swagger UI).

---

## Supported Couriers

| Courier | AWB pattern | Credentials needed? |
|---|---|---|
| Delhivery | 16–22 digit numeric | No |
| Shiprocket | Any (aggregator) | No |
| Ekart | `FMPC…` / `KS…` | No |
| Xpressbees | `XB…` | No |
| Shadowfax | `SFX…` / `SX…` | No |
| Bluedart | 8–11 digit numeric | No (DHL API optional) |
| DTDC | `Z/D/A/B/M` prefix | No |
| Amazon | `ZX…` / tracking URLs | No |
| India Post | `AA000000000IN` format | No |
| Goswift | `GS…` | No |
| FedEx | 12 / 15 / 20–22 digits | No (API key optional) |
| EcomExpress | 10 digit numeric | No (acquired by Delhivery) |

All couriers work out-of-the-box without any credentials. Optional API keys unlock richer data for FedEx, Bluedart (via DHL), and Shiprocket.

---

## Quick Start

### 1. Prerequisites

- **Node.js 18+**
- **npm**

### 2. Install

```bash
git clone <repo-url>
cd trackingorders
npm install
```

### 3. Install Playwright browser (needed for DTDC / India Post fallback)

```bash
npm run install:browsers
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env if you want to add optional API keys (see below)
```

The API works without editing `.env` at all. The `PORT` defaults to `3000`.

### 5. Build & run

```bash
npm run build
npm start
```

Server starts at **`http://localhost:3000`**.

Open **`http://localhost:3000/docs`** for the interactive Swagger UI.

---

## API Endpoints

### `GET /track/:awb`

Auto-detect courier and return tracking data.

```bash
curl http://localhost:3000/track/33827013796811
```

Override courier detection with the `?courier=` query param:

```bash
curl http://localhost:3000/track/90512949074?courier=shiprocket
```

### `POST /track`

```bash
curl -X POST http://localhost:3000/track \
  -H "Content-Type: application/json" \
  -d '{"tracking_number": "33827013796811"}'
```

Optional `courier` field:

```json
{ "tracking_number": "90512949074", "courier": "shiprocket" }
```

### `GET /couriers`

List all supported couriers and their slugs.

```bash
curl http://localhost:3000/couriers
```

### `GET /health`

```bash
curl http://localhost:3000/health
```

---

## Response Format

```json
{
  "tracking_number": "33827013796811",
  "courier": {
    "detected": "Delhivery",
    "slug": "delhivery",
    "confidence": "high"
  },
  "status": {
    "code": "IN_TRANSIT",
    "label": "In Transit",
    "description": "Package picked up successfully.",
    "is_final": false
  },
  "timeline": {
    "pickup_date": "2026-05-13T16:26:08",
    "estimated_delivery": "16 May 2026, Evening",
    "actual_delivery": null,
    "days_in_transit": 1
  },
  "location": {
    "current_city": "Ahmedabad",
    "origin_city": "Ahmedabad",
    "destination_city": "SOUTH"
  },
  "events": [
    {
      "timestamp": "2026-05-13T16:26:08",
      "status": "IN_TRANSIT",
      "description": "Package picked up successfully.",
      "location": "Ahmedabad_Kanera_GW (Gujarat)",
      "city": "Ahmedabad"
    }
  ],
  "flags": {
    "is_rto": false,
    "is_ndr": false,
    "cod_amount": null
  }
}
```

### Status codes

| Code | Meaning |
|---|---|
| `PICKUP_PENDING` | Pickup not yet done |
| `IN_TRANSIT` | Moving through the network |
| `OUT_FOR_DELIVERY` | Out with delivery agent |
| `DELIVERED` | Successfully delivered |
| `EXCEPTION` | Delay / issue |
| `RTO` | Returning to origin |
| `RTO_DELIVERED` | Returned to sender |
| `UNKNOWN` | Status not recognised |

---

## Optional API Keys

Add these to `.env` to unlock richer data. Everything still works without them.

```env
# DHL Developer Portal — covers Bluedart (free at developer.dhl.com)
DHL_CLIENT_ID=
DHL_CLIENT_SECRET=

# FedEx Developer Portal (free at developer.fedex.com)
FEDEX_CLIENT_ID=
FEDEX_CLIENT_SECRET=

# Shiprocket (free account at app.shiprocket.in/register)
SHIPROCKET_EMAIL=
SHIPROCKET_PASSWORD=

# 2Captcha — only needed for DTDC / India Post CAPTCHA fallback (~$3/1000)
TWOCAPTCHA_API_KEY=

# Cache TTL in seconds (default: 300)
CACHE_TTL_SECONDS=300
```

---

## Development

Run with hot-reload (no build step needed):

```bash
npm run dev
```

---

## How auto-detection works

1. The AWB is matched against courier-specific regex patterns (e.g. `FMPC…` → Ekart, `XB…` → Xpressbees).
2. If a **high-confidence** pattern matches, that courier is tried directly.
3. If **multiple low-confidence** patterns match (e.g. 11-digit number could be Bluedart or Shiprocket), all candidates are probed in parallel — first success wins.
4. If **no pattern matches**, all 12 couriers are tried in parallel.
5. If the matched courier(s) return nothing, a **second pass** tries all remaining couriers automatically.

This means you almost never need to pass `?courier=` — it figures it out.

---

## Project structure

```
src/
  index.ts              # Express app entry point
  detector.ts           # AWB pattern → courier mapping
  types.ts              # Shared TypeScript types
  cache.ts              # In-memory TTL cache
  openapi.ts            # OpenAPI 3.0 spec (powers /docs)
  routes/
    track.ts            # Route handlers + resolution logic
  couriers/
    index.ts            # Courier registry
    base.ts             # Shared utilities (normalizeStatus, etc.)
    delhivery.ts
    shiprocket.ts
    ekart.ts
    bluedart.ts
    fedex.ts
    dtdc.ts
    xpressbees.ts
    shadowfax.ts
    amazon.ts
    indiapost.ts
    goswift.ts
    ecomexpress.ts
  scraper/
    browser.ts          # Playwright browser pool
    captcha.ts          # 2Captcha integration
```
