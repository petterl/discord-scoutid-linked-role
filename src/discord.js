import crypto from "crypto";

import * as storage from "./storage.js";
import config from "./config.js";

/**
 * Discord API client for OAuth2, role management, and interactions.
 */

// --- OAuth2 ---

export function getOAuthUrl() {
  const state = crypto.randomUUID();

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", config.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "role_connections.write identify");
  url.searchParams.set("prompt", "consent");
  return { state, url: url.toString() };
}

export async function getOAuthTokens(code) {
  const url = "https://discord.com/api/v10/oauth2/token";
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.DISCORD_REDIRECT_URI,
  });

  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      body,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (response.ok) return await response.json();
    const error = new Error(
      `Error fetching OAuth tokens: [${response.status}] ${response.statusText}`
    );
    error.status = response.status;
    throw error;
  });
}

export async function getAccessToken(userId, tokens) {
  if (Date.now() > tokens.expires_at) {
    const url = "https://discord.com/api/v10/oauth2/token";
    const body = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });

    const newTokens = await retryWithBackoff(async () => {
      const response = await fetch(url, {
        body,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (response.ok) {
        const tokens = await response.json();
        tokens.expires_at = Date.now() + tokens.expires_in * 1000;
        return tokens;
      }
      const error = new Error(
        `Error refreshing access token: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    });

    await storage.storeDiscordTokens(userId, newTokens);
    return newTokens.access_token;
  }
  return tokens.access_token;
}

// --- User data ---

export async function getUserData(tokens) {
  const url = "https://discord.com/api/v10/oauth2/@me";
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (response.ok) return await response.json();
    const error = new Error(
      `Error fetching user data: [${response.status}] ${response.statusText}`
    );
    error.status = response.status;
    throw error;
  });
}

export async function getUserGuilds(tokens) {
  const url = "https://discord.com/api/v10/users/@me/guilds";
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (response.ok) return await response.json();
    const error = new Error(
      `Error fetching user guilds: [${response.status}] ${response.statusText}`
    );
    error.status = response.status;
    throw error;
  });
}

// --- Linked role metadata ---

export async function pushMetadata(userId, tokens, metadata) {
  const url = `https://discord.com/api/v10/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;

  await retryWithBackoff(async () => {
    const accessToken = await getAccessToken(userId, tokens);
    const response = await fetch(url, {
      method: "PUT",
      body: JSON.stringify({ platform_name: "ScoutID", metadata }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Error pushing metadata: [${response.status}] ${response.statusText}: ${body}`
      );
      const error = new Error(
        `Error pushing metadata: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

// --- Guild member management ---

export async function updateGuildMemberNickname(guildId, userId, nickname) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${config.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nick: nickname }),
    });
    if (response.ok) {
      console.log(
        `Updated nickname for ${userId} in guild ${guildId} to "${nickname}"`
      );
      return true;
    }
    const error = new Error(
      `Error updating nickname in guild ${guildId}: [${response.status}]`
    );
    error.status = response.status;
    throw error;
  }).catch(() => false);
}

export async function getGuildRoles(guildId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/roles`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${config.DISCORD_TOKEN}` },
    });
    if (response.ok) return await response.json();
    const error = new Error(
      `Error fetching guild roles: [${response.status}]`
    );
    error.status = response.status;
    throw error;
  });
}

export async function getGuildMember(guildId, userId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${config.DISCORD_TOKEN}` },
    });
    if (response.ok) return await response.json();
    const error = new Error(
      `Error fetching guild member: [${response.status}]`
    );
    error.status = response.status;
    throw error;
  });
}

export async function addRoleToUser(guildId, userId, roleId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bot ${config.DISCORD_TOKEN}` },
    });
    if (!response.ok) {
      const error = new Error(
        `Error adding role ${roleId}: [${response.status}]`
      );
      error.status = response.status;
      throw error;
    }
    return true;
  });
}

export async function removeRoleFromUser(guildId, userId, roleId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bot ${config.DISCORD_TOKEN}` },
    });
    if (!response.ok) {
      const error = new Error(
        `Error removing role ${roleId}: [${response.status}]`
      );
      error.status = response.status;
      throw error;
    }
    return true;
  });
}

// --- Slash commands ---

export async function registerGuildCommand(guildId) {
  const url = `https://discord.com/api/v10/applications/${config.DISCORD_CLIENT_ID}/guilds/${guildId}/commands`;
  const command = {
    name: "refresh-scoutid",
    description: "Uppdatera ScoutID-roller",
    options: [
      {
        name: "person",
        description: "Person att uppdatera (admin krävs för andra)",
        type: 6, // USER
        required: false,
      },
      {
        name: "alla",
        description: "Uppdatera alla länkade användare (admin krävs)",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  };

  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (response.ok) return await response.json();
    const errorText = await response.text();
    throw new Error(
      `Error registering command: [${response.status}] ${errorText}`
    );
  });
}

// --- Interaction verification ---

export function verifyInteraction(publicKey, signature, timestamp, body) {
  const ed25519DerPrefix = "302a300506032b6570032100";
  try {
    return crypto.verify(
      null,
      Buffer.from(timestamp + body),
      {
        key: Buffer.from(ed25519DerPrefix + publicKey, "hex"),
        format: "der",
        type: "spki",
      },
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

// --- Interaction responses ---

export async function editInteractionResponse(interactionToken, content) {
  const url = `https://discord.com/api/v10/webhooks/${config.DISCORD_CLIENT_ID}/${interactionToken}/messages/@original`;
  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const error = new Error(
        `Error editing interaction response: [${response.status}]`
      );
      error.status = response.status;
      throw error;
    }
    return true;
  });
}

// --- Retry helper ---

async function retryWithBackoff(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(
          `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}
