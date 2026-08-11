# Small Spaces Design Sharing Server

A Node.js server for sharing interior designs between players.

## IMPORTANT: Repository Structure

⚠️ **This server has its own separate git repository nested within the main Unreal project.**

- **Main Project**: `/SmallSpacesProject/` - Azure DevOps repository with Unreal Engine files
- **Server Only**: `/SmallSpacesProject/server/` - Separate GitHub repository connected to Railway

**For deployment changes:**
1. Navigate to `server/` directory: `cd server/`  
2. Make changes to server files (server.js, package.json, etc.)
3. Commit in the server directory: `git add . && git commit -m "Your message"`
4. Push to GitHub: `git push origin main`
5. Railway automatically deploys from the GitHub repository

**DO NOT** try to push the entire Unreal project - only work within the `/server/` directory for deployment changes.

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
- `POST /api/designs/:id/like` - Like/unlike a design (send `{"increment": 1}` for like, `{"increment": -1}` for unlike)
- `GET /api/thumbnails/:filename` - Get design thumbnail
- `GET /api/health` - Health check

## Storage

- Design files: `storage/designs/`
- Thumbnails: `storage/thumbnails/`
- Metadata: `storage/metadata.json`

## Thumbnail Moderation

Uploaded design thumbnails can be screened by **Azure AI Content Safety** before anything is stored. A flagged image rejects the whole upload with the same generic error the game already shows for failed uploads (the client treats any non-200 as upload failure — no new client work needed).

- Setup: create a **Content Safety** resource in the Azure portal, then set `AZURE_CONTENT_SAFETY_ENDPOINT` and `AZURE_CONTENT_SAFETY_KEY` (see `.env.example`).
- **Tiled analysis**: each thumbnail is checked as the full frame plus a 2x2 tile grid (5 API calls). This is essential — a real incident thumbnail (small explicit posters inside a rendered room) scored severity 0 at full-frame scale but Sexual=6 on its tiles. `MODERATION_TILE_GRID` configures the grid (`0` = full frame only).
- **Cost/tiers**: F0 free tier = 5,000 images/month (≈1,000 uploads at 5 calls each) with a hard stop — past the cap the check fails open until the month resets. S0 = $1.50 per 1,000 images (≈$12–18/month at current volume) with no cap; on S0, `MODERATION_CALL_DELAY_MS=0` removes the free-tier rate-limit pacing. Tier can be changed on the Azure resource without code changes.
- Unconfigured or unreachable → uploads pass through (fail-open) unless `MODERATION_FAIL_CLOSED=1`.
- `MODERATION_SEVERITY_THRESHOLD` (default `2`): Azure rates each category (Hate/SelfHarm/Sexual/Violence) 0/2/4/6; any category at or above the threshold on any tile rejects.
- Rejections are logged to `storage/moderation_rejections.json` (last 500, metadata only — no image data) and to the console for Railway logs.

## Features

- File-based storage (no database required)
- Automatic download counting
- **Image compression**: Thumbnails automatically resized to 400px width and compressed to JPEG (80% quality)
- Compression logging to monitor bandwidth savings
- CORS enabled for local development
- Large file support (50MB limit)