# Duomenys

This project uses Bun to extract, process, and synchronize spatial datasets from the Lithuanian Geoportal into a local SQLite database.

## System Requirements

This project relies on **GDAL** command-line utilities (`ogrinfo` and `ogr2ogr`) for robust and high-performance processing of complex geospatial files (e.g., GML, GPKG, FileGDB).

You **must** install GDAL on your system before running the sync CLI.

### macOS (Apple Silicon or Intel)
Using Homebrew:
```bash
brew install gdal
```

### Linux (Ubuntu/Debian)
Using APT:
```bash
sudo apt-get update
sudo apt-get install gdal-bin
```

### Windows
You can install GDAL via OSGeo4W or by using Conda, but it is highly recommended to run this project inside WSL (Windows Subsystem for Linux) and follow the Linux instructions.

## Usage

Start the synchronization process using Bun:
```bash
bun run src/scripts/sync.ts
```
