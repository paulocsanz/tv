#!/usr/bin/env node

/**
 * Upload a torrent file to S3 bucket (Railway)
 * This script prepares the upload of torrent files to Railway's S3 storage
 */

import fs from 'fs';
import path from 'path';

// Check if we have an S3 configuration
function checkS3Config() {
    // These would normally be environment variables in Railway
    const requiredVars = [
        'S3_ENDPOINT_URL',
        'S3_ACCESS_KEY_ID', 
        'S3_SECRET_ACCESS_KEY',
        'S3_BUCKET_NAME'
    ];
    
    const missing = requiredVars.filter(varName => !process.env[varName]);
    
    if (missing.length > 0) {
        console.log('Warning: Missing S3 environment variables:');
        missing.forEach(varName => console.log(`  - ${varName}`));
        console.log('\nWhen running on Railway, these should be configured in the environment.');
        return false;
    }
    
    return true;
}

// Upload a single torrent file to S3
function uploadTorrentToS3(filePath) {
    if (!checkS3Config()) {
        console.log('S3 configuration missing. Upload skipped.');
        console.log('On Railway, ensure S3 env vars are set');
        return false;
    }
    
    const filename = path.basename(filePath);
    console.log(`Uploading ${filename} to S3 bucket...`);
    
    // In a real implementation we would use AWS SDK v3 or similar
    // This is a placeholder that shows how it would work
    
    console.log('S3 upload completed (simulated)');
    return true;
}

// Main execution
if (process.argv.length < 3) {
    console.log('Usage: node upload-to-s3.js /path/to/torrent/file.torrent');
    process.exit(1);
}

const torrentPath = process.argv[2];

if (!fs.existsSync(torrentPath)) {
    console.error(`Torrent file not found: ${torrentPath}`);
    process.exit(1);
}

if (path.extname(torrentPath) !== '.torrent') {
    console.error('File must be a .torrent file');
    process.exit(1);
}

console.log('Uploading torrent to S3 bucket...');
uploadTorrentToS3(torrentPath);