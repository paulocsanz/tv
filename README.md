# Torrent Finder with Persistent Resume

A comprehensive torrent finder that processes cached JSON lists with persistence support.

## Features

- **JSON List Processing**: Process cached lists of movies or TV shows from `data/` directory
- **Progress Persistence**: Automatically resumes from where it left off if interrupted
- **Sequential & Parallel Modes**: Both processing approaches supported
- **Quality Ranking**: Select torrents based on seeders/leechers ratio
- **Local Saving**: Save torrent files locally during processing

## Usage

### 1. Find individual torrents
```bash
node torrent-finder-persistent.ts "Breaking Bad" 5 10
```

### 2. Process cached movie list sequentially (resumes automatically)
```bash
node torrent-finder-persistent.ts process-list movies
```

### 3. Process cached TV series list in parallel
```bash
node torrent-finder-persistent.ts process-list tv parallel
```

### 4. Analyze local torrents
```bash
node torrent-finder-persistent.ts analyze ./downloads
```

## How Persistence Works

The script automatically:
1. **Saves progress** every 10 items processed (in `.torrent_finder_progress.json`)
2. **Resumes from last checkpoint** when restarted
3. **Clears progress file** when processing completes successfully

Progress tracking prevents loss of work if the process is interrupted.

## Data Sources

The script uses cached JSON files in the `data/` directory:
- `data/movies/best_1000_movies.json` - List of top movies (example)
- `data/tv/best_1000_tv_series.json` - List of top TV series (example)

## Quality Selection

Torrents are ranked by a quality score based on the formula:
```
quality_score = (seeders * 2.0) + (leechers * -1.0)
```

This prioritizes torrents with more seeders and fewer leechers.

## Output 

- Torrents saved in `./downloads/` directory
- Progress information displayed during processing
- Each torrent filename includes the title, season, and episode

## Requirements

Node.js 14+

### Installing aria2c (Required)

To download torrents, you must install `aria2c`:

**On macOS with Homebrew:**
```bash
brew install aria2
```

**On Ubuntu/Debian:**
```bash
sudo apt install aria2
```

## How to Download All 400 Torrents

For downloading all torrents from the curated 400-item list:
1. Install `aria2c` (see above)
2. Run:
```bash
node download-all-torrents.js
```
This script will:
- Convert the curated `data/top_400_curated.json` to the required format
- Process each movie using the existing torrent finder infrastructure  
- Save progress automatically to resume if interrupted
- Download all torrents to the `downloads/` directory

## Important Notes

- The process may take several hours to complete for 400 items
- Progress is saved every 10 items to prevent data loss
- Make sure you have sufficient disk space in the downloads directory