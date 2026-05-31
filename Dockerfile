# Bun + GDAL runtime for geoportal-sqlite-downloader
FROM oven/bun:1.3.14-debian

# GDAL CLI (ogrinfo/ogr2ogr) and unzip are required by the sync pipeline.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gdal-bin unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
# Puppeteer is a declared dependency but is not imported anywhere in src/,
# so skip its Chromium download to keep the image small.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source.
COPY src ./src

# The SQLite DB and download cache live here and must be a persistent volume.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
