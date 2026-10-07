FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm run browser:install \
    && chmod -R a+rX /ms-playwright

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
