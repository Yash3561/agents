FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

ARG SENTRY_AUTH_TOKEN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
# SENTRY_RELEASE is read by sentryVitePlugin during `npm run build` to tag source maps
ENV SENTRY_RELEASE=$BUILD_VERSION

COPY package.json package-lock.json* ./

# Install all deps (including devDeps) so vite plugins are available at build time.
# NODE_ENV override is required — npm omits devDeps automatically when NODE_ENV=production.
RUN HUSKY=0 NODE_ENV=development npm ci

COPY . .

RUN npm run build

# Prune devDeps after build — keeps final image lean
RUN npm prune --omit=dev && npm cache clean --force

# Remove source maps from final image — they were uploaded to Sentry during build
RUN find ./build -name "*.map" -delete

CMD ["npm", "run", "docker-start"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
