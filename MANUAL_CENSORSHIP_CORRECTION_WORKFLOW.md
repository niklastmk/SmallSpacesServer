# Manual Censorship Correction Workflow

This guide explains how to manually correct entries that were incorrectly censored by the profanity filter.

## Problem

The profanity filter censored words containing substrings like "ass" (e.g., "classy" → "cl***y"). While we fixed common English words with the auto-repair script, many entries remain censored:
- Non-English words
- Uncommon words
- Words not in our repair library

## Solution: Manual Correction Workflow

### Step 1: Export Censored Entries

Export all entries with asterisks (*) to a JSON file:

```bash
curl -X GET "https://your-server.railway.app/api/admin/export-censored?adminKey=smallspaces-reset-2025" \
  -H "Content-Type: application/json" \
  -o censored_entries.json
```

**Or using the included script:**

```bash
node scripts/export-censored.js
```

This creates `censored_entries.json` containing all entries with asterisks.

### Step 2: Manually Fill in Corrections

Open `censored_entries.json` in a text editor. You'll see entries like:

```json
{
  "success": true,
  "total_censored": 15,
  "entries": [
    {
      "id": "abc-123",
      "title": "Cl***y Living Room",
      "author_name": "John***in",
      "corrected_title": "",
      "corrected_author": "",
      "upload_date": "2025-11-01",
      "download_count": 42
    },
    {
      "id": "def-456",
      "title": "M***age Studio",
      "author_name": "PlayerName",
      "corrected_title": "",
      "corrected_author": "PlayerName",
      "upload_date": "2025-11-02",
      "download_count": 18
    }
  ]
}
```

**Fill in the `corrected_title` and `corrected_author` fields:**

```json
{
  "id": "abc-123",
  "title": "Cl***y Living Room",
  "author_name": "John***in",
  "corrected_title": "Classy Living Room",
  "corrected_author": "Johnassin",
  "upload_date": "2025-11-01",
  "download_count": 42
}
```

**Important:**
- Only fill in fields that need correction
- If title is fine but author is censored, only fill `corrected_author`
- Leave both blank to skip that entry
- If you can't figure out the original word, you can make a best guess or leave it censored

### Step 3: Prepare Corrections File

Copy just the `entries` array to a new file called `corrections.json`:

```json
{
  "corrections": [
    {
      "id": "abc-123",
      "corrected_title": "Classy Living Room",
      "corrected_author": "Johnassin"
    },
    {
      "id": "def-456",
      "corrected_title": "Massage Studio",
      "corrected_author": ""
    }
  ]
}
```

**Note:** You only need to include entries you want to correct. Remove entries you want to skip.

### Step 4: Import Corrections

Upload your corrections back to the server:

```bash
curl -X POST "https://your-server.railway.app/api/admin/import-corrections" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: smallspaces-reset-2025" \
  -d @corrections.json
```

**Or using the included script:**

```bash
node scripts/import-corrections.js corrections.json
```

### Step 5: Verify Results

The response will show which corrections were applied:

```json
{
  "success": true,
  "message": "Applied 15 corrections",
  "total_processed": 20,
  "applied": 15,
  "results": [
    {
      "id": "abc-123",
      "status": "success",
      "new_title": "Classy Living Room",
      "new_author": "Johnassin"
    },
    {
      "id": "def-456",
      "status": "success",
      "new_title": "Massage Studio",
      "new_author": "PlayerName"
    },
    {
      "id": "xyz-789",
      "status": "skipped",
      "message": "No corrections provided"
    }
  ]
}
```

## Helper Scripts

### export-censored.js

```javascript
const https = require('https');
const fs = require('fs');

const SERVER_URL = process.env.SERVER_URL || 'https://your-server.railway.app';
const ADMIN_KEY = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

const url = `${SERVER_URL}/api/admin/export-censored?adminKey=${ADMIN_KEY}`;

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    fs.writeFileSync('censored_entries.json', data);
    const json = JSON.parse(data);
    console.log(`✓ Exported ${json.total_censored} censored entries to censored_entries.json`);
    console.log('\nNext steps:');
    console.log('1. Open censored_entries.json');
    console.log('2. Fill in corrected_title and corrected_author fields');
    console.log('3. Save the corrections array to corrections.json');
    console.log('4. Run: node scripts/import-corrections.js corrections.json');
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
```

### import-corrections.js

```javascript
const https = require('https');
const fs = require('fs');

const SERVER_URL = process.env.SERVER_URL || 'https://your-server.railway.app';
const ADMIN_KEY = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

const correctionsFile = process.argv[2] || 'corrections.json';

if (!fs.existsSync(correctionsFile)) {
  console.error(`Error: File '${correctionsFile}' not found`);
  console.log('Usage: node import-corrections.js <corrections-file.json>');
  process.exit(1);
}

const corrections = JSON.parse(fs.readFileSync(correctionsFile, 'utf8'));

const data = JSON.stringify(corrections);

const options = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': ADMIN_KEY,
    'Content-Length': data.length
  }
};

const url = new URL(`${SERVER_URL}/api/admin/import-corrections`);

const req = https.request(url, options, (res) => {
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    const json = JSON.parse(responseData);
    console.log(`✓ Applied ${json.applied} corrections`);
    console.log(`Total processed: ${json.total_processed}`);
    console.log('\nResults:');
    json.results.forEach((result) => {
      if (result.status === 'success') {
        console.log(`  ✓ ${result.id}: ${result.new_title}`);
      } else if (result.status === 'skipped') {
        console.log(`  - ${result.id}: ${result.message}`);
      } else {
        console.log(`  ✗ ${result.id}: ${result.message}`);
      }
    });
  });
});

req.on('error', (err) => {
  console.error('Error:', err.message);
});

req.write(data);
req.end();
```

## Tips for Manual Correction

1. **Look for patterns**: Many censored words follow similar patterns
   - "***" replacing "ass"
   - "*" replacing individual letters

2. **Context clues**: Use upload date and download count to guess popularity/language

3. **Common words**:
   - Cl***y → Classy
   - Gl*** → Glass
   - M***age → Massage
   - P***port → Passport
   - Emb***y → Embassy

4. **Non-English examples**:
   - Kl***e → Klasse (German for "class")
   - M***a → Massa (various languages)

5. **When in doubt**: Leave it blank and skip that entry

## Batch Processing

If you have hundreds of entries, you can:

1. Export all
2. Process in batches (e.g., 50 at a time)
3. Import each batch separately
4. This prevents losing work if there's an error

## Backup Before Importing

Always keep a backup of your corrections file before importing!

```bash
cp corrections.json corrections_backup_$(date +%Y%m%d).json
```
