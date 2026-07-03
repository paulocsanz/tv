# Torrent to S3 Upload Example

This example demonstrates how to use the torrent downloader and S3 uploader tools.

## Prerequisites

1. Install system dependencies:
```bash
# macOS
brew install aria2

# Ubuntu/Debian
sudo apt install aria2
```

2. Install Node.js dependencies:
```bash
npm install
```

## Usage Example

### 1. Download a torrent file locally:

```bash
TORRENT_URL="https://releasenotes.org/torrents/show-123.torrent" npm run download
```

This will download the torrent to `./downloads/downloaded.torrent`.

### 2. Upload to S3 bucket (using environment variables):

```bash
S3_BUCKET_NAME="your-tv-bucket-name" LOCAL_FILE_PATH="./downloads/downloaded.torrent" npm run upload
```

### 3. Complete workflow in one step:

```bash
TORRENT_URL="https://releasenotes.org/torrents/show-123.torrent" S3_BUCKET_NAME="your-tv-bucket-name" npm run torrent-to-s3
```

## Railway Integration

When deployed to Railway:

1. The `.railway/railway.ts` file will create an S3 bucket named `tv-bucket`
2. Environment variables like `RAILWAY_BUCKET_NAME` will be automatically set
3. AWS credentials will be automatically managed by Railway

## Environment Variables Reference

- `TORRENT_URL`: URL of the torrent file to download (required for download/upload)
- `S3_BUCKET_NAME`: Name of S3 bucket to upload to (required for upload)
- `LOCAL_FILE_PATH`: Local path of file to upload (required for upload command)
- `AWS_REGION`: AWS region for S3 operations (default: us-east-1)