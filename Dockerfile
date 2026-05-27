# Use the official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies. `npm ci` is deterministic (installs exactly the
# lockfile) and fails the build on any error — unlike `npm install`, which has
# historically exited 0 on partial failures ("Exit handler never called!"),
# silently producing broken images.
RUN npm config set registry https://feeds.sectra.net/npm/ && npm ci --omit=dev

# Copy the rest of the application code
COPY src ./src

# Expose the port the app runs on (adjust if your app uses a different port)
EXPOSE 3000

# Define the command to run the application
CMD ["npm", "start"]
