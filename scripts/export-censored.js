#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

// Configuration - set via environment variables or use defaults
const SERVER_URL = process.env.SERVER_URL || 'https://smallspaces-design-server-production.up.railway.app';
const ADMIN_KEY = process.env.ADMIN_RESET_KEY || 'smallspaces-reset-2025';

console.log('Exporting censored entries from:', SERVER_URL);
console.log('Using admin key:', ADMIN_KEY.substring(0, 10) + '...');

const url = `${SERVER_URL}/api/admin/export-censored?adminKey=${ADMIN_KEY}`;

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`✗ Error: Server returned status ${res.statusCode}`);
      console.error(data);
      process.exit(1);
    }

    fs.writeFileSync('censored_entries.json', data);
    const json = JSON.parse(data);

    console.log(`\n✓ Successfully exported ${json.total_censored} censored entries to censored_entries.json`);

    if (json.total_censored === 0) {
      console.log('\n🎉 No censored entries found! All clean.');
    } else {
      console.log('\n📝 Next steps:');
      console.log('1. Open censored_entries.json in a text editor');
      console.log('2. Fill in corrected_title and corrected_author fields for each entry');
      console.log('3. Copy the entries array to a new file called corrections.json:');
      console.log('   {');
      console.log('     "corrections": [');
      console.log('       { "id": "...", "corrected_title": "...", "corrected_author": "..." },');
      console.log('       ...');
      console.log('     ]');
      console.log('   }');
      console.log('4. Run: node scripts/import-corrections.js corrections.json');
      console.log('\n💡 Tip: You only need to include entries you want to correct in corrections.json');
    }
  });
}).on('error', (err) => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
