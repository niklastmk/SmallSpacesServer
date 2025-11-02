#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

// Configuration - set via environment variables or use defaults
const SERVER_URL = process.env.SERVER_URL || 'https://smallspaces-design-server-production.up.railway.app';
const ADMIN_KEY = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

const correctionsFile = process.argv[2] || 'corrections.json';

console.log('Importing corrections from:', correctionsFile);
console.log('Target server:', SERVER_URL);

// Check if file exists
if (!fs.existsSync(correctionsFile)) {
  console.error(`✗ Error: File '${correctionsFile}' not found`);
  console.log('\nUsage: node scripts/import-corrections.js <corrections-file.json>');
  console.log('Example: node scripts/import-corrections.js corrections.json');
  process.exit(1);
}

// Read and parse corrections file
let corrections;
try {
  corrections = JSON.parse(fs.readFileSync(correctionsFile, 'utf8'));
} catch (err) {
  console.error('✗ Error parsing JSON file:', err.message);
  process.exit(1);
}

// Validate format
if (!corrections.corrections || !Array.isArray(corrections.corrections)) {
  console.error('✗ Error: Invalid format. Expected { "corrections": [...] }');
  process.exit(1);
}

console.log(`Found ${corrections.corrections.length} correction(s) to apply\n`);

// Prepare request
const data = JSON.stringify(corrections);

const url = new URL(`${SERVER_URL}/api/admin/import-corrections`);

const options = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
    'Content-Length': data.length
  }
};

const req = https.request(url, options, (res) => {
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`✗ Error: Server returned status ${res.statusCode}`);
      console.error(responseData);
      process.exit(1);
    }

    const json = JSON.parse(responseData);

    console.log(`✓ Successfully applied ${json.applied} correction(s)`);
    console.log(`Total processed: ${json.total_processed}\n`);

    if (json.results && json.results.length > 0) {
      console.log('Detailed Results:');
      console.log('─'.repeat(80));

      let successCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      json.results.forEach((result) => {
        if (result.status === 'success') {
          successCount++;
          console.log(`✓ ${result.id.substring(0, 8)}... → "${result.new_title}" by ${result.new_author}`);
        } else if (result.status === 'skipped') {
          skippedCount++;
          console.log(`- ${result.id.substring(0, 8)}... → Skipped: ${result.message}`);
        } else {
          errorCount++;
          console.log(`✗ ${result.id.substring(0, 8)}... → Error: ${result.message}`);
        }
      });

      console.log('─'.repeat(80));
      console.log(`\nSummary: ${successCount} succeeded, ${skippedCount} skipped, ${errorCount} errors`);
    }

    console.log('\n🎉 Import complete!');
  });
});

req.on('error', (err) => {
  console.error('✗ Network error:', err.message);
  process.exit(1);
});

req.write(data);
req.end();
