FROM node:24.22.1-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends libvips-tools libheif-plugin-libde265 ffmpeg tzdata \
 && rm -rf /var/lib/apt/lists/*
# vipsthumbnail picks its loader by what a file contains, not by its name, so an SVG called x.png would still go to the SVG renderer.
# This makes libvips refuse the loaders that are unsafe for hostile files; the formats the gallery lists don't need them.
ENV VIPS_BLOCK_UNTRUSTED=1
WORKDIR /app

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples libheif-plugin-x265 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production MEDIA_ROOT=/media DATA_DIR=/data PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/web/dist ./web/dist
COPY docker/gallery /usr/local/bin/gallery
RUN chmod 755 /usr/local/bin/gallery && rm -rf server/test
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
