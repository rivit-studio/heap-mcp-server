# syntax=docker/dockerfile:1

# ---- Build stage ---------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app

# Install all deps (including dev deps needed to compile TypeScript).
COPY package.json package-lock.json ./
RUN npm ci

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage -------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from the build stage.
COPY --from=build /app/dist ./dist

# Default to the HTTP transport so the container exposes a network endpoint.
ENV TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

# Liveness probe against the built-in /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the unprivileged user that the node image ships with.
USER node

CMD ["node", "dist/index.js"]

# Build:  docker build -t heap-mcp-server .
# Run:    docker run --rm -p 3000:3000 \
#           -e HEAP_APP_ID=your_app_id \
#           -e HEAP_API_KEY=optional_for_deletion \
#           -e HEAP_DATA_CENTER=us \
#           heap-mcp-server
# MCP endpoint: POST http://localhost:3000/mcp   Health: GET /health
