# Small Spaces Design Sharing Server

A Node.js server for sharing interior designs between players.

## Setup

1. **Install Node.js** (if not already installed):
   - Download from https://nodejs.org/

2. **Install dependencies**:
   ```bash
   cd server
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

The server will run on http://localhost:3000

## API Endpoints

- `POST /api/designs` - Upload a new design
- `GET /api/designs?page=0&pageSize=10` - Browse designs
- `POST /api/designs/:id/download` - Download a design (increments counter)
- `GET /api/thumbnails/:filename` - Get design thumbnail
- `GET /api/health` - Health check

## Storage

- Design files: `storage/designs/`
- Thumbnails: `storage/thumbnails/`
- Metadata: `storage/metadata.json`

## Features

- File-based storage (no database required)
- Automatic download counting
- Thumbnail support
- CORS enabled for local development
- Large file support (50MB limit)