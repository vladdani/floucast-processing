# Multi-stage build for optimized production image
FROM node:18-alpine AS base

# Install system dependencies for document/image processing
RUN apk add --no-cache \
    vips-dev \
    vips \
    python3 \
    make \
    g++ \
    libheif-dev \
    curl \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# Production stage
FROM node:18-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    vips \
    libheif \
    curl \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy installed node_modules from base stage
COPY --from=base /app/node_modules ./node_modules

# Copy application code
COPY src/ ./src/
COPY package*.json ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S processor -u 1001 -G nodejs

# Change ownership to processor user
RUN chown -R processor:nodejs /app
USER processor

# Expose port
EXPOSE 8080

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "src/server.js"]