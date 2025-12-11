# Quick Start: Fix Censored Entries

## TL;DR - 4 Simple Steps

### 1. Export censored entries
```bash
cd server
node scripts/export-censored.js
```

This creates `censored_entries.json` with all entries containing asterisks.

### 2. Create corrections file

Copy this template to `corrections.json`:

```json
{
  "corrections": [
    {
      "id": "copy-from-export",
      "corrected_title": "Write correct title here",
      "corrected_author": "Write correct author here"
    }
  ]
}
```

Open `censored_entries.json`, find entries that need fixing, and add them to `corrections.json` with the corrected text.

**Example:**

From `censored_entries.json`:
```json
{
  "id": "ABC123",
  "title": "Cl***y Living Room",
  "author_name": "John***in"
}
```

Add to `corrections.json`:
```json
{
  "corrections": [
    {
      "id": "ABC123",
      "corrected_title": "Classy Living Room",
      "corrected_author": "Johnassin"
    }
  ]
}
```

### 3. Import corrections
```bash
node scripts/import-corrections.js corrections.json
```

### 4. Verify
Check the output for success messages!

## Common Censorship Patterns

| Censored | Likely Original | Reason |
|----------|----------------|--------|
| Cl***y | Classy | "ass" |
| Gl*** | Glass | "ass" |
| M***age | Massage | "ass" |
| P***port | Passport | "ass" |
| Emb***y | Embassy | "ass" |
| Cl***ic | Classic | "ass" |

## Tips

- **Only include entries you want to fix** in `corrections.json`
- **Leave corrected_title or corrected_author empty** if that field doesn't need fixing
- **Save backups** before importing
- **Process in batches** if you have hundreds of entries

## Full Documentation

See `MANUAL_CENSORSHIP_CORRECTION_WORKFLOW.md` for complete details.

## Environment Variables (Optional)

Set these if you want to use a different server:

```bash
export SERVER_URL="https://your-server.railway.app"
export ADMIN_RESET_KEY="your-admin-key"
```

Then run the scripts as normal.
