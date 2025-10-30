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

## Features

- File-based storage (no database required)
- Automatic download counting
- **Image compression**: Thumbnails automatically resized to 400px width and compressed to JPEG (80% quality)
- Compression logging to monitor bandwidth savings
- CORS enabled for local development
- Large file support (50MB limit)