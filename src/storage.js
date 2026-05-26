import { TableClient } from "@azure/data-tables";
import config from "./config.js";

/**
 * Durable storage backed by Azure Table Storage.
 *
 * Data model — a single table, partitioned by record type:
 *   PartitionKey   RowKey          value (+ expiresAt for cache/state)
 *   link           discordUserId   scoutId
 *   discord-token  userId          JSON
 *   scoutid-token  userId          JSON
 *   state          state           JSON   + expiresAt   (OAuth, 10 min)
 *   scoutnet       type            JSON   + expiresAt   (cache, 10 min)
 *
 * Table Storage has no native TTL, so cache/state rows carry an `expiresAt`
 * (epoch ms) and are treated as absent past that time (lazy expiry).
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const SCOUTNET_TTL_MS = 10 * 60 * 1000;

const client = TableClient.fromConnectionString(
  config.TABLE_CONNECTION_STRING,
  config.TABLE_NAME,
);

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  try {
    await client.createTable();
  } catch (err) {
    // 409 = table already exists, which is the normal steady state.
    if (err?.statusCode !== 409) throw err;
  }
  tableReady = true;
}

async function getEntity(partitionKey, rowKey) {
  try {
    return await client.getEntity(partitionKey, rowKey);
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function setValue(partitionKey, rowKey, value, expiresAt) {
  const entity = { partitionKey, rowKey, value };
  if (expiresAt != null) entity.expiresAt = expiresAt;
  await client.upsertEntity(entity, "Replace");
}

// --- Discord tokens ---

export async function storeDiscordTokens(userId, tokens) {
  await ensureTable();
  await setValue("discord-token", userId, JSON.stringify(tokens));
}

export async function getDiscordTokens(userId) {
  await ensureTable();
  const e = await getEntity("discord-token", userId);
  return e ? JSON.parse(e.value) : null;
}

// --- ScoutID tokens ---

export async function storeScoutIDTokens(userId, tokens) {
  await ensureTable();
  await setValue("scoutid-token", userId, JSON.stringify(tokens));
}

export async function getScoutIDTokens(userId) {
  await ensureTable();
  const e = await getEntity("scoutid-token", userId);
  return e ? JSON.parse(e.value) : null;
}

// --- OAuth state (short-lived) ---

export async function storeStateData(state, data) {
  await ensureTable();
  await setValue("state", state, JSON.stringify(data), Date.now() + STATE_TTL_MS);
}

export async function getStateData(state) {
  await ensureTable();
  const e = await getEntity("state", state);
  if (!e) return null;
  if (e.expiresAt != null && Date.now() > e.expiresAt) {
    client.deleteEntity("state", state).catch(() => {});
    return null;
  }
  return JSON.parse(e.value);
}

// --- Discord <-> ScoutID link (durable) ---

export async function setLinkedScoutIDUserId(discordUserId, scoutUserId) {
  await ensureTable();
  await setValue("link", discordUserId, scoutUserId);
}

export async function getLinkedScoutIDUserId(discordUserId) {
  await ensureTable();
  const e = await getEntity("link", discordUserId);
  return e ? e.value : null;
}

export async function getAllLinkedUsers() {
  await ensureTable();
  const users = [];
  const entities = client.listEntities({
    queryOptions: { filter: "PartitionKey eq 'link'" },
  });
  for await (const e of entities) {
    users.push({ discordUserId: e.rowKey, scoutId: e.value });
  }
  return users;
}

// --- ScoutNet cache (short-lived) ---

export async function storeScoutNetData(type, data) {
  await ensureTable();
  await setValue(
    "scoutnet",
    type,
    JSON.stringify(data),
    Date.now() + SCOUTNET_TTL_MS,
  );
}

export async function getScoutNetData(type) {
  await ensureTable();
  const e = await getEntity("scoutnet", type);
  if (!e) return null;
  if (e.expiresAt != null && Date.now() > e.expiresAt) {
    client.deleteEntity("scoutnet", type).catch(() => {});
    return null;
  }
  return JSON.parse(e.value);
}

export async function clearScoutNetCache() {
  await ensureTable();
  const entities = client.listEntities({
    queryOptions: { filter: "PartitionKey eq 'scoutnet'" },
  });
  for await (const e of entities) {
    await client.deleteEntity("scoutnet", e.rowKey);
  }
}
