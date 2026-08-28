FROM node:22-alpine

# Create app directory
WORKDIR /app

# Create user data directory
RUN mkdir -p /userdata && chmod 755 /userdata

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Use the unprivileged user the base image already ships, rather than creating
# one at a hard-coded uid that a future base image may have taken.
RUN chown -R node:node /app /userdata
USER node

# Expose port
EXPOSE 3000

# Set default environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/userdata
ENV PORT=3000

# Start the application. node directly, not npm: npm as PID 1 does not forward
# SIGTERM to the server, so the container only stops on the kill timeout.
CMD ["node", "server.js"]
