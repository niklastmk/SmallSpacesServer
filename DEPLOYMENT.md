# Small Spaces Server Deployment Guide

## Quick Start (Railway - Recommended)

1. **Create Railway account**: https://railway.app
2. **Connect GitHub**: Link your GitHub account
3. **Push code to GitHub**:
   ```bash
   cd server/
   git init
   git add .
   git commit -m "Initial server setup"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
4. **Deploy on Railway**:
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will automatically detect Node.js and deploy

## Environment Variables (Production)

Set these in your deployment platform:

```
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com
```

## Alternative Platforms

### Render
- Push code to GitHub
- Connect repo to Render
- Uses `render.yaml` configuration automatically

### DigitalOcean App Platform
- Connect GitHub repo
- Auto-detects Node.js
- Set environment variables in dashboard

## Updating Your UE5 Client

Once deployed, update your Unreal Engine client:

1. In Blueprint, call `Set Server URL` with your production URL:
   - Railway: `https://your-app-name.railway.app/api`
   - Render: `https://your-app-name.onrender.com/api`

## Production Features

- ✅ Environment-based configuration
- ✅ CORS protection for your domain
- ✅ Reset endpoint disabled in production
- ✅ Health check endpoint at `/api/health`
- ✅ File storage persistence (depending on platform)

## Testing Your Deployment

1. Visit `https://your-domain.com/api/health`
2. Should return: `{"status":"OK","message":"Small Spaces Design Server is running"}`
3. Test upload/browse from your game

## Cost Estimates

- **Railway**: Free tier (~500 hours/month)
- **Render**: Free tier with limitations
- **DigitalOcean**: ~$5/month for basic droplet

## Next Steps

- Add authentication for user accounts
- Implement rate limiting
- Add design moderation features
- Set up monitoring/analytics