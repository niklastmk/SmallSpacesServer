const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

// CORS configuration
const corsOptions = {
    origin: isDevelopment 
        ? ['http://localhost:3000', 'http://127.0.0.1:3000']
        : process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Large limit for save data + thumbnails
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve analytics dashboard static files (if built)
const DASHBOARD_DIR = path.join(__dirname, 'dashboard', 'dist');
if (fs.existsSync(DASHBOARD_DIR)) {
    app.use('/admin', express.static(DASHBOARD_DIR));
    // Handle SPA routing - serve index.html for all /admin routes
    app.get('/admin/*', (req, res) => {
        res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
    });
    console.log('Analytics dashboard enabled at /admin');
}

// Storage directories - use persistent volume on Railway Pro
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'storage');
const DESIGNS_DIR = path.join(STORAGE_DIR, 'designs');
const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');
const METADATA_FILE = path.join(STORAGE_DIR, 'metadata.json');

// Analytics storage directories
const ANALYTICS_DIR = path.join(STORAGE_DIR, 'analytics');
const ANALYTICS_EVENTS_FILE = path.join(ANALYTICS_DIR, 'events.json');
const ANALYTICS_SESSIONS_FILE = path.join(ANALYTICS_DIR, 'sessions.json');

// Ensure storage directories exist
try {
    fs.ensureDirSync(DESIGNS_DIR);
    fs.ensureDirSync(THUMBNAILS_DIR);
    fs.ensureDirSync(ANALYTICS_DIR);
    console.log('Storage directories created/verified');
} catch (error) {
    console.error('Failed to create storage directories:', error);
    process.exit(1);
}

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

