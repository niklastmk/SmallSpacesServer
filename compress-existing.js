const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');

// Storage directories - use persistent volume on Railway Pro
const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'storage');
const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');
const METADATA_FILE = path.join(STORAGE_DIR, 'metadata.json');

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

async function compressExistingThumbnail(filename) {
    try {
        const filePath = path.join(THUMBNAILS_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            console.log(`⚠️  File not found: ${filename}`);
            return null;
        }

        // Skip if already compressed (JPEG files)
        if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) {
            console.log(`⏩ Already compressed: ${filename}`);
            return filename;
        }

        const buffer = fs.readFileSync(filePath);
        const originalSize = buffer.length;
        
        // Skip if already small enough (under 200KB)
        if (originalSize < 200 * 1024) {
            console.log(`⏩ Already small enough: ${filename} (${(originalSize/1024).toFixed(0)}KB)`);
            return filename;
        }
        
        // Compress and resize
        const compressedBuffer = await sharp(buffer)
            .resize(400, null, { 
                withoutEnlargement: true,
                fit: 'inside'
            })
            .jpeg({ 
                quality: 80,
                progressive: true 
            })
            .toBuffer();
        
        // Create new JPEG filename
        const jpegFilename = filename.replace(/\.png$/i, '.jpg');
        const jpegPath = path.join(THUMBNAILS_DIR, jpegFilename);
        
        // Save compressed version
        fs.writeFileSync(jpegPath, compressedBuffer);
        
        // Remove original PNG if compression was successful
        if (filename !== jpegFilename) {
            fs.removeSync(filePath);
        }
        
        const compressedSize = compressedBuffer.length;
        const savings = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
        
        console.log(`✅ ${filename} → ${jpegFilename}: ${(originalSize/1024/1024).toFixed(1)}MB → ${(compressedSize/1024).toFixed(0)}KB (${savings}% savings)`);
        
        return jpegFilename;
    } catch (error) {
        console.error(`❌ Error compressing ${filename}:`, error.message);
        return filename; // Return original filename if compression fails
    }
}

async function bulkCompressExistingThumbnails() {
    console.log('🚀 Starting bulk compression of existing thumbnails...\n');
    
    if (!fs.existsSync(THUMBNAILS_DIR)) {
        console.log('❌ Thumbnails directory not found!');
        return;
    }
    
    // Get all PNG files in thumbnails directory
    const files = fs.readdirSync(THUMBNAILS_DIR)
        .filter(file => file.toLowerCase().endsWith('.png'));
    
    if (files.length === 0) {
        console.log('ℹ️  No PNG thumbnails found to compress.');
        return;
    }
    
    console.log(`Found ${files.length} PNG thumbnails to process.\n`);
    
    let totalOriginalSize = 0;
    let totalCompressedSize = 0;
    let processed = 0;
    let failed = 0;
    
    // Load metadata to update thumbnail URLs
    const metadata = loadMetadata();
    let metadataChanged = false;
    
    for (const filename of files) {
        const originalPath = path.join(THUMBNAILS_DIR, filename);
        const originalSize = fs.statSync(originalPath).size;
        totalOriginalSize += originalSize;
        
        const compressedFilename = await compressExistingThumbnail(filename);
        
        if (compressedFilename && compressedFilename !== filename) {
            // Update metadata to point to new JPEG file
            const designId = filename.replace(/\.png$/i, '');
            const design = metadata.find(d => d.id === designId);
            if (design && design.thumbnail_url) {
                design.thumbnail_url = `/api/thumbnails/${compressedFilename}`;
                metadataChanged = true;
            }
            
            const compressedPath = path.join(THUMBNAILS_DIR, compressedFilename);
            if (fs.existsSync(compressedPath)) {
                totalCompressedSize += fs.statSync(compressedPath).size;
                processed++;
            } else {
                failed++;
            }
        } else if (compressedFilename === filename) {
            // File was skipped (already small or already JPEG)
            totalCompressedSize += originalSize;
        } else {
            failed++;
        }
    }
    
    // Save updated metadata if any URLs changed
    if (metadataChanged) {
        saveMetadata(metadata);
        console.log('\n📝 Updated metadata with new thumbnail URLs');
    }
    
    const totalSavings = ((totalOriginalSize - totalCompressedSize) / totalOriginalSize * 100).toFixed(1);
    
    console.log('\n🎉 Bulk compression complete!');
    console.log(`📊 Results: ${processed} processed, ${failed} failed`);
    console.log(`💾 Total size: ${(totalOriginalSize/1024/1024).toFixed(1)}MB → ${(totalCompressedSize/1024/1024).toFixed(1)}MB`);
    console.log(`🎯 Total savings: ${totalSavings}% (${((totalOriginalSize - totalCompressedSize)/1024/1024).toFixed(1)}MB saved)`);
}

// Run the bulk compression
if (require.main === module) {
    bulkCompressExistingThumbnails()
        .then(() => {
            console.log('\n✅ Script completed successfully!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { bulkCompressExistingThumbnails };