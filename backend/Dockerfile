# WBIC contact-API. Bouwen vanuit backend/:
#   docker buildx build --platform linux/amd64 --build-arg COMMIT_SHA=$(git rev-parse HEAD) -t wbic-backend:<tag> backend
# Twee fasen: npm ci draait op het BOUWplatform (geen emulatie nodig) en het
# resultaat gaat naar het doelplatform. Dat kan omdat alle afhankelijkheden puur
# JavaScript zijn (geen native modules, geen install-scripts; npm ci draait met
# --ignore-scripts). Basis gepind op digest; npm ci haalt exact de lockfile-versies.
FROM --platform=$BUILDPLATFORM node:18-alpine@sha256:8d6421d663b4c28fd3ebc498332f249011d118945588d0a35cb9bc4b8ca09d9e AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:18-alpine@sha256:8d6421d663b4c28fd3ebc498332f249011d118945588d0a35cb9bc4b8ca09d9e
ARG COMMIT_SHA
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
USER node
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/awalania-creator/wbic-website" org.opencontainers.image.revision="${COMMIT_SHA}"
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget --spider -q http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