// Initialize analytics files if they don't exist
try {
    if (!fs.existsSync(ANALYTICS_EVENTS_FILE)) {
        fs.writeJsonSync(ANALYTICS_EVENTS_FILE, []);
        console.log('Analytics events file initialized');
    }
    if (!fs.existsSync(ANALYTICS_SESSIONS_FILE)) {
        fs.writeJsonSync(ANALYTICS_SESSIONS_FILE, []);
        console.log('Analytics sessions file initialized');
    }
} catch (error) {
    console.error('Failed to initialize analytics files:', error);
    // Non-fatal - analytics is optional
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

// Analytics helper functions
function loadAnalyticsEvents() {
    try {
        return fs.readJsonSync(ANALYTICS_EVENTS_FILE);
    } catch (error) {
        console.error('Error loading analytics events:', error);
        return [];
    }
}

function saveAnalyticsEvents(events) {
    try {
        fs.writeJsonSync(ANALYTICS_EVENTS_FILE, events, { spaces: 2 });
    } catch (error) {
        console.error('Error saving analytics events:', error);
    }
}

function loadAnalyticsSessions() {
    try {
        return fs.readJsonSync(ANALYTICS_SESSIONS_FILE);
    } catch (error) {
        console.error('Error loading analytics sessions:', error);
        return [];
    }
}

function saveAnalyticsSessions(sessions) {
    try {
        fs.writeJsonSync(ANALYTICS_SESSIONS_FILE, sessions, { spaces: 2 });
    } catch (error) {
        console.error('Error saving analytics sessions:', error);
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

// API Routes

// Upload design
app.post('/api/designs', async (req, res) => {
    try {
        const { designId, title, description, authorName, level, saveData, thumbnail, christmasEvent } = req.body;


        // Validate required fields
        if (!title || !saveData) {
            return res.status(400).json({ error: 'Title and saveData are required' });
        }

        // Use provided designId or generate new one
        const finalDesignId = designId || uuidv4();
        const designFilename = `${finalDesignId}.sav`;
        const designPath = path.join(DESIGNS_DIR, designFilename);

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
app.get('/api/designs', (req, res) => {
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

        // DEBUG: Log the actual query parameters received
        console.log(`DEBUG - Query params: sort="${sortMode}", search="${searchQuery}", level="${levelFilter}", levelFilters=${levelFilters ? JSON.stringify(levelFilters) : 'null'}, fromDate="${fromDate}", christmasEvent="${christmasEventFilter}"`);

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
app.get('/api/designs/top', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 3;
        
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
app.post('/api/designs/:id/download', (req, res) => {
    try {
        const designId = req.params.id;
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
app.post('/api/designs/:id/download/binary', (req, res) => {
    try {
        const designId = req.params.id;
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
app.post('/api/designs/metadata', (req, res) => {
    try {
        console.log('Received metadata request:', JSON.stringify(req.body));

        const { ids } = req.body;

        if (!ids) {
            console.error('Missing ids field in request body');
            return res.status(400).json({ error: 'Missing ids field in request body' });
        }

        if (!Array.isArray(ids)) {
            console.error('ids field is not an array:', typeof ids);
            return res.status(400).json({ error: 'ids field must be an array' });
        }

        if (ids.length === 0) {
            console.log('Empty IDs array provided');
            return res.status(400).json({ error: 'Empty IDs array' });
        }

        console.log(`Metadata request for ${ids.length} design(s): ${ids.join(', ')}`);

        // Load all metadata
        const allMetadata = loadMetadata();
        console.log(`Total designs in database: ${allMetadata.length}`);

        // Log first few IDs from database for debugging
        if (allMetadata.length > 0) {
            console.log(`Sample IDs from database: ${allMetadata.slice(0, 3).map(d => d.id).join(', ')}`);
        }

        // Filter to only the requested IDs
        const requestedMetadata = allMetadata.filter(design => ids.includes(design.id));

        console.log(`Found ${requestedMetadata.length} matching designs out of ${ids.length} requested`);

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

        console.log(`Returning metadata for ${designs.length} design(s)`);

        res.json({ designs });

    } catch (error) {
        console.error('Get metadata error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Like/unlike design (increment/decrement download_count)
app.post('/api/designs/:id/like', (req, res) => {
    try {
        const designId = req.params.id;
        const { increment } = req.body; // 1 or -1

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
app.get('/api/thumbnails/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const thumbnailPath = path.join(THUMBNAILS_DIR, filename);

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

// Root route for browser
app.get('/', (req, res) => {
    res.json({
        message: 'Small Spaces Design Server is running',
        endpoints: {
            designs: [
                'POST /api/designs - Upload design',
                'GET /api/designs?sort={date|downloads}&search={query}&level={levelPath}&levelFilters={JSON array}&fromDate={ISO8601}&christmasEvent={true|false} - Browse designs',
                'POST /api/designs/:id/download - Download design (Base64)',
                'POST /api/designs/:id/download/binary - Download design (Binary - FAST)',
                'POST /api/designs/metadata - Get metadata for multiple designs by IDs',
                'POST /api/designs/:id/like - Like/unlike design',
                'DELETE /api/designs/:id - Delete design by ID'
            ],
            analytics: [
                'POST /api/analytics/event - Track single event',
                'POST /api/analytics/batch - Track multiple events',
                'POST /api/analytics/session/start - Start session',
                'POST /api/analytics/session/end - End session',
                'GET /api/analytics/events - Query events (admin)',
                'GET /api/analytics/sessions - List sessions (admin)',
                'GET /api/analytics/summary - Dashboard summary (admin)',
                'GET /api/analytics/event-names - Unique event names (admin)',
                'DELETE /api/analytics/clear - Clear analytics data (admin)'
            ],
            admin: [
                'GET /api/admin/export-censored - Export censored entries',
                'POST /api/admin/import-corrections - Import corrections',
                'POST /api/admin/repair-censored - Auto-repair censored text',
                'DELETE /api/admin/reset - Clear all designs and metadata (requires admin key)',
                'DELETE /api/admin/reset-analytics - Clear all analytics data (requires admin key)',
                'GET /api/health - Health check'
            ]
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Small Spaces Design Server is running' });
});

// Test image compression endpoint (development only)
app.post('/api/test/compress', async (req, res) => {
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
app.post('/api/admin/compress-existing', async (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';
    
    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
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
app.post('/api/admin/compress-inplace', async (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';
    
    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
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
app.post('/api/admin/restore-backup', async (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';
    
    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
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

// Delete specific design by ID
app.delete('/api/designs/:id', (req, res) => {
    try {
        const designId = req.params.id;
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
app.post('/api/admin/update-design-text', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

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
app.get('/api/admin/export-censored', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

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
app.post('/api/admin/import-corrections', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

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
app.post('/api/admin/repair-censored', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

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

// ============================================
// ANALYTICS API ENDPOINTS
// ============================================

// Track a single analytics event (no auth required - game clients send these)
app.post('/api/analytics/event', (req, res) => {
    try {
        const { session_id, event_name, properties, client_version, platform } = req.body;

        if (!event_name) {
            return res.status(400).json({ error: 'event_name is required' });
        }

        const event = {
            id: uuidv4(),
            session_id: session_id || 'anonymous',
            event_name: event_name,
            properties: properties || {},
            timestamp: new Date().toISOString(),
            client_version: client_version || 'unknown',
            platform: platform || 'unknown'
        };

        const events = loadAnalyticsEvents();
        events.push(event);
        saveAnalyticsEvents(events);

        console.log(`Analytics event: ${event_name} (session: ${session_id || 'anonymous'})`);

        res.json({ success: true, event_id: event.id });

    } catch (error) {
        console.error('Analytics event error:', error);
        res.status(500).json({ error: 'Failed to track event' });
    }
});

// Track multiple events in a batch (no auth required)
app.post('/api/analytics/batch', (req, res) => {
    try {
        const { events: batchEvents, session_id, client_version, platform } = req.body;

        if (!batchEvents || !Array.isArray(batchEvents)) {
            return res.status(400).json({ error: 'events array is required' });
        }

        const events = loadAnalyticsEvents();
        const processedEvents = [];

        for (const eventData of batchEvents) {
            const event = {
                id: uuidv4(),
                session_id: eventData.session_id || session_id || 'anonymous',
                event_name: eventData.event_name,
                properties: eventData.properties || {},
                timestamp: eventData.timestamp || new Date().toISOString(),
                client_version: eventData.client_version || client_version || 'unknown',
                platform: eventData.platform || platform || 'unknown'
            };
            events.push(event);
            processedEvents.push(event.id);
        }

        saveAnalyticsEvents(events);

        console.log(`Analytics batch: ${processedEvents.length} events (session: ${session_id || 'anonymous'})`);

        res.json({ success: true, event_ids: processedEvents, count: processedEvents.length });

    } catch (error) {
        console.error('Analytics batch error:', error);
        res.status(500).json({ error: 'Failed to track batch' });
    }
});

// Start a new session (no auth required)
app.post('/api/analytics/session/start', (req, res) => {
    try {
        const { client_version, platform, metadata } = req.body;

        const session = {
            id: uuidv4(),
            start_time: new Date().toISOString(),
            end_time: null,
            client_version: client_version || 'unknown',
            platform: platform || 'unknown',
            metadata: metadata || {},
            event_count: 0
        };

        const sessions = loadAnalyticsSessions();
        sessions.push(session);
        saveAnalyticsSessions(sessions);

        console.log(`Analytics session started: ${session.id}`);

        res.json({ success: true, session_id: session.id });

    } catch (error) {
        console.error('Session start error:', error);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

// End a session (no auth required)
app.post('/api/analytics/session/end', (req, res) => {
    try {
        const { session_id } = req.body;

        if (!session_id) {
            return res.status(400).json({ error: 'session_id is required' });
        }

        const sessions = loadAnalyticsSessions();
        const sessionIndex = sessions.findIndex(s => s.id === session_id);

        if (sessionIndex === -1) {
            return res.status(404).json({ error: 'Session not found' });
        }

        sessions[sessionIndex].end_time = new Date().toISOString();

        // Count events for this session
        const events = loadAnalyticsEvents();
        sessions[sessionIndex].event_count = events.filter(e => e.session_id === session_id).length;

        saveAnalyticsSessions(sessions);

        console.log(`Analytics session ended: ${session_id}`);

        res.json({ success: true, session: sessions[sessionIndex] });

    } catch (error) {
        console.error('Session end error:', error);
        res.status(500).json({ error: 'Failed to end session' });
    }
});

// Query events (admin auth required)
app.get('/api/analytics/events', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        let events = loadAnalyticsEvents();

        // Filter by event name
        if (req.query.event_name) {
            events = events.filter(e => e.event_name === req.query.event_name);
        }

        // Filter by session
        if (req.query.session_id) {
            events = events.filter(e => e.session_id === req.query.session_id);
        }

        // Filter by date range
        if (req.query.start_date) {
            const startDate = new Date(req.query.start_date);
            events = events.filter(e => new Date(e.timestamp) >= startDate);
        }
        if (req.query.end_date) {
            const endDate = new Date(req.query.end_date);
            events = events.filter(e => new Date(e.timestamp) <= endDate);
        }

        // Sort by timestamp (newest first)
        events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Pagination
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const paginatedEvents = events.slice(offset, offset + limit);

        res.json({
            events: paginatedEvents,
            total: events.length,
            limit,
            offset
        });

    } catch (error) {
        console.error('Query events error:', error);
        res.status(500).json({ error: 'Failed to query events' });
    }
});

// Get sessions list (admin auth required)
app.get('/api/analytics/sessions', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        let sessions = loadAnalyticsSessions();

        // Sort by start time (newest first)
        sessions.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

        // Pagination
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const paginatedSessions = sessions.slice(offset, offset + limit);

        res.json({
            sessions: paginatedSessions,
            total: sessions.length,
            limit,
            offset
        });

    } catch (error) {
        console.error('Query sessions error:', error);
        res.status(500).json({ error: 'Failed to query sessions' });
    }
});

// Get dashboard summary (admin auth required)
app.get('/api/analytics/summary', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        const events = loadAnalyticsEvents();
        const sessions = loadAnalyticsSessions();

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthStart = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

        // Count events by time period
        const eventsToday = events.filter(e => new Date(e.timestamp) >= todayStart).length;
        const eventsThisWeek = events.filter(e => new Date(e.timestamp) >= weekStart).length;
        const eventsThisMonth = events.filter(e => new Date(e.timestamp) >= monthStart).length;

        // Count sessions by time period
        const sessionsToday = sessions.filter(s => new Date(s.start_time) >= todayStart).length;
        const sessionsThisWeek = sessions.filter(s => new Date(s.start_time) >= weekStart).length;

        // Top events by frequency
        const eventCounts = {};
        for (const event of events) {
            eventCounts[event.event_name] = (eventCounts[event.event_name] || 0) + 1;
        }
        const topEvents = Object.entries(eventCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));

        // Events per day (last 7 days)
        const eventsPerDay = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
            const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
            const count = events.filter(e => {
                const t = new Date(e.timestamp);
                return t >= dayStart && t < dayEnd;
            }).length;
            eventsPerDay.push({
                date: dayStart.toISOString().split('T')[0],
                count
            });
        }

        // Active sessions (started but not ended)
        const activeSessions = sessions.filter(s => !s.end_time).length;

        res.json({
            events: {
                total: events.length,
                today: eventsToday,
                this_week: eventsThisWeek,
                this_month: eventsThisMonth
            },
            sessions: {
                total: sessions.length,
                today: sessionsToday,
                this_week: sessionsThisWeek,
                active: activeSessions
            },
            top_events: topEvents,
            events_per_day: eventsPerDay
        });

    } catch (error) {
        console.error('Summary error:', error);
        res.status(500).json({ error: 'Failed to generate summary' });
    }
});

// Get property breakdown for a specific event (admin auth required)
app.get('/api/analytics/event-breakdown', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        const eventName = req.query.event_name;
        const propertyName = req.query.property;

        if (!eventName) {
            return res.status(400).json({ error: 'event_name query parameter is required' });
        }

        let events = loadAnalyticsEvents();

        // Filter to specific event
        events = events.filter(e => e.event_name === eventName);

        if (events.length === 0) {
            return res.json({
                event_name: eventName,
                total_count: 0,
                properties: {},
                breakdown: []
            });
        }

        // Get all property names used in this event
        const propertyNames = new Set();
        for (const event of events) {
            if (event.properties) {
                Object.keys(event.properties).forEach(key => propertyNames.add(key));
            }
        }

        // If a specific property is requested, get breakdown for that property
        if (propertyName) {
            const valueCounts = {};
            for (const event of events) {
                const value = event.properties?.[propertyName] || '(empty)';
                valueCounts[value] = (valueCounts[value] || 0) + 1;
            }

            const breakdown = Object.entries(valueCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([value, count]) => ({ value, count }));

            return res.json({
                event_name: eventName,
                property: propertyName,
                total_count: events.length,
                breakdown
            });
        }

        // Otherwise, return breakdown for all properties
        const allBreakdowns = {};
        for (const prop of propertyNames) {
            const valueCounts = {};
            for (const event of events) {
                const value = event.properties?.[prop] || '(empty)';
                valueCounts[value] = (valueCounts[value] || 0) + 1;
            }
            allBreakdowns[prop] = Object.entries(valueCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20) // Top 20 values per property
                .map(([value, count]) => ({ value, count }));
        }

        res.json({
            event_name: eventName,
            total_count: events.length,
            properties: [...propertyNames],
            breakdowns: allBreakdowns
        });

    } catch (error) {
        console.error('Event breakdown error:', error);
        res.status(500).json({ error: 'Failed to get event breakdown' });
    }
});

// Get unique event names (admin auth required)
app.get('/api/analytics/event-names', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        const events = loadAnalyticsEvents();
        const eventNames = [...new Set(events.map(e => e.event_name))];

        res.json({ event_names: eventNames.sort() });

    } catch (error) {
        console.error('Event names error:', error);
        res.status(500).json({ error: 'Failed to get event names' });
    }
});

// Clear analytics data (admin auth required)
app.delete('/api/analytics/clear', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        fs.writeJsonSync(ANALYTICS_EVENTS_FILE, []);
        fs.writeJsonSync(ANALYTICS_SESSIONS_FILE, []);

        console.log('Analytics data cleared');

        res.json({ success: true, message: 'Analytics data cleared' });

    } catch (error) {
        console.error('Clear analytics error:', error);
        res.status(500).json({ error: 'Failed to clear analytics' });
    }
});

// ============================================
// END ANALYTICS API ENDPOINTS
// ============================================

// Admin reset with secret key (production safe)
app.delete('/api/admin/reset', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';
    
    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
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

// Clear analytics data only (admin protected)
app.delete('/api/admin/reset-analytics', (req, res) => {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

    if (!adminKey || adminKey !== expectedKey) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }

    try {
        // Clear analytics events
        if (fs.existsSync(ANALYTICS_EVENTS_FILE)) {
            fs.writeJsonSync(ANALYTICS_EVENTS_FILE, []);
            console.log('Analytics events cleared');
        }

        // Clear analytics sessions
        if (fs.existsSync(ANALYTICS_SESSIONS_FILE)) {
            fs.writeJsonSync(ANALYTICS_SESSIONS_FILE, []);
            console.log('Analytics sessions cleared');
        }

        console.log('ADMIN RESET: Analytics data cleared');
        res.json({
            success: true,
            message: 'All analytics data has been cleared'
        });

    } catch (error) {
        console.error('Analytics reset error:', error);
        res.status(500).json({ error: 'Failed to clear analytics data' });
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
    console.log(`Server ready for connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
