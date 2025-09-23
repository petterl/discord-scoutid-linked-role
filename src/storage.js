import { createClient } from "redis";
import config from "./config.js";

// Create Redis client
const client = createClient({
  url: config.REDIS_URL,
});

// Connect to Redis and handle errors
client.on("error", (err) => console.error("Redis Client Error", err));
client.on("connect", () => console.log("Connected to Redis"));

// Initialize connection
let isConnected = false;
async function ensureConnection() {
  if (!isConnected) {
    await client.connect();
    isConnected = true;
  }
}

// Initialize on module load
ensureConnection().catch(console.error);

export async function storeDiscordTokens(userId, tokens) {
  await ensureConnection();
  await client.setEx(`discord-${userId}`, 3600, JSON.stringify(tokens)); // 1 hour expiry
}

export async function getDiscordTokens(userId) {
  await ensureConnection();
  const data = await client.get(`discord-${userId}`);
  return data ? JSON.parse(data) : null;
}

export async function storeStateData(state, data) {
  await ensureConnection();
  await client.setEx(`state-${state}`, 600, JSON.stringify(data)); // 10 minutes expiry
}

export async function getStateData(state) {
  await ensureConnection();
  const data = await client.get(`state-${state}`);
  return data ? JSON.parse(data) : null;
}

export async function storeScoutIDTokens(userId, tokens) {
  await ensureConnection();
  await client.setEx(`scoutid-${userId}`, 3600, JSON.stringify(tokens)); // 1 hour expiry
}

export async function getScoutIDTokens(userId) {
  await ensureConnection();
  const data = await client.get(`scoutid-${userId}`);
  return data ? JSON.parse(data) : null;
}

export async function getLinkedScoutIDUserId(discordUserId) {
  await ensureConnection();
  return await client.get(`discord-link-${discordUserId}`);
}

export async function setLinkedScoutIDUserId(discordUserId, scoutUserId) {
  await ensureConnection();
  await client.set(`discord-link-${discordUserId}`, scoutUserId);
}

export async function deleteLinkedScoutIDUserId(discordUserId) {
  await ensureConnection();
  await client.del(`discord-link-${discordUserId}`);
}

export async function storeScoutNetdata(type, data) {
  await ensureConnection();
  await client.setEx(`scoutnet-${type}`, 600, JSON.stringify(data)); // 10 minutes expiry
}

export async function getScoutNetdata(type) {
  await ensureConnection();
  const data = await client.get(`scoutnet-${type}`);
  return data ? JSON.parse(data) : null;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing Redis connection...");
  await client.quit();
  process.exit(0);
});
