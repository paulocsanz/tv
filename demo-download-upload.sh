#!/bin/bash

# Demo: Download single torrent and simulate upload to S3
echo "=== Torrent Download & Upload Demo ==="
echo ""

# Check if aria2c is installed
if ! command -v aria2c &> /dev/null; then
    echo "aria2c is required but not installed."
    echo "Install it with: brew install aria2 (macOS) or sudo apt install aria2 (Ubuntu)"
    exit 1
fi

echo "Running demo using existing torrent finder system..."

# Download a sample movie torrent
echo ""
echo "Downloading The Shawshank Redemption torrent..."
node download-single-torrent.js "The Shawshank Redemption"

# List downloaded torrents
echo ""
echo "Available torrents:"
ls -la downloads/*.torrent | head -5

echo ""
echo "Demo complete!"
echo "In a real Railway environment, you would:"
echo "1. Set S3 environment variables"
echo "2. Run node upload-to-s3.js /path/to/torrent.torrent"

# Show the upload script for reference
echo ""
echo "S3 Upload Script (upload-to-s3.js) contents:"
cat upload-to-s3.js | head -20