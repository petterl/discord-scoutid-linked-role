import crypto from "crypto";

import * as storage from "./storage.js";
import config from "./config.js";

/**
 * Code specific to communicating with the Discord API.
 */

/**
 * The following methods all facilitate OAuth2 communication with Discord.
 * See https://discord.com/developers/docs/topics/oauth2 for more details.
 */

/**
 * Generate the url which the user will be directed to in order to approve the
 * bot, and see the list of requested scopes.
 */
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

/**
 * Given an OAuth2 code from the scope approval page, make a request to Discord's
 * OAuth2 service to retrieve an access token, refresh token, and expiration.
 */
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (response.ok) {
      const data = await response.json();
      return data;
    } else {
      const error = new Error(
        `Error fetching OAuth tokens: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

/**
 * The initial token request comes with both an access token and a refresh
 * token.  Check if the access token has expired, and if it has, use the
 * refresh token to acquire a new, fresh access token.
 */
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
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      if (response.ok) {
        const tokens = await response.json();
        tokens.expires_at = Date.now() + tokens.expires_in * 1000;
        return tokens;
      } else {
        const error = new Error(
          `Error refreshing access token: [${response.status}] ${response.statusText}`
        );
        error.status = response.status;
        throw error;
      }
    });

    await storage.storeDiscordTokens(userId, newTokens);
    return newTokens.access_token;
  }
  return tokens.access_token;
}

/**
 * Given a user based access token, fetch profile information for the current user.
 */
export async function getUserData(tokens) {
  const url = "https://discord.com/api/v10/oauth2/@me";

  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });
    if (response.ok) {
      const data = await response.json();
      return data;
    } else {
      const error = new Error(
        `Error fetching user data: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

/**
 * Retry function with exponential backoff for rate limiting
 */
async function retryWithBackoff(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      if (error.status === 429 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.log(
          `Rate limited, retrying in ${delay}ms (attempt ${
            attempt + 1
          }/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Given metadata that matches the schema, push that data to Discord on behalf
 * of the current user.
 */
export async function pushMetadata(userId, tokens, metadata) {
  // PUT /users/@me/applications/:id/role-connection
  const url = `https://discord.com/api/v10/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;

  await retryWithBackoff(async () => {
    const accessToken = await getAccessToken(userId, tokens);
    const body = {
      platform_name: "ScoutID",
      metadata,
    };
    const response = await fetch(url, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body2 = await response.text();
      console.error(
        `Error pushing discord metadata: [${response.status}] ${response.statusText}: ${body2}`
      );
      const error = new Error(
        `Error pushing discord metadata: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

/**
 * Fetch the metadata currently pushed to Discord for the currently logged
 * in user, for this specific bot.
 */
export async function getMetadata(userId, tokens) {
  // GET /users/@me/applications/:id/role-connection
  const url = `https://discord.com/api/v10/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;

  return await retryWithBackoff(async () => {
    const accessToken = await getAccessToken(userId, tokens);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.ok) {
      const data = await response.json();
      return data;
    } else {
      const error = new Error(
        `Error getting discord metadata: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

/**
 * Get the guilds (servers) that the user is a member of.
 * This is used to find which guilds we can update the user's nickname in.
 */
export async function getUserGuilds(tokens) {
  const url = "https://discord.com/api/v10/users/@me/guilds";

  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      return data;
    } else {
      const error = new Error(
        `Error fetching user guilds: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  });
}

/**
 * Update a user's nickname in a specific guild using the bot token.
 * Requires the bot to have "Manage Nicknames" permission in the guild.
 */
export async function updateGuildMemberNickname(guildId, userId, nickname) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;

  return await retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${config.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nick: nickname,
      }),
    });

    if (response.ok) {
      console.log(
        `Successfully updated nickname for user ${userId} in guild ${guildId} to "${nickname}"`
      );
      return true;
    } else {
      const errorText = await response.text();
      console.error(
        `Error updating nickname in guild ${guildId}: [${response.status}] ${response.statusText} - ${errorText}`
      );
      const error = new Error(
        `Error updating nickname in guild ${guildId}: [${response.status}] ${response.statusText}`
      );
      error.status = response.status;
      throw error;
    }
  }).catch(() => false); // Return false on error instead of throwing
}

/**
 * Add a role to a user in a specific guild using the bot token.
 * Requires the bot to have "Manage Roles" permission in the guild.
 */
export async function addRolesToUser(guildId, userId, roleNames) {
  try {
    // First, get the guild roles to find the role ID by name
    const rolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;

    const roles = await retryWithBackoff(async () => {
      const rolesResponse = await fetch(rolesUrl, {
        headers: {
          Authorization: `Bot ${config.DISCORD_TOKEN}`,
        },
      });

      if (!rolesResponse.ok) {
        const errorText = await rolesResponse.text();
        console.error(
          `Error fetching guild roles: [${rolesResponse.status}] ${rolesResponse.statusText} - ${errorText}`
        );
        const error = new Error(
          `Error fetching guild roles: [${rolesResponse.status}] ${rolesResponse.statusText}`
        );
        error.status = rolesResponse.status;
        throw error;
      }
      return await rolesResponse.json();
    });

    // Find role IDs for the given role names (case insensitive)
    const targetRoles = roles.filter((role) =>
      roleNames.some(
        (roleName) => role.name.toLowerCase() === roleName.toLowerCase()
      )
    );

    if (targetRoles.length === 0) {
      console.error(
        `Roles "${roleNames.join(", ")}" not found in guild ${guildId}`
      );
      return false;
    }

    // Add the role to the user
    for (const role of targetRoles) {
      const success = await retryWithBackoff(async () => {
        const addRoleUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${role.id}`;
        const addRoleResponse = await fetch(addRoleUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bot ${config.DISCORD_TOKEN}`,
          },
        });

        if (!addRoleResponse.ok) {
          const errorText = await addRoleResponse.text();
          console.error(
            `Error adding role "${role.name}" to user ${userId} in guild ${guildId}: [${addRoleResponse.status}] ${addRoleResponse.statusText} - ${errorText}`
          );
          const error = new Error(
            `Error adding role "${role.name}" to user ${userId} in guild ${guildId}: [${addRoleResponse.status}] ${addRoleResponse.statusText}`
          );
          error.status = addRoleResponse.status;
          throw error;
        } else {
          console.log(
            `Successfully added role "${role.name}" to user ${userId} in guild ${guildId}`
          );
          return true;
        }
      }).catch(() => {
        console.error(`Failed to add role "${role.name}" after retries`);
        return false;
      });

      if (!success) return false;
    }
    return true;
  } catch (e) {
    console.error(
      `Error adding roles "${roleNames.join(
        ", "
      )}" to user ${userId} in guild ${guildId}:`,
      e
    );
    return false;
  }
}
