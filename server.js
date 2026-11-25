const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const insights = require('./insights');

// ID format validation — accepts both standard UUIDs (with dashes) and UE-style GUIDs (32 hex chars)
// Prevents path traversal and injection via IDs
const VALID_ID_REGEX = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
function isValidUUID(id) {
    return typeof id === 'string' && VALID_ID_REGEX.test(id);
}
// Try to load Sharp, fallback if not available
let sharp;
try {
    sharp = require('sharp');
    console.log('Sharp image compression enabled');
} catch (error) {
    console.warn('Sharp not available, image compression disabled:', error.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Environment-based configuration
const isDevelopment = process.env.NODE_ENV !== 'production';

// CORS configuration — require ALLOWED_ORIGINS in production, never default to wildcard
const corsOptions = {
    origin: isDevelopment
        ? ['http://localhost:3000', 'http://127.0.0.1:3000']
        : process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-admin-key', 'x-api-key'],
};

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Dashboard has its own CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' } // Allow thumbnail loading
}));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' })); // Large limit for save data + thumbnails
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// The player's IP. On Railway every request arrives from a proxy, so the socket
// IP is the proxy's and is shared by many players. Railway puts the player's IP
// first in X-Forwarded-For; a value the client sends itself does not replace it
// (checked against production, 19 October 2026).
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '')
        || req.socket?.remoteAddress
        || 'unknown';
}

// Rate limiting — general API, per player. Each browse page loads about 21
// thumbnails and an older game version sends a batch up to every 10 s, so one busy player
// can pass 300 requests in 15 minutes; 1000 leaves room for that.
//
// Thumbnails are counted on their own (TD-SERVER-472). The game downloads its
// Showcase thumbnails again on every visit, and how many depends on the player:
// 3 to 176 requests per visit (production, 16 and 17 November 2026). Counted
// together, five visits of 176 used up the 1000 and that player's likes, lists,
// search and downloads were refused until the window ended.
function isThumbnailRequest(req) {
    return req.method === 'GET' && req.originalUrl.startsWith('/api/thumbnails/');
}

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { xForwardedForHeader: false },
    // A signed-in dashboard asks for one card after another and polls its live
    // view; that must not use up the allowance of the same address's game.
    skip: (req) => isThumbnailRequest(req) || insights.isDashboardRequest(req),
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', apiLimiter);

// Thumbnails only, per player: room for about 34 such Showcase visits in
// 15 minutes. Reaching it leaves cards without a picture and nothing else.
const thumbnailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { xForwardedForHeader: false },
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/thumbnails/', thumbnailLimiter);

// Stricter per-player limit for uploads only: new designs and crash reports.
// Downloads, metadata lookups and likes are POSTs too, but only count
// towards the general limit.
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { xForwardedForHeader: false },
    message: { error: 'Too many upload requests, please try again later' }
});

// Shared admin authentication middleware — uses timing-safe comparison to prevent side-channel attacks
function requireAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_RESET_KEY;

    if (!expectedKey) {
        console.error('ADMIN_RESET_KEY not set — admin endpoints disabled');
        return res.status(503).json({ error: 'Admin endpoints not configured' });
    }

    // Signed in to the insights dashboard (server/insights/admin.js).
    if (insights.hasSession(req)) {
        return next();
    }

    if (!adminKey || typeof adminKey !== 'string') {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    // Constant-time comparison prevents timing attacks that could leak the key
    const keyBuffer = Buffer.from(adminKey);
    const expectedBuffer = Buffer.from(expectedKey);
    if (keyBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    next();
}

// Game client authentication middleware — shared secret between game and server
// This blocks casual abuse; a determined attacker can still extract the key from the game binary
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.GAME_API_KEY;

    // If no key configured, skip check (backwards compatible / development)
    if (!expectedKey) {
        return next();
    }

    if (!apiKey || typeof apiKey !== 'string') {
        return res.status(403).json({ error: 'API key required' });
    }

    const keyBuffer = Buffer.from(apiKey);
    const expectedBuffer = Buffer.from(expectedKey);
    if (keyBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
}

// The old dashboard is gone (November 2026); its address leads to the new one.
// Its sign-in cookie held the admin key itself, so it is removed here.
app.use('/admin', (req, res) => {
    res.clearCookie('admin_session');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(410).json({ error: 'Moved to /insights' });
    res.redirect('/insights');
});

// Storage directories - use persistent volume on Railway Pro
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'storage');
const DESIGNS_DIR = path.join(STORAGE_DIR, 'designs');
const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');
const METADATA_FILE = path.join(STORAGE_DIR, 'metadata.json');

const FEATURED_FILE = path.join(STORAGE_DIR, 'featured.json');

// Artist link tracking (in-game partner links -> outbound redirect + click counts)
const ARTISTS_FILE = path.join(STORAGE_DIR, 'artists.json');
const ARTIST_CLICKS_FILE = path.join(STORAGE_DIR, 'artist_clicks.json');
const CLICK_SALT_FILE = path.join(STORAGE_DIR, 'artist_click_salt.txt');

// Ensure storage directories exist
try {
    fs.ensureDirSync(DESIGNS_DIR);
    fs.ensureDirSync(THUMBNAILS_DIR);
    console.log('Storage directories created/verified');
} catch (error) {
    console.error('Failed to create storage directories:', error);
    process.exit(1);
}

// Insights store (Docs/Analytics/REDESIGN_PLAN.md, server/insights/README.md):
// POST /api/v2/collect, POST /api/v2/crashes, GET /api/admin/v2/health and the
// worker thread that owns the database. A failure in here is logged and does
// not stop the server.
insights.mount(app, { storageDir: STORAGE_DIR, requireApiKey, requireAdmin, uploadLimiter, clientIp, rateLimit });

// Initialize metadata file if it doesn't exist
try {
    if (!fs.existsSync(METADATA_FILE)) {
        fs.writeJsonSync(METADATA_FILE, []);
        console.log('Metadata file initialized');
    }
} catch (error) {
    console.error('Failed to initialize metadata file:', error);
    process.exit(1);
}

// Initialize artist link files if they don't exist
try {
    if (!fs.existsSync(ARTISTS_FILE)) {
        fs.writeJsonSync(ARTISTS_FILE, []);
        console.log('Artists file initialized');
    }
    if (!fs.existsSync(ARTIST_CLICKS_FILE)) {
        fs.writeJsonSync(ARTIST_CLICKS_FILE, []);
        console.log('Artist clicks file initialized');
    }
} catch (error) {
    console.error('Failed to initialize artist link files:', error);
    // Non-fatal - artist links are optional
}

// Helper functions
function loadMetadata() {
    try {
        return fs.readJsonSync(METADATA_FILE);
    } catch (error) {
        console.error('Error loading metadata:', error);
        return [];
    }
}

function saveMetadata(metadata) {
    try {
        fs.writeJsonSync(METADATA_FILE, metadata, { spaces: 2 });
    } catch (error) {
        console.error('Error saving metadata:', error);
    }
}

function saveBase64File(base64Data, filename) {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(filename, buffer);
        return true;
    } catch (error) {
        console.error('Error saving file:', error);
        return false;
    }
}

async function compressAndSaveThumbnail(base64Data, filename) {
    // Fallback to original save if Sharp is not available
    if (!sharp) {
        console.log('Sharp not available, saving original thumbnail');
        return saveBase64File(base64Data, filename) ? filename : null;
    }
    
    try {
        const buffer = Buffer.from(base64Data, 'base64');

        // Guard against decompression bombs: check image dimensions before processing
        const metadata = await sharp(buffer).metadata();
        if (metadata.width > 4096 || metadata.height > 4096) {
            console.warn(`Thumbnail rejected: dimensions ${metadata.width}x${metadata.height} exceed 4096px limit`);
            return saveBase64File(base64Data, filename) ? filename : null;
        }

        // Compress only (keep original resolution): 90% quality JPEG
        const compressedBuffer = await sharp(buffer)
            .jpeg({
                quality: 90,
                progressive: true
            })
            .toBuffer();
        
        // Keep .png extension for game compatibility (JPEG data in PNG file)
        fs.writeFileSync(filename, compressedBuffer);
        
        const originalSize = buffer.length;
        const compressedSize = compressedBuffer.length;
        const savings = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
        
        console.log(`Thumbnail compressed: ${(originalSize/1024/1024).toFixed(1)}MB → ${(compressedSize/1024).toFixed(0)}KB (${savings}% savings)`);
        
        return filename;
    } catch (error) {
        console.error('Error compressing thumbnail:', error);
        // Fallback to original save
        return saveBase64File(base64Data, filename) ? filename : null;
    }
}

// ---------------------------------------------------------------------------
// Thumbnail image moderation (Azure AI Content Safety)
// F0 free tier covers 5,000 images/month; current upload volume is well below.
// Not configured (no endpoint/key) → moderation is skipped so the server keeps
// working without an Azure resource. Set MODERATION_FAIL_CLOSED=1 to instead
// reject thumbnail uploads whenever the check cannot run.
// ---------------------------------------------------------------------------
const MODERATION_ENDPOINT = (process.env.AZURE_CONTENT_SAFETY_ENDPOINT || '').replace(/\/+$/, '');
const MODERATION_KEY = process.env.AZURE_CONTENT_SAFETY_KEY || '';
const MODERATION_SEVERITY_THRESHOLD = parseInt(process.env.MODERATION_SEVERITY_THRESHOLD || '2', 10);
const MODERATION_FAIL_CLOSED = process.env.MODERATION_FAIL_CLOSED === '1';
const MODERATION_LOG_FILE = path.join(STORAGE_DIR, 'moderation_rejections.json');
// Tiling: small explicit details (e.g. custom images in art frames) get diluted
// at full-frame scale and score severity 0 — verified with a real incident image
// that scored 0 whole but Sexual=6 on its 2x2 tiles. Each thumbnail is checked
// as the full frame plus a COLSxROWS tile grid ('0' disables tiling).
const MODERATION_TILE_GRID = (process.env.MODERATION_TILE_GRID || '2x2').toLowerCase();
// The F0 free tier allows roughly 1 request/second, so calls are spaced out.
const MODERATION_CALL_DELAY_MS = parseInt(process.env.MODERATION_CALL_DELAY_MS || '1100', 10);

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareImageForModeration(base64Data) {
    // Azure Content Safety caps input at 2048x2048 / 4MB — downscale bigger
    // images for the moderation call only (the stored thumbnail is untouched).
    let buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!sharp) return buffer;
    try {
        const metadata = await sharp(buffer).metadata();
        if (metadata.width > 2048 || metadata.height > 2048 || buffer.length > 4 * 1024 * 1024) {
            buffer = await sharp(buffer)
                .resize(1024, 1024, { fit: 'inside' })
                .jpeg({ quality: 85 })
                .toBuffer();
        }
    } catch (error) {
        console.warn('Moderation pre-resize failed, sending original image:', error.message);
    }
    return buffer;
}

async function buildModerationPieces(base64Data) {
    const fullBuffer = await prepareImageForModeration(base64Data);
    const pieces = [{ label: 'full', buffer: fullBuffer }];
    const gridMatch = MODERATION_TILE_GRID.match(/^(\d)x(\d)$/);
    if (!sharp || !gridMatch) return pieces;
    const cols = parseInt(gridMatch[1], 10);
    const rows = parseInt(gridMatch[2], 10);
    if (cols * rows <= 1) return pieces;
    try {
        const metadata = await sharp(fullBuffer).metadata();
        const tileWidth = Math.floor(metadata.width / cols);
        const tileHeight = Math.floor(metadata.height / rows);
        if (tileWidth < 50 || tileHeight < 50) return pieces; // Azure minimum input size
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const buffer = await sharp(fullBuffer)
                    .extract({ left: col * tileWidth, top: row * tileHeight, width: tileWidth, height: tileHeight })
                    .jpeg({ quality: 90 })
                    .toBuffer();
                pieces.push({ label: `tile ${col},${row}`, buffer });
            }
        }
    } catch (error) {
        console.warn('Moderation tiling failed, using full frame only:', error.message);
    }
    return pieces;
}

async function analyzeImagePiece(buffer) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await fetch(`${MODERATION_ENDPOINT}/contentsafety/image:analyze?api-version=2024-09-01`, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': MODERATION_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: { content: buffer.toString('base64') },
                outputType: 'FourSeverityLevels'
            }),
            signal: AbortSignal.timeout(10000)
        });
        if (response.status === 429 && attempt === 1) {
            await sleepMs(2000);
            continue;
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error(`Image moderation API error ${response.status}: ${errorText.slice(0, 300)}`);
            return { ok: false, status: response.status };
        }
        const result = await response.json();
        return {
            ok: true,
            categories: (result.categoriesAnalysis || []).map(c => ({ category: c.category, severity: c.severity }))
        };
    }
    return { ok: false, status: 429 };
}

async function moderateImage(base64Data) {
    if (!MODERATION_ENDPOINT || !MODERATION_KEY) {
        return { checked: false, flagged: false };
    }
    try {
        const pieces = await buildModerationPieces(base64Data);
        let allChecked = true;
        for (let i = 0; i < pieces.length; i++) {
            if (i > 0 && MODERATION_CALL_DELAY_MS > 0) {
                await sleepMs(MODERATION_CALL_DELAY_MS);
            }
            const verdict = await analyzeImagePiece(pieces[i].buffer);
            if (!verdict.ok) {
                allChecked = false;
                if (verdict.status === 429) break; // rate/quota exhausted — don't stall the upload on retries
                continue;
            }
            const flaggedCategories = verdict.categories.filter(c => c.severity >= MODERATION_SEVERITY_THRESHOLD);
            if (flaggedCategories.length > 0) {
                return {
                    checked: true,
                    flagged: true,
                    categories: verdict.categories,
                    reason: `${flaggedCategories.map(c => `${c.category}=${c.severity}`).join(', ')} [${pieces[i].label}]`
                };
            }
        }
        return { checked: allChecked, flagged: false };
    } catch (error) {
        console.error('Image moderation call failed:', error.message);
        return { checked: false, flagged: false };
    }
}

function logModerationRejection(entry) {
    // Best-effort audit trail so rejected uploads can be reviewed (no image data stored)
    try {
        let log = [];
        try { log = fs.readJsonSync(MODERATION_LOG_FILE); } catch (error) { /* first write */ }
        log.push(entry);
        if (log.length > 500) log = log.slice(-500);
        fs.writeJsonSync(MODERATION_LOG_FILE, log, { spaces: 2 });
    } catch (error) {
        console.error('Failed to write moderation rejection log:', error);
    }
}

// API Routes

// Upload design
app.post('/api/designs', uploadLimiter, requireApiKey, async (req, res) => {
    try {
        const { designId, title, description, authorName, level, saveData, thumbnail, christmasEvent } = req.body;


        // Validate required fields
        if (!title || !saveData) {
            return res.status(400).json({ error: 'Title and saveData are required' });
        }

        // Input length validation
        if (typeof title !== 'string' || title.length > 200) {
            return res.status(400).json({ error: 'Title must be a string under 200 characters' });
        }
        if (description && (typeof description !== 'string' || description.length > 2000)) {
            return res.status(400).json({ error: 'Description must be under 2000 characters' });
        }
        if (authorName && (typeof authorName !== 'string' || authorName.length > 100)) {
            return res.status(400).json({ error: 'Author name must be under 100 characters' });
        }

        // Use provided designId or generate new one — validate format to prevent path traversal
        if (designId && !isValidUUID(designId)) {
            return res.status(400).json({ error: 'Invalid designId format (must be UUID)' });
        }
        const finalDesignId = designId || uuidv4();
        const designFilename = `${finalDesignId}.sav`;
        const designPath = path.join(DESIGNS_DIR, designFilename);

        // Moderate the thumbnail before anything is stored. The game client
        // treats any non-200 as its normal upload-failure path, so a rejection
        // needs no dedicated error message.
        if (thumbnail) {
            const moderation = await moderateImage(thumbnail);
            if (moderation.flagged) {
                console.warn(`Upload rejected by image moderation: "${title}" by ${authorName || 'Anonymous'} (ID: ${finalDesignId}) — ${moderation.reason}`);
                logModerationRejection({
                    date: new Date().toISOString(),
                    design_id: finalDesignId,
                    title: title,
                    author_name: authorName || 'Anonymous',
                    categories: moderation.categories
                });
                return res.status(400).json({ error: 'Upload failed' });
            }
            if (!moderation.checked && MODERATION_FAIL_CLOSED) {
                console.warn(`Upload rejected: moderation unavailable and MODERATION_FAIL_CLOSED is set (ID: ${finalDesignId})`);
                return res.status(400).json({ error: 'Upload failed' });
            }
        }

        // Save design file (always overwrite)
        if (!saveBase64File(saveData, designPath)) {
            return res.status(500).json({ error: 'Failed to save design file' });
        }

        // Save and compress thumbnail if provided (always overwrite)
        let thumbnailUrl = null;
        if (thumbnail) {
            const thumbnailFilename = `${finalDesignId}.png`;
            const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename);
            
            // Use compression for new thumbnails
            const savedThumbnailPath = await compressAndSaveThumbnail(thumbnail, thumbnailPath);
            if (savedThumbnailPath) {
                const savedFilename = path.basename(savedThumbnailPath);
                thumbnailUrl = `/api/thumbnails/${savedFilename}`;
            }
        }

        // Check if design already exists (update vs create)
        const allMetadata = loadMetadata();
        const existingIndex = allMetadata.findIndex(d => d.id === finalDesignId);
        
        if (existingIndex !== -1) {
            // Update existing design (preserve download_count)
            const existingDesign = allMetadata[existingIndex];
            allMetadata[existingIndex] = {
                id: finalDesignId,
                title: title || 'Untitled Design',
                description: description || '',
                author_name: authorName || 'Anonymous',
                level: level || '',
                download_count: existingDesign.download_count, // Preserve download count
                upload_date: new Date().toISOString(), // Update to current time
                thumbnail_url: thumbnailUrl || existingDesign.thumbnail_url, // Use new thumbnail or keep existing
                christmas_event: christmasEvent === true // Boolean flag for Christmas event designs
            };
            console.log(`Design updated: ${title} by ${authorName} (ID: ${finalDesignId})${christmasEvent ? ' [Christmas Event]' : ''}`);
        } else {
            // Create new design
            const designMetadata = {
                id: finalDesignId,
                title: title || 'Untitled Design',
                description: description || '',
                author_name: authorName || 'Anonymous',
                level: level || '',
                download_count: 0,
                upload_date: new Date().toISOString(),
                thumbnail_url: thumbnailUrl,
                christmas_event: christmasEvent === true // Boolean flag for Christmas event designs
            };
            allMetadata.push(designMetadata);
            console.log(`Design created: ${title} by ${authorName} (ID: ${finalDesignId})${christmasEvent ? ' [Christmas Event]' : ''}`);
        }
        
        saveMetadata(allMetadata);

        const isUpdate = existingIndex !== -1;
        res.json({ 
            success: true, 
            design_id: finalDesignId,
            updated: isUpdate,
            message: isUpdate ? 'Design updated successfully' : 'Design uploaded successfully' 
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Browse designs
app.get('/api/designs', requireApiKey, (req, res) => {
    try {
        let allMetadata = loadMetadata();

        // Get sort parameter (default to date sorting for backward compatibility)
        const sortMode = req.query.sort || 'date';

        // Get search query parameter
        const searchQuery = req.query.search;

        // Get level filter parameter (single string)
        const levelFilter = req.query.level;

        // Get level filters parameter (JSON array of strings for localized level names)
        let levelFilters = null;
        if (req.query.levelFilters) {
            try {
                levelFilters = JSON.parse(req.query.levelFilters);
                if (!Array.isArray(levelFilters)) {
                    levelFilters = null;
                }
            } catch (e) {
                // Invalid JSON, ignore
                levelFilters = null;
            }
        }

        // Get date filter parameter (fromDate)
        const fromDate = req.query.fromDate;

        // Get Christmas event filter (true = only Christmas designs, false = exclude them, omit = all)
        const christmasEventFilter = req.query.christmasEvent;

        // Log request summary (not user-supplied data)
        if (isDevelopment) {
            console.log(`Browse request: sort=${sortMode}, hasSearch=${!!searchQuery}, hasLevel=${!!levelFilter}`);
        }

        // Filter by search query if provided
        if (searchQuery && searchQuery.trim() !== '') {
            const searchLower = searchQuery.toLowerCase().trim();
            allMetadata = allMetadata.filter(design => {
                const titleMatch = design.title.toLowerCase().includes(searchLower);
                const authorMatch = design.author_name.toLowerCase().includes(searchLower);
                return titleMatch || authorMatch;
            });
        }

        // Filter by level - supports both single level and array of localized level names
        if (levelFilters && levelFilters.length > 0) {
            // Use array of filters (for localized level names)
            allMetadata = allMetadata.filter(design => {
                if (!design.level) return false;
                // Match if design.level contains ANY of the filter strings
                return levelFilters.some(filter => design.level.includes(filter));
            });
        } else if (levelFilter && levelFilter.trim() !== '') {
            // Fallback to single level filter (backward compatible)
            allMetadata = allMetadata.filter(design => {
                // Support both exact match and partial match (for flexibility)
                return design.level && design.level.includes(levelFilter);
            });
        }

        // Filter by date if provided (only show designs from this date onwards)
        if (fromDate && fromDate.trim() !== '') {
            const filterDate = new Date(fromDate);
            if (!isNaN(filterDate.getTime())) {
                allMetadata = allMetadata.filter(design => {
                    const designDate = new Date(design.upload_date);
                    return designDate >= filterDate;
                });
            }
        }

        // Filter by Christmas event flag if provided
        if (christmasEventFilter !== undefined && christmasEventFilter !== '') {
            const wantChristmas = christmasEventFilter === 'true' || christmasEventFilter === true;
            allMetadata = allMetadata.filter(design => {
                // Treat missing/undefined christmas_event as false (backward compatible)
                const isChristmas = design.christmas_event === true;
                return wantChristmas ? isChristmas : !isChristmas;
            });
        }

        // Sort based on the specified mode
        if (sortMode === 'downloads') {
            // Sort by download count (highest first), then by upload date (newest first)
            allMetadata.sort((a, b) => {
                if (b.download_count !== a.download_count) {
                    return b.download_count - a.download_count;
                }
                return new Date(b.upload_date) - new Date(a.upload_date);
            });
        } else {
            // Default: Sort by upload date (newest first)
            allMetadata.sort((a, b) => new Date(b.upload_date) - new Date(a.upload_date));
        }

        // ALWAYS return ALL designs (filtered if search/level/date provided) - no pagination
        let logMessage = `Browse request: returning ${allMetadata.length} designs`;
        if (searchQuery) logMessage += `, search="${searchQuery}"`;
        if (levelFilters) logMessage += `, levelFilters=[${levelFilters.join(', ')}]`;
        else if (levelFilter) logMessage += `, level="${levelFilter}"`;
        if (fromDate) logMessage += `, fromDate="${fromDate}"`;
        if (christmasEventFilter !== undefined && christmasEventFilter !== '') logMessage += `, christmasEvent=${christmasEventFilter}`;
        logMessage += `, sort=${sortMode}`;
        console.log(logMessage);

        res.json({
            designs: allMetadata,
            total: allMetadata.length
        });

    } catch (error) {
        console.error('Browse error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get top downloaded designs
app.get('/api/designs/top', requireApiKey, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 3, 50);
        
        const allMetadata = loadMetadata();
        
        // Sort by download count (highest first), then by upload date (newest first)
        allMetadata.sort((a, b) => {
            if (b.download_count !== a.download_count) {
                return b.download_count - a.download_count;
            }
            return new Date(b.upload_date) - new Date(a.upload_date);
        });
        
        // Take the top designs
        const topDesigns = allMetadata.slice(0, limit);
        
        res.json({
            designs: topDesigns,
            total: allMetadata.length,
            limit: limit
        });
        
    } catch (error) {
        console.error('Top designs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Download design (POST to increment counter)
app.post('/api/designs/:id/download', requireApiKey, (req, res) => {
    try {
        const designId = req.params.id;
        if (!isValidUUID(designId)) {
            return res.status(400).json({ error: 'Invalid design ID format' });
        }
        const designPath = path.join(DESIGNS_DIR, `${designId}.sav`);

        if (!fs.existsSync(designPath)) {
            return res.status(404).json({ error: 'Design not found' });
        }

        // Increment download counter and get metadata
        const allMetadata = loadMetadata();
        const designIndex = allMetadata.findIndex(d => d.id === designId);
        let designMetadata = null;

        if (designIndex !== -1) {
            allMetadata[designIndex].download_count += 1;
            designMetadata = allMetadata[designIndex];
            saveMetadata(allMetadata);
        }

        // Read and return design file (explicitly as binary)
        const designData = fs.readFileSync(designPath);
        const base64Data = Buffer.from(designData).toString('base64');

        console.log(`Design downloaded: ${designId}`);

        // Return complete metadata along with save data
        const response = {
            saveData: base64Data,
            designId: designId,
            id: designId // Include both for compatibility
        };

        // Add metadata if found
        if (designMetadata) {
            response.title = designMetadata.title;
            response.description = designMetadata.description;
            response.author_name = designMetadata.author_name;
            response.level = designMetadata.level;
            response.download_count = designMetadata.download_count;
            response.upload_date = designMetadata.upload_date;
            response.thumbnail_url = designMetadata.thumbnail_url;
            response.christmas_event = designMetadata.christmas_event === true; // Default to false if missing
        }

        res.json(response);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Binary download endpoint (no Base64 overhead) - MUCH faster for large saves
app.post('/api/designs/:id/download/binary', requireApiKey, (req, res) => {
    try {
        const designId = req.params.id;
        if (!isValidUUID(designId)) {
            return res.status(400).json({ error: 'Invalid design ID format' });
        }
        const designPath = path.join(DESIGNS_DIR, `${designId}.sav`);

        if (!fs.existsSync(designPath)) {
            return res.status(404).json({ error: 'Design not found' });
        }

        // Increment download counter and get metadata
        const allMetadata = loadMetadata();
        const designIndex = allMetadata.findIndex(d => d.id === designId);
        let designMetadata = null;

        if (designIndex !== -1) {
            allMetadata[designIndex].download_count += 1;
            designMetadata = allMetadata[designIndex];
            saveMetadata(allMetadata);
        }

        // Send metadata as JSON header (Base64-encoded for non-Latin character support)
        if (designMetadata) {
            const metadataJson = JSON.stringify({
                designId: designId,
                id: designId,
                title: designMetadata.title,
                description: designMetadata.description,
                author_name: designMetadata.author_name,
                level: designMetadata.level,
                download_count: designMetadata.download_count,
                upload_date: designMetadata.upload_date,
                thumbnail_url: designMetadata.thumbnail_url,
                christmas_event: designMetadata.christmas_event === true // Default to false if missing
            });
            // Base64 encode to support Chinese, Japanese, Korean, and other non-ASCII characters
            const metadataBase64 = Buffer.from(metadataJson, 'utf8').toString('base64');
            res.setHeader('X-Design-Metadata', metadataBase64);
        }

        // Send binary file directly (no Base64 conversion)
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', fs.statSync(designPath).size);

        console.log(`Design downloaded (binary): ${designId} (${(fs.statSync(designPath).size / 1024).toFixed(0)}KB)`);

        res.sendFile(designPath);

    } catch (error) {
        console.error('Binary download error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get metadata for multiple designs by IDs (no save data download)
app.post('/api/designs/metadata', requireApiKey, (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids) {
            return res.status(400).json({ error: 'Missing ids field in request body' });
        }

        if (!Array.isArray(ids)) {
            return res.status(400).json({ error: 'ids field must be an array' });
        }

        if (ids.length === 0) {
            return res.status(400).json({ error: 'Empty IDs array' });
        }

        if (ids.length > 100) {
            return res.status(400).json({ error: 'Too many IDs (max 100)' });
        }

        console.log(`Metadata request for ${ids.length} design(s)`);

        // Load all metadata
        const allMetadata = loadMetadata();

        // Filter to only the requested IDs
        const requestedMetadata = allMetadata.filter(design => ids.includes(design.id));

        // Return metadata in same format as browse endpoint
        const designs = requestedMetadata.map(design => ({
            id: design.id,
            designId: design.id,
            title: design.title,
            description: design.description,
            author_name: design.author_name,
            level: design.level,
            download_count: design.download_count,
            upload_date: design.upload_date,
            thumbnail_url: design.thumbnail_url,
            christmas_event: design.christmas_event === true // Default to false if missing
        }));

        res.json({ designs });

    } catch (error) {
        console.error('Get metadata error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// Featured designs — remote-editable list of design IDs the game pulls on
// startup to populate the Online Showcase / featured section without shipping
// a game update. Stored as a JSON array of strings in storage/featured.json.
// Player endpoint is GET (API-key gated); update is POST (admin-key gated).
// ============================================================================

// GET /api/featured — returns { ids: [...] }. Empty array if no file yet.
app.get('/api/featured', requireApiKey, (req, res) => {
    try {
        if (!fs.existsSync(FEATURED_FILE)) {
            return res.json({ ids: [] });
        }
        const raw = fs.readFileSync(FEATURED_FILE, 'utf8');
        const ids = JSON.parse(raw);
        if (!Array.isArray(ids)) {
            console.error('featured.json is not an array — returning empty list');
            return res.json({ ids: [] });
        }
        res.json({ ids });
    } catch (error) {
        console.error('Featured fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/featured/admin — admin-gated read of the same list (the public GET
// is api-key gated, so the dashboard which uses admin auth needs its own read path).
app.get('/api/featured/admin', requireAdmin, (req, res) => {
    try {
        if (!fs.existsSync(FEATURED_FILE)) {
            return res.json({ ids: [] });
        }
        const raw = fs.readFileSync(FEATURED_FILE, 'utf8');
        const ids = JSON.parse(raw);
        res.json({ ids: Array.isArray(ids) ? ids : [] });
    } catch (error) {
        console.error('Featured admin fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/featured/admin — body: { ids: ["...", "..."] }. Replaces the
// entire featured list. Admin-key gated.
app.post('/api/featured/admin', requireAdmin, (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids)) {
            return res.status(400).json({ error: 'ids field must be an array of strings' });
        }
        if (ids.some(id => typeof id !== 'string')) {
            return res.status(400).json({ error: 'all ids must be strings' });
        }
        if (ids.length > 200) {
            return res.status(400).json({ error: 'too many ids (max 200)' });
        }
        fs.writeFileSync(FEATURED_FILE, JSON.stringify(ids, null, 2), 'utf8');
        console.log(`Featured list updated — ${ids.length} id(s)`);
        res.json({ ok: true, count: ids.length });
    } catch (error) {
        console.error('Featured update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// ARTIST LINKS — outbound redirect + click tracking
// ============================================
//
// The game ships ONE stable link per artist: /go/<slug>?p=<placement>
// This endpoint looks the slug up, appends UTM parameters, and 302s to the
// artist's shop. Two reasons it exists instead of a hardcoded URL in the build:
//   1. A link inside a shipped Steam build is permanent — this lets the
//      destination change (rebrand, new shop, ended collab) without a patch.
//   2. It is the only place we can count clicks ourselves.
//
// Privacy: no cookies are set, and raw IPs are never stored. The IP is folded
// into a salted, DAILY-ROTATING hash used only to tell repeat clicks apart.

const CLICK_UTM_SOURCE = 'smallspaces';
const CLICK_UTM_MEDIUM = 'game';
const CLICK_DEFAULT_CAMPAIGN = 'artist-showcase';
const CLICK_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // repeat click by same visitor inside this window is not "unique"
const MAX_CLICK_RECORDS = 50000;               // oldest records are trimmed past this
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ARTISTS = 100;

// User agents that are link-preview bots, not players. Discord/Slack/Steam chat
// all fetch a link the moment it is posted — without this the counts are fiction.
const BOT_UA_PATTERNS = [
    /bot/i, /crawl/i, /spider/i, /slurp/i, /preview/i, /curl/i, /wget/i,
    /python-requests/i, /headless/i, /discord/i, /slack/i, /telegram/i,
    /whatsapp/i, /facebookexternalhit/i, /embedly/i, /monitor/i, /uptime/i,
    /scrapy/i, /okhttp/i, /go-http-client/i
];

function isBotUserAgent(ua) {
    if (!ua || typeof ua !== 'string' || ua.length < 10) return true;
    return BOT_UA_PATTERNS.some(re => re.test(ua));
}

// Salt for the visitor hash. Persisted so dedupe survives a redeploy; set
// CLICK_HASH_SALT to control it explicitly. Never leaves the server.
let cachedClickSalt = null;
function getClickSalt() {
    if (cachedClickSalt) return cachedClickSalt;
    if (process.env.CLICK_HASH_SALT) {
        cachedClickSalt = process.env.CLICK_HASH_SALT;
        return cachedClickSalt;
    }
    try {
        if (fs.existsSync(CLICK_SALT_FILE)) {
            const stored = fs.readFileSync(CLICK_SALT_FILE, 'utf8').trim();
            if (stored) {
                cachedClickSalt = stored;
                return cachedClickSalt;
            }
        }
        const generated = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(CLICK_SALT_FILE, generated, 'utf8');
        cachedClickSalt = generated;
    } catch (error) {
        console.error('Could not persist click salt, using in-memory salt:', error.message);
        cachedClickSalt = crypto.randomBytes(32).toString('hex');
    }
    return cachedClickSalt;
}

// One-way, daily-rotating visitor fingerprint. Not reversible to an IP, and not
// linkable across days — enough to dedupe a double-click, nothing more.
function visitorHash(req, slug) {
    const ip = clientIp(req);
    const day = new Date().toISOString().slice(0, 10);
    return crypto.createHash('sha256')
        .update(`${getClickSalt()}|${day}|${ip}|${slug}`)
        .digest('hex')
        .slice(0, 16);
}

function loadArtists() {
    try {
        const list = fs.readJsonSync(ARTISTS_FILE);
        return Array.isArray(list) ? list : [];
    } catch (error) {
        console.error('Error loading artists:', error);
        return [];
    }
}

function saveArtists(artists) {
    fs.writeJsonSync(ARTISTS_FILE, artists, { spaces: 2 });
}

function loadArtistClicks() {
    try {
        const list = fs.readJsonSync(ARTIST_CLICKS_FILE);
        return Array.isArray(list) ? list : [];
    } catch (error) {
        console.error('Error loading artist clicks:', error);
        return [];
    }
}

function saveArtistClicks(clicks) {
    try {
        fs.writeJsonSync(ARTIST_CLICKS_FILE, clicks, { spaces: 2 });
    } catch (error) {
        console.error('Error saving artist clicks:', error);
    }
}

// Placement = which in-game screen the button was on. Kept to a strict charset
// because it is echoed into the destination URL as utm_content.
function sanitizePlacement(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    return cleaned;
}

function buildDestinationUrl(artist, placement, clickId) {
    const url = new URL(artist.destination);
    url.searchParams.set('utm_source', CLICK_UTM_SOURCE);
    url.searchParams.set('utm_medium', CLICK_UTM_MEDIUM);
    url.searchParams.set('utm_campaign', artist.utm_campaign || CLICK_DEFAULT_CAMPAIGN);
    if (placement) url.searchParams.set('utm_content', placement);
    url.searchParams.set('ss_click', clickId);
    return url.toString();
}

// Validate an incoming artist list. The destination check is load-bearing:
// /go/:slug is a redirect, so an unvalidated destination would turn it into an
// open redirect usable for phishing.
function validateArtists(list) {
    if (!Array.isArray(list)) return { ok: false, error: 'artists must be an array' };
    if (list.length > MAX_ARTISTS) return { ok: false, error: `too many artists (max ${MAX_ARTISTS})` };

    const seen = new Set();
    const cleaned = [];

    for (const entry of list) {
        if (!entry || typeof entry !== 'object') return { ok: false, error: 'each artist must be an object' };

        const slug = String(entry.slug || '').trim().toLowerCase();
        if (!SLUG_REGEX.test(slug)) {
            return { ok: false, error: `invalid slug "${entry.slug}" (lowercase letters, numbers and dashes, max 32)` };
        }
        if (seen.has(slug)) return { ok: false, error: `duplicate slug "${slug}"` };
        seen.add(slug);

        const destination = String(entry.destination || '').trim();
        let parsed;
        try {
            parsed = new URL(destination);
        } catch {
            return { ok: false, error: `"${slug}": destination is not a valid URL` };
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return { ok: false, error: `"${slug}": destination must be http or https` };
        }

        const name = String(entry.name || '').trim().slice(0, 120);
        const campaign = String(entry.utm_campaign || '').trim().slice(0, 60)
            .toLowerCase().replace(/[^a-z0-9_-]/g, '');

        cleaned.push({
            slug,
            name: name || slug,
            destination: parsed.toString(),
            active: entry.active !== false,
            utm_campaign: campaign || CLICK_DEFAULT_CAMPAIGN
        });
    }

    return { ok: true, artists: cleaned };
}

function recordArtistClick({ slug, placement, clickId, visitor, bot }) {
    const clicks = loadArtistClicks();
    const now = Date.now();

    // "Unique" = first click from this visitor for this artist in the window.
    const isRepeat = clicks.some(c =>
        c.visitor === visitor &&
        c.slug === slug &&
        (now - new Date(c.timestamp).getTime()) < CLICK_DEDUPE_WINDOW_MS
    );

    clicks.push({
        id: clickId,
        slug,
        placement: placement || 'unknown',
        timestamp: new Date().toISOString(),
        visitor,
        bot: !!bot,
        unique: !bot && !isRepeat
    });

    // Trim oldest first so the file cannot grow without bound.
    const trimmed = clicks.length > MAX_CLICK_RECORDS
        ? clicks.slice(clicks.length - MAX_CLICK_RECORDS)
        : clicks;

    saveArtistClicks(trimmed);
}

const LINK_UNAVAILABLE_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Link unavailable</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1419;color:#e7e9ea;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:#8b98a5;font-size:14px;margin:0;line-height:1.6}
</style></head>
<body><div><h1>This link is no longer available</h1>
<p>The page you were heading to has moved or the collaboration has ended.</p></div></body></html>`;

// Per-visitor limit on the redirect, keyed on the player's IP (see clientIp).
const goLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { xForwardedForHeader: false },
    message: 'Too many requests'
});

// GET /go/:slug?p=<placement> — the link that ships in the game.
app.get('/go/:slug', goLimiter, (req, res) => {
    // Never let a cache or the browser skip a hop: we must see every click, and
    // a cached 301 would pin the destination forever on that machine.
    res.set('Cache-Control', 'no-store, max-age=0');

    const slug = String(req.params.slug || '').trim().toLowerCase();
    const artist = loadArtists().find(a => a.slug === slug);

    if (!artist || artist.active === false) {
        console.warn(`Artist link miss: "${slug}" (${artist ? 'inactive' : 'unknown'})`);
        return res.status(404).send(LINK_UNAVAILABLE_PAGE);
    }

    const placement = sanitizePlacement(req.query.p);
    const clickId = crypto.randomBytes(4).toString('hex');

    let target;
    try {
        target = buildDestinationUrl(artist, placement, clickId);
    } catch (error) {
        console.error(`Artist link "${slug}" has an unusable destination:`, error.message);
        return res.status(500).send(LINK_UNAVAILABLE_PAGE);
    }

    // Redirect FIRST, count after. A storage hiccup must never leave a player
    // staring at an error page instead of the shop.
    res.redirect(302, target);

    setImmediate(() => {
        try {
            const bot = isBotUserAgent(req.headers['user-agent']);
            recordArtistClick({
                slug,
                placement,
                clickId,
                visitor: visitorHash(req, slug),
                bot
            });
            console.log(`Artist click: ${slug} (${placement || 'no placement'})${bot ? ' [bot]' : ''}`);
        } catch (error) {
            console.error('Failed to record artist click:', error);
        }
    });
});

// GET /api/artists/admin — the artist list, for the dashboard editor.
app.get('/api/artists/admin', requireAdmin, (req, res) => {
    try {
        res.json({ artists: loadArtists() });
    } catch (error) {
        console.error('Artists fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/artists/admin — body: { artists: [...] }. Replaces the whole list.
app.post('/api/artists/admin', requireAdmin, (req, res) => {
    try {
        const result = validateArtists(req.body?.artists);
        if (!result.ok) {
            return res.status(400).json({ error: result.error });
        }
        saveArtists(result.artists);
        console.log(`Artist list updated — ${result.artists.length} artist(s)`);
        res.json({ ok: true, count: result.artists.length, artists: result.artists });
    } catch (error) {
        console.error('Artists update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Like/unlike design (increment/decrement download_count)
app.post('/api/designs/:id/like', requireApiKey, (req, res) => {
    try {
        const designId = req.params.id;
        if (!isValidUUID(designId)) {
            return res.status(400).json({ error: 'Invalid design ID format' });
        }
        const { increment } = req.body;

        // Only allow +1 or -1 to prevent count manipulation
        if (increment !== 1 && increment !== -1) {
            return res.status(400).json({ error: 'increment must be 1 or -1' });
        }

        const allMetadata = loadMetadata();
        const designIndex = allMetadata.findIndex(d => d.id === designId);

        if (designIndex === -1) {
            return res.status(404).json({ error: 'Design not found' });
        }

        // Update download_count (like counter)
        allMetadata[designIndex].download_count += increment;

        // Prevent negative counts
        if (allMetadata[designIndex].download_count < 0) {
            allMetadata[designIndex].download_count = 0;
        }

        saveMetadata(allMetadata);

        console.log(`Design ${designId} like updated: ${increment > 0 ? '+1' : '-1'} (new count: ${allMetadata[designIndex].download_count})`);

        res.json({
            success: true,
            download_count: allMetadata[designIndex].download_count
        });

    } catch (error) {
        console.error('Like error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve thumbnails
app.get('/api/thumbnails/:filename', requireApiKey, (req, res) => {
    try {
        // Sanitize filename — strip any directory traversal
        const filename = path.basename(req.params.filename);
        const thumbnailPath = path.join(THUMBNAILS_DIR, filename);

        // Double-check the resolved path is still inside THUMBNAILS_DIR
        if (!thumbnailPath.startsWith(THUMBNAILS_DIR)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        if (fs.existsSync(thumbnailPath)) {
            res.sendFile(thumbnailPath);
        } else {
            res.status(404).json({ error: 'Thumbnail not found' });
        }
    } catch (error) {
        console.error('Thumbnail error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Root route — minimal info to avoid exposing attack surface
app.get('/', (req, res) => {
    res.json({
        message: 'Small Spaces Design Server is running',
        health: '/api/health'
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Small Spaces Design Server is running' });
});

// Test image compression endpoint (development only)
app.post('/api/test/compress', (req, res, next) => {
    if (!isDevelopment) {
        return res.status(403).json({ error: 'Test endpoints not available in production' });
    }
    next();
}, async (req, res) => {
    try {
        const { imageData } = req.body;
        
        if (!imageData) {
            return res.status(400).json({ error: 'imageData (base64) required' });
        }
        
        const testFilename = 'test-compression.png';
        const testPath = path.join(THUMBNAILS_DIR, testFilename);
        
        // Test compression
        const compressedPath = await compressAndSaveThumbnail(imageData, testPath);
        
        if (compressedPath) {
            const originalSize = Buffer.from(imageData, 'base64').length;
            const compressedSize = fs.statSync(compressedPath).size;
            const savings = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
            
            // Clean up test file
            fs.removeSync(compressedPath);
            
            res.json({
                success: true,
                compression: {
                    originalSize: `${(originalSize/1024).toFixed(1)}KB`,
                    compressedSize: `${(compressedSize/1024).toFixed(1)}KB`,
                    savings: `${savings}%`,
                    sharpAvailable: !!sharp
                }
            });
        } else {
            res.json({
                success: false,
                message: 'Compression failed',
                sharpAvailable: !!sharp
            });
        }
        
    } catch (error) {
        console.error('Test compression error:', error);
        res.status(500).json({ error: 'Test failed', message: error.message });
    }
});

// Bulk compress existing thumbnails with backup
app.post('/api/admin/compress-existing', requireAdmin, async (req, res) => {
    if (!sharp) {
        return res.status(500).json({ error: 'Sharp not available for compression' });
    }
    
    try {
        // Create backup directory
        const BACKUP_DIR = path.join(STORAGE_DIR, 'thumbnails-backup');
        fs.ensureDirSync(BACKUP_DIR);
        
        // Get all existing thumbnails
        const thumbnailFiles = fs.readdirSync(THUMBNAILS_DIR)
            .filter(file => file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg'));
        
        let compressed = 0;
        let skipped = 0;
        let errors = 0;
        let totalOriginalSize = 0;
        let totalCompressedSize = 0;
        
        console.log(`Starting bulk compression of ${thumbnailFiles.length} thumbnails...`);
        
        for (const filename of thumbnailFiles) {
            try {
                const originalPath = path.join(THUMBNAILS_DIR, filename);
                const backupPath = path.join(BACKUP_DIR, filename);
                const originalSize = fs.statSync(originalPath).size;
                
                // Skip if already JPEG and small
                if ((filename.endsWith('.jpg') || filename.endsWith('.jpeg')) && originalSize < 200 * 1024) {
                    skipped++;
                    continue;
                }
                
                // Create backup
                fs.copyFileSync(originalPath, backupPath);
                
                // Read original file and convert to base64
                const fileBuffer = fs.readFileSync(originalPath);
                const base64Data = fileBuffer.toString('base64');
                
                // Compress
                const compressedPath = await compressAndSaveThumbnail(base64Data, originalPath);
                
                if (compressedPath) {
                    const compressedSize = fs.statSync(compressedPath).size;
                    totalOriginalSize += originalSize;
                    totalCompressedSize += compressedSize;
                    compressed++;
                    
                    const savings = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
                    console.log(`Compressed ${filename}: ${(originalSize/1024).toFixed(0)}KB → ${(compressedSize/1024).toFixed(0)}KB (${savings}% savings)`);
                } else {
                    // Restore from backup if compression failed
                    fs.copyFileSync(backupPath, originalPath);
                    errors++;
                    console.error(`Failed to compress ${filename}, restored from backup`);
                }
                
            } catch (error) {
                errors++;
                console.error(`Error processing ${filename}:`, error.message);
            }
        }
        
        const totalSavings = totalOriginalSize > 0 
            ? ((totalOriginalSize - totalCompressedSize) / totalOriginalSize * 100).toFixed(1)
            : '0';
        
        console.log(`Bulk compression complete: ${compressed} compressed, ${skipped} skipped, ${errors} errors`);
        
        res.json({
            success: true,
            results: {
                total: thumbnailFiles.length,
                compressed: compressed,
                skipped: skipped,
                errors: errors,
                totalSavings: `${totalSavings}%`,
                originalSize: `${(totalOriginalSize/1024/1024).toFixed(1)}MB`,
                compressedSize: `${(totalCompressedSize/1024/1024).toFixed(1)}MB`,
                backupLocation: BACKUP_DIR
            }
        });
        
    } catch (error) {
        console.error('Bulk compression error:', error);
        res.status(500).json({ error: 'Bulk compression failed', message: error.message });
    }
});

// Compress existing thumbnails IN-PLACE (keeps PNG extensions)
app.post('/api/admin/compress-inplace', requireAdmin, async (req, res) => {
    if (!sharp) {
        return res.status(500).json({ error: 'Sharp not available for compression' });
    }
    
    try {
        // Create backup directory
        const BACKUP_DIR = path.join(STORAGE_DIR, 'thumbnails-backup-inplace');
        fs.ensureDirSync(BACKUP_DIR);
        
        // Get all PNG thumbnails
        const thumbnailFiles = fs.readdirSync(THUMBNAILS_DIR)
            .filter(file => file.endsWith('.png'));
        
        let compressed = 0;
        let skipped = 0;
        let errors = 0;
        let totalOriginalSize = 0;
        let totalCompressedSize = 0;
        
        console.log(`Starting in-place compression of ${thumbnailFiles.length} PNG thumbnails...`);
        
        for (const filename of thumbnailFiles) {
            try {
                const originalPath = path.join(THUMBNAILS_DIR, filename);
                const backupPath = path.join(BACKUP_DIR, filename);
                const originalBuffer = fs.readFileSync(originalPath);
                const originalSize = originalBuffer.length;
                
                // Skip if already small (likely already compressed)
                if (originalSize < 100 * 1024) {
                    skipped++;
                    continue;
                }
                
                // Create backup
                fs.copyFileSync(originalPath, backupPath);
                
                // Compress to JPEG but keep .png filename (no resize)
                const compressedBuffer = await sharp(originalBuffer)
                    .jpeg({
                        quality: 90,
                        progressive: true
                    })
                    .toBuffer();
                
                // Replace original file with compressed content (SAME filename)
                fs.writeFileSync(originalPath, compressedBuffer);
                
                const compressedSize = compressedBuffer.length;
                totalOriginalSize += originalSize;
                totalCompressedSize += compressedSize;
                compressed++;
                
                const savings = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
                console.log(`Compressed ${filename}: ${(originalSize/1024).toFixed(0)}KB → ${(compressedSize/1024).toFixed(0)}KB (${savings}% savings)`);
                
            } catch (error) {
                errors++;
                console.error(`Error processing ${filename}:`, error.message);
                
                // Restore from backup if compression failed
                const backupPath = path.join(BACKUP_DIR, filename);
                if (fs.existsSync(backupPath)) {
                    fs.copyFileSync(backupPath, path.join(THUMBNAILS_DIR, filename));
                }
            }
        }
        
        const totalSavings = totalOriginalSize > 0 
            ? ((totalOriginalSize - totalCompressedSize) / totalOriginalSize * 100).toFixed(1)
            : '0';
        
        console.log(`In-place compression complete: ${compressed} compressed, ${skipped} skipped, ${errors} errors`);
        
        res.json({
            success: true,
            results: {
                total: thumbnailFiles.length,
                compressed: compressed,
                skipped: skipped,
                errors: errors,
                totalSavings: `${totalSavings}%`,
                originalSize: `${(totalOriginalSize/1024/1024).toFixed(1)}MB`,
                compressedSize: `${(totalCompressedSize/1024/1024).toFixed(1)}MB`,
                backupLocation: BACKUP_DIR,
                note: "Files compressed in-place, keeping .png extensions for game compatibility"
            }
        });
        
    } catch (error) {
        console.error('In-place compression error:', error);
        res.status(500).json({ error: 'In-place compression failed', message: error.message });
    }
});

// Restore from backup
app.post('/api/admin/restore-backup', requireAdmin, async (req, res) => {
    try {
        const BACKUP_DIR = path.join(STORAGE_DIR, 'thumbnails-backup');
        
        if (!fs.existsSync(BACKUP_DIR)) {
            return res.status(404).json({ error: 'No backup found' });
        }
        
        const backupFiles = fs.readdirSync(BACKUP_DIR);
        let restored = 0;
        
        for (const filename of backupFiles) {
            const backupPath = path.join(BACKUP_DIR, filename);
            const originalPath = path.join(THUMBNAILS_DIR, filename);
            
            fs.copyFileSync(backupPath, originalPath);
            restored++;
        }
        
        console.log(`Restored ${restored} files from backup`);
        
        res.json({
            success: true,
            message: `Restored ${restored} thumbnails from backup`,
            restored: restored
        });
        
    } catch (error) {
        console.error('Restore backup error:', error);
        res.status(500).json({ error: 'Restore failed', message: error.message });
    }
});

// Delete specific design by ID (admin auth required)
app.delete('/api/designs/:id', requireAdmin, (req, res) => {
    try {
        const designId = req.params.id;
        if (!isValidUUID(designId)) {
            return res.status(400).json({ error: 'Invalid design ID format' });
        }
        const designPath = path.join(DESIGNS_DIR, `${designId}.sav`);
        const thumbnailPath = path.join(THUMBNAILS_DIR, `${designId}.png`);

        // Check if design exists
        if (!fs.existsSync(designPath)) {
            return res.status(404).json({ error: 'Design not found' });
        }

        // Remove design file
        fs.removeSync(designPath);
        
        // Remove thumbnail if it exists
        if (fs.existsSync(thumbnailPath)) {
            fs.removeSync(thumbnailPath);
        }
        
        // Remove from metadata
        const allMetadata = loadMetadata();
        const filteredMetadata = allMetadata.filter(d => d.id !== designId);
        saveMetadata(filteredMetadata);
        
        console.log(`Design deleted: ${designId}`);
        res.json({ 
            success: true, 
            message: `Design ${designId} deleted successfully`,
            deleted_id: designId
        });
        
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Manually update specific design title/author
app.post('/api/admin/update-design-text', requireAdmin, (req, res) => {
    try {
        const { designId, title, authorName } = req.body;

        if (!designId) {
            return res.status(400).json({ error: 'designId is required' });
        }

        const allMetadata = loadMetadata();
        const designIndex = allMetadata.findIndex(d => d.id === designId);

        if (designIndex === -1) {
            return res.status(404).json({ error: 'Design not found' });
        }

        const oldTitle = allMetadata[designIndex].title;
        const oldAuthor = allMetadata[designIndex].author_name;

        // Update fields if provided
        if (title !== undefined) {
            allMetadata[designIndex].title = title;
        }
        if (authorName !== undefined) {
            allMetadata[designIndex].author_name = authorName;
        }

        saveMetadata(allMetadata);

        res.json({
            success: true,
            designId: designId,
            changes: {
                title: { old: oldTitle, new: allMetadata[designIndex].title },
                author: { old: oldAuthor, new: allMetadata[designIndex].author_name }
            }
        });

    } catch (error) {
        console.error('Manual update error:', error);
        res.status(500).json({ error: 'Update failed', message: error.message });
    }
});

// Export all censored entries to a file for manual correction
app.get('/api/admin/export-censored', requireAdmin, (req, res) => {
    try {
        const allMetadata = loadMetadata();
        const censoredEntries = [];

        // Find all entries with asterisks in title or author name
        for (const design of allMetadata) {
            const hasAsterisksInTitle = design.title && design.title.includes('*');
            const hasAsterisksInAuthor = design.author_name && design.author_name.includes('*');

            if (hasAsterisksInTitle || hasAsterisksInAuthor) {
                censoredEntries.push({
                    id: design.id,
                    title: design.title,
                    author_name: design.author_name,
                    // These will be filled in manually by the user
                    corrected_title: hasAsterisksInTitle ? "" : design.title,
                    corrected_author: hasAsterisksInAuthor ? "" : design.author_name,
                    upload_date: design.upload_date,
                    download_count: design.download_count
                });
            }
        }

        console.log(`Found ${censoredEntries.length} designs with censored text`);

        res.json({
            success: true,
            total_censored: censoredEntries.length,
            entries: censoredEntries,
            instructions: "Fill in 'corrected_title' and 'corrected_author' fields, then POST to /api/admin/import-corrections"
        });

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Export failed', message: error.message });
    }
});

// Import manual corrections and apply them to the database
app.post('/api/admin/import-corrections', requireAdmin, (req, res) => {
    try {
        const { corrections } = req.body;

        if (!corrections || !Array.isArray(corrections)) {
            return res.status(400).json({ error: 'Missing or invalid corrections array' });
        }

        const allMetadata = loadMetadata();
        let appliedCount = 0;
        const results = [];

        for (const correction of corrections) {
            if (!correction.id) {
                continue;
            }

            const designIndex = allMetadata.findIndex(d => d.id === correction.id);

            if (designIndex === -1) {
                results.push({
                    id: correction.id,
                    status: 'not_found',
                    message: 'Design ID not found in database'
                });
                continue;
            }

            const design = allMetadata[designIndex];
            let changed = false;

            // Apply title correction if provided
            if (correction.corrected_title && correction.corrected_title.trim() !== '') {
                design.title = correction.corrected_title.trim();
                changed = true;
            }

            // Apply author correction if provided
            if (correction.corrected_author && correction.corrected_author.trim() !== '') {
                design.author_name = correction.corrected_author.trim();
                changed = true;
            }

            if (changed) {
                appliedCount++;
                results.push({
                    id: correction.id,
                    status: 'success',
                    new_title: design.title,
                    new_author: design.author_name
                });
            } else {
                results.push({
                    id: correction.id,
                    status: 'skipped',
                    message: 'No corrections provided'
                });
            }
        }

        // Save updated metadata
        if (appliedCount > 0) {
            saveMetadata(allMetadata);
            console.log(`Applied ${appliedCount} manual corrections`);
        }

        res.json({
            success: true,
            message: `Applied ${appliedCount} corrections`,
            total_processed: corrections.length,
            applied: appliedCount,
            results: results
        });

    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ error: 'Import failed', message: error.message });
    }
});

// Repair censored text in metadata (fix old profanity filter damage)
app.post('/api/admin/repair-censored', requireAdmin, (req, res) => {
    try {
        const allMetadata = loadMetadata();
        let repairedCount = 0;
        const repairs = [];

        // Common word patterns that were incorrectly censored by the old filter
        const repairPatterns = [
            // Common English words
            { pattern: /cl\*{3}y/gi, replacement: 'classy' },
            { pattern: /cl\*{3}ic/gi, replacement: 'classic' },
            { pattern: /cl\*{3}/gi, replacement: 'class' },
            { pattern: /gl\*{3}/gi, replacement: 'glass' },
            { pattern: /br\*{3}/gi, replacement: 'brass' },
            { pattern: /gr\*{3}/gi, replacement: 'grass' },
            { pattern: /m\*{3}/gi, replacement: 'mass' },
            { pattern: /p\*{3}/gi, replacement: 'pass' },
            { pattern: /b\*{3}/gi, replacement: 'bass' },
            { pattern: /\*{3}\*{3}in/gi, replacement: 'assassin' },
            { pattern: /\*{3}e\*{3}ment/gi, replacement: 'assessment' },
            { pattern: /\*{3}ume/gi, replacement: 'assume' },
            { pattern: /emb\*{3}y/gi, replacement: 'embassy' },
            { pattern: /h\*{3}le/gi, replacement: 'hassle' },
            { pattern: /ti\*{3}ue/gi, replacement: 'tissue' },
            { pattern: /ca\*{3}ette/gi, replacement: 'cassette' },
            { pattern: /ca\*{3}erole/gi, replacement: 'casserole' },
            { pattern: /compa\*{3}/gi, replacement: 'compass' },

            // Japanese names/words (likely Shitaya - place name)
            { pattern: /shi\*{3}a/gi, replacement: 'shitaya' }
        ];

        // Process each design
        for (let design of allMetadata) {
            let titleChanged = false;
            let authorChanged = false;
            const originalTitle = design.title;
            const originalAuthor = design.author_name;

            // Repair title
            for (const { pattern, replacement } of repairPatterns) {
                if (pattern.test(design.title)) {
                    design.title = design.title.replace(pattern, replacement);
                    titleChanged = true;
                }
            }

            // Repair author name
            for (const { pattern, replacement } of repairPatterns) {
                if (pattern.test(design.author_name)) {
                    design.author_name = design.author_name.replace(pattern, replacement);
                    authorChanged = true;
                }
            }

            // Track repairs
            if (titleChanged || authorChanged) {
                repairedCount++;
                repairs.push({
                    id: design.id,
                    originalTitle: originalTitle,
                    newTitle: design.title,
                    originalAuthor: originalAuthor,
                    newAuthor: design.author_name
                });
            }
        }

        // Save repaired metadata
        if (repairedCount > 0) {
            saveMetadata(allMetadata);
            console.log(`Repaired ${repairedCount} designs with censored text`);
        }

        res.json({
            success: true,
            message: `Repaired ${repairedCount} designs`,
            repaired: repairedCount,
            repairs: repairs
        });

    } catch (error) {
        console.error('Repair error:', error);
        res.status(500).json({ error: 'Repair failed', message: error.message });
    }
});

// Admin reset with secret key (production safe)
app.delete('/api/admin/reset', requireAdmin, (req, res) => {
    try {
        // Clear all designs
        if (fs.existsSync(DESIGNS_DIR)) {
            fs.emptyDirSync(DESIGNS_DIR);
        }
        
        // Clear all thumbnails  
        if (fs.existsSync(THUMBNAILS_DIR)) {
            fs.emptyDirSync(THUMBNAILS_DIR);
        }
        
        // Reset metadata
        fs.writeJsonSync(METADATA_FILE, []);
        
        console.log('ADMIN RESET: Server data reset - all designs and metadata cleared');
        res.json({ 
            success: true, 
            message: 'All server data has been cleared via admin reset' 
        });
        
    } catch (error) {
        console.error('Admin reset error:', error);
        res.status(500).json({ error: 'Failed to reset server data' });
    }
});

// Reset/clear all data (development only)
app.delete('/api/reset', (req, res) => {
    // Only allow reset in development
    if (!isDevelopment) {
        return res.status(403).json({ error: 'Reset not allowed in production' });
    }
    try {
        // Clear all designs
        if (fs.existsSync(DESIGNS_DIR)) {
            fs.emptyDirSync(DESIGNS_DIR);
        }
        
        // Clear all thumbnails  
        if (fs.existsSync(THUMBNAILS_DIR)) {
            fs.emptyDirSync(THUMBNAILS_DIR);
        }
        
        // Reset metadata
        fs.writeJsonSync(METADATA_FILE, []);
        
        console.log('Server data reset - all designs and metadata cleared');
        res.json({ 
            success: true, 
            message: 'All server data has been cleared' 
        });
        
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({ error: 'Failed to reset server data' });
    }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Small Spaces Design Server running on port ${PORT}`);
    console.log(`Storage directory: ${STORAGE_DIR}`);
    console.log(`Persistent storage: ${process.env.RAILWAY_VOLUME_MOUNT_PATH ? 'ENABLED' : 'LOCAL'}`);
    console.log(`Sharp compression: ${sharp ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Thumbnail moderation: ${MODERATION_ENDPOINT && MODERATION_KEY ? `ENABLED (severity >= ${MODERATION_SEVERITY_THRESHOLD})` : 'DISABLED (set AZURE_CONTENT_SAFETY_ENDPOINT + AZURE_CONTENT_SAFETY_KEY)'}`);
    console.log(`Artist links: ${loadArtists().filter(a => a.active !== false).length} active at /go/<slug>`);
    console.log(`Server ready for connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    insights.stop();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    insights.stop();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
