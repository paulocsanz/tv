#!/usr/bin/env node

/**
 * Simple test script to verify functionality before running full list
 */

import { execSync } from 'child_process';
import fs from 'fs';

// Check if aria2c is available (dependency for downloading)
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

// Check dependencies
if (!checkAria2()) {
    process.exit(1);
}

console.log('Testing script structure and connectivity...');

// Verify the required files exist
const curatedListPath = 'data/top_400_curated.json';
if (!fs.existsSync(curatedListPath)) {
    console.error(`Curated list not found at ${curatedListPath}`);
    process.exit(1);
}

console.log('✓ Required files verified');

try {
    // Test a single item processing
    console.log('Testing single movie processing...');
    const testMovie = "The Shawshank Redemption";
    execSync(`node torrent-finder-persistent.ts "find-torrent" "${testMovie}" 5 10`, { stdio: 'inherit' });
    console.log('✓ Single movie test completed');
} catch (error) {
    console.error('Error in test:', error.message);
}