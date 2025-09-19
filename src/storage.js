
const store = new Map();

export async function storeDiscordTokens(userId, tokens) {
  await store.set(`discord-${userId}`, tokens);
}

export async function getDiscordTokens(userId) {
  return store.get(`discord-${userId}`);
}

export async function storeStateData(state, data) {
  await store.set(`state-${state}`, data);
}

export async function getStateData(state) {
  return store.get(`state-${state}`);
}

export async function storeScoutIDTokens(userId, tokens) {
  await store.set(`scoutid-${userId}`, tokens);
}

export async function getScoutIDTokens(userId) {
  return store.get(`scoutid-${userId}`);
}

export async function getLinkedScoutIDUserId(discordUserId) {
	return store.get(`discord-link-${discordUserId}`);
}

export async function setLinkedScoutIDUserId(discordUserId, scoutUserId) {
	await store.set(`discord-link-${discordUserId}`, scoutUserId);
}

export async function deleteLinkedScoutIDUserId(discordUserId) {
	await store.delete(`discord-link-${discordUserId}`);
}
