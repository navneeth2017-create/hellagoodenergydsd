# Single-stage build to avoid layer caching issues with public folder
FROM node:20-alpine
WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files (this layer changes on every code change)
COPY server.js ./
COPY *.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]