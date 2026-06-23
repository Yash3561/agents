FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

ARG SENTRY_AUTH_TOKEN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN

COPY package.json package-lock.json* ./

RUN HUSKY=0 npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Remove source maps from final image — they were uploaded to Sentry during build
RUN find ./build -name "*.map" -delete

CMD ["npm", "run", "docker-start"]
