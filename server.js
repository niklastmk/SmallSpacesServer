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

// Storage directories - use persistent volume on Railway Pro
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'storage');
const DESIGNS_DIR = path.join(STORAGE_DIR, 'designs');
const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');
const METADATA_FILE = path.join(STORAGE_DIR, 'metadata.json');

// Ensure storage directories exist
try {
    fs.ensureDirSync(DESIGNS_DIR);
    fs.ensureDirSync(THUMBNAILS_DIR);
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
        
        // Compress only (keep original resolution): 80% quality JPEG
        const compressedBuffer = await sharp(buffer)
            .jpeg({ 
                quality: 80,
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
        const { designId, title, description, authorName, level, saveData, thumbnail } = req.body;


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
                thumbnail_url: thumbnailUrl || existingDesign.thumbnail_url // Use new thumbnail or keep existing
            };
            console.log(`Design updated: ${title} by ${authorName} (ID: ${finalDesignId})`);
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
                thumbnail_url: thumbnailUrl
            };
            allMetadata.push(designMetadata);
            console.log(`Design created: ${title} by ${authorName} (ID: ${finalDesignId})`);
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
        const allMetadata = loadMetadata();
        
        // Get sort parameter (default to date sorting for backward compatibility)
        const sortMode = req.query.sort || 'date';
        
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
        
        // ALWAYS return ALL designs - no pagination
        console.log(`Browse request: returning ALL designs (${allMetadata.length}), sort=${sortMode}`);
        
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
        let thumbnailUrl = null;
        
        if (designIndex !== -1) {
            allMetadata[designIndex].download_count += 1;
            thumbnailUrl = allMetadata[designIndex].thumbnail_url;
            saveMetadata(allMetadata);
        }

        // Read and return design file (explicitly as binary)
        const designData = fs.readFileSync(designPath);
        const base64Data = Buffer.from(designData).toString('base64');

        console.log(`Design downloaded: ${designId}`);
        res.json({
            saveData: base64Data,
            design_id: designId,
            thumbnail_url: thumbnailUrl
        });

    } catch (error) {
        console.error('Download error:', error);
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
        endpoints: [
            'POST /api/designs - Upload design',
            'GET /api/designs - Browse designs',
            'POST /api/designs/:id/download - Download design',
            'DELETE /api/designs/:id - Delete design by ID',
            'POST /api/admin/repair-censored - Repair censored text (requires admin key)',
            'GET /api/health - Health check'
        ]
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
                        quality: 80,
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