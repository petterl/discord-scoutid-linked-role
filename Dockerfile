# Use the official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY src ./src

# Expose the port the app runs on (adjust if your app uses a different port)
EXPOSE 3000

# Define the command to run the application
CMD ["npm", "start"]
