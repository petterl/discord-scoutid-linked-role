import { createClient } from "redis";
import config from "./config.js";

const client = createClient({ url: config.REDIS_URL });

client.on("error", (err) => console.error("Redis Client Error", err));
client.on("connect", () => console.log("Connected to Redis"));

let isConnected = false;
async function ensureConnection() {
  if (!isConnected) {
    await client.connect();
    isConnected = true;
  }
}

ensureConnection().catch(console.error);

// --- Discord tokens ---

export async function storeDiscordTokens(userId, tokens) {
  await ensureConnection();
  await client.setEx(`discord-${userId}`, 3600, JSON.stringify(tokens));
}

export async function getDiscordTokens(userId) {
  await ensureConnection();
  const data = await client.get(`discord-${userId}`);
  return data ? JSON.parse(data) : null;
}

// --- ScoutID tokens ---

export async function storeScoutIDTokens(userId, tokens) {
  await ensureConnection();
  await client.setEx(`scoutid-${userId}`, 3600, JSON.stringify(tokens));
}

export async function getScoutIDTokens(userId) {
  await ensureConnection();
  const data = await client.get(`scoutid-${userId}`);
  return data ? JSON.parse(data) : null;
}

// --- OAuth state ---

export async function storeStateData(state, data) {
  await ensureConnection();
  await client.setEx(`state-${state}`, 600, JSON.stringify(data));
}

export async function getStateData(state) {
  await ensureConnection();
  const data = await client.get(`state-${state}`);
  return data ? JSON.parse(data) : null;
}

// --- Discord <-> ScoutID link ---

export async function setLinkedScoutIDUserId(discordUserId, scoutUserId) {
  await ensureConnection();
  await client.set(`discord-link-${discordUserId}`, scoutUserId);
}

export async function getLinkedScoutIDUserId(discordUserId) {
  await ensureConnection();
  return await client.get(`discord-link-${discordUserId}`);
}

export async function getAllLinkedUsers() {
  await ensureConnection();
  const keys = await client.keys("discord-link-*");
  const users = [];
  for (const key of keys) {
    const discordUserId = key.replace("discord-link-", "");
    const scoutId = await client.get(key);
    users.push({ discordUserId, scoutId });
  }
  return users;
}

// --- ScoutNet cache ---

export async function storeScoutNetData(type, data) {
  await ensureConnection();
  await client.setEx(`scoutnet-${type}`, 600, JSON.stringify(data));
}

export async function getScoutNetData(type) {
  await ensureConnection();
  const data = await client.get(`scoutnet-${type}`);
  return data ? JSON.parse(data) : null;
}

export async function clearScoutNetCache() {
  await ensureConnection();
  const keys = await client.keys("scoutnet-*");
  for (const key of keys) {
    await client.del(key);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing Redis connection...");
  await client.quit();
  process.exit(0);
});
