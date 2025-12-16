# Small Spaces Analytics System

## Overview

Analytics system for tracking game events from Unreal Engine Blueprints, storing them on the server, and visualizing in an admin dashboard.

## Architecture

```
┌─────────────────────┐     HTTP POST      ┌─────────────────────┐
│   UE5 Game Client   │ ─────────────────► │   Express Server    │
│  (Blueprint Nodes)  │                    │   (Railway)         │
│                     │                    │                     │
│  UAnalyticsClient   │                    │  /api/analytics/*   │
└─────────────────────┘                    └──────────┬──────────┘
                                                      │
                                                      │ HTTP GET
                                                      ▼
                                           ┌─────────────────────┐
                                           │  Admin Dashboard    │
                                           │  /admin             │
                                           └─────────────────────┘
```

## Server API Endpoints

### Event Tracking (No Auth Required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/event` | POST | Track single event |
| `/api/analytics/batch` | POST | Track multiple events |
| `/api/analytics/session/start` | POST | Start a session |
| `/api/analytics/session/end` | POST | End a session |

### Admin Queries (Requires `x-admin-key` header)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/events` | GET | Query events with filters |
| `/api/analytics/sessions` | GET | List sessions |
| `/api/analytics/summary` | GET | Dashboard summary stats |
| `/api/analytics/event-names` | GET | List unique event names |
| `/api/analytics/event-breakdown` | GET | Property value breakdown |
| `/api/analytics/clear` | DELETE | Clear all analytics data |
| `/api/admin/reset-analytics` | DELETE | Clear all analytics data (admin endpoint) |

### Event Schema

```json
{
  "id": "uuid",
  "session_id": "uuid",
  "event_name": "FurniturePlaced",
  "properties": {
    "item_id": "chair_01",
    "room": "Berlin"
  },
  "timestamp": "2025-12-11T10:30:00.000Z",
  "client_version": "1.0.0",
  "platform": "Windows"
}
```

## Storage

File-based JSON storage in `storage/analytics/`:
- `events.json` - All tracked events
- `sessions.json` - Session metadata

## Admin Dashboard

Access at: `https://your-server.railway.app/admin`

Authentication: Enter admin key when prompted (stored in browser localStorage)

Default admin key: `smallspaces-reset-2025` (set via `ADMIN_RESET_KEY` env var)

### Dashboard Tabs

1. **Overview** - Stats cards, 7-day event chart, top events
2. **Breakdown** - Property value distribution per event (bar chart + table)
3. **Events** - Event explorer with filtering
4. **Sessions** - Session list with drill-down

## Dashboard Development

```bash
cd server/dashboard
npm install
npm run dev      # Development server with hot reload
npm run build    # Build for production (outputs to dist/)
```

Built files in `dashboard/dist/` are served by Express at `/admin`.
