#!/usr/bin/env node

/**
 * Download all 400 torrents from curated list in batches
 * This script handles the full process of downloading all torrents using
 * the existing infrastructure with proper error handling and batching
 */

import { execSync } from 'child_process';
import fs from 'fs';

// Check if aria2c is installed (dependency for downloading)
function checkAria2() {
    try {
        execSync('aria2c --version', { stdio: 'ignore' });
        return true;
    } catch (error) {
        console.error('aria2c is not installed. Please install it:');
        console.error('On macOS with Homebrew: brew install aria2');
        console.error('On Ubuntu/Debian: sudo apt install aria2');
        return false;
    }
}

// Function to process the curated list
function processCuratedList() {
    try {
        const curatedList = JSON.parse(fs.readFileSync('data/top_400_curated.json', 'utf8'));
        
        // Extract movies (handling both formats)
        let movies = [];
        if (Array.isArray(curatedList.movies)) {
            movies = curatedList.movies;
        } else if (Array.isArray(curatedList)) {
            movies = curatedList;
        }
        
        if (movies.length === 0) {
            throw new Error('No movies found in the curated list');
        }
        
        console.log(`Found ${movies.length} movies to process from curated list`);
        
        // Process the full list using existing infrastructure
        console.log('Starting batch torrent download process...');
        console.log('This will use the built-in process-list functionality with persistence.');
        
        // Run the existing processing command
        execSync('node torrent-finder-persistent.ts process-list movies', { stdio: 'inherit' });
        
        console.log('\n✓ All 400 torrents processed successfully!');
        console.log('Check the downloads/ directory for results.');
        
    } catch (error) {
        console.error('Error during download:', error.message);
        process.exit(1);
    }
}

// Main execution
if (!checkAria2()) {
    process.exit(1);
}

console.log('=== Downloading All 400 Torrents ===');
console.log('This script will process all movies from the curated list');
console.log('Progress is automatically saved to resume if interrupted');
console.log('');

processCuratedList();