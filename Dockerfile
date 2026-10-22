FROM node:24.22.1-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends libvips-tools libheif-plugin-libde265 ffmpeg tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples libheif-plugin-x265 \
 && rm -rf /var/lib/apt/lists/*
