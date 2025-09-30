FROM node:18-alpine

# Create app directory
WORKDIR /app

# Create user data directory
RUN mkdir -p /userdata && chmod 755 /userdata

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of app and userdata directories
RUN chown -R nodejs:nodejs /app /userdata

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Set default environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/userdata
ENV PORT=3000

# Start the application
CMD ["npm", "start"]