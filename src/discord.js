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
    throw new Error(
      `Error fetching OAuth tokens: [${response.status}] ${response.statusText}`
    );
  }
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
      await storage.storeDiscordTokens(userId, tokens);
      return tokens.access_token;
    } else {
      throw new Error(
        `Error refreshing access token: [${response.status}] ${response.statusText}`
      );
    }
  }
  return tokens.access_token;
}

/**
 * Given a user based access token, fetch profile information for the current user.
 */
export async function getUserData(tokens) {
  const url = "https://discord.com/api/v10/oauth2/@me";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  if (response.ok) {
    const data = await response.json();
    return data;
  } else {
    throw new Error(
      `Error fetching user data: [${response.status}] ${response.statusText}`
    );
  }
}

/**
 * Given metadata that matches the schema, push that data to Discord on behalf
 * of the current user.
 */
export async function pushMetadata(userId, tokens, metadata) {
  // PUT /users/@me/applications/:id/role-connection
  const url = `https://discord.com/api/v10/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;
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
    throw new Error(
      `Error pushing discord metadata: [${response.status}] ${response.statusText}`
    );
  }
}

/**
 * Fetch the metadata currently pushed to Discord for the currently logged
 * in user, for this specific bot.
 */
export async function getMetadata(userId, tokens) {
  // GET /users/@me/applications/:id/role-connection
  const url = `https://discord.com/api/v10/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;
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
    throw new Error(
      `Error getting discord metadata: [${response.status}] ${response.statusText}`
    );
  }
}

/**
 * Get the guilds (servers) that the user is a member of.
 * This is used to find which guilds we can update the user's nickname in.
 */
export async function getUserGuilds(tokens) {
  const url = "https://discord.com/api/v10/users/@me/guilds";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  if (response.ok) {
    const data = await response.json();
    return data;
  } else {
    throw new Error(
      `Error fetching user guilds: [${response.status}] ${response.statusText}`
    );
  }
}

/**
 * Update a user's nickname in a specific guild using the bot token.
 * Requires the bot to have "Manage Nicknames" permission in the guild.
 */
export async function updateGuildMemberNickname(guildId, userId, nickname) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;

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
    return false;
  }
}

/**
 * Check if the bot has permission to manage nicknames in a guild.
 */
export async function checkBotPermissions(guildId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/@me`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${config.DISCORD_TOKEN}`,
    },
  });

  if (response.ok) {
    const data = await response.json();
    // Check if bot has MANAGE_NICKNAMES permission (0x8000000)
    const hasManageNicknames = (data.permissions & 0x8000000) === 0x8000000;
    return {
      canManageNicknames: hasManageNicknames,
      permissions: data.permissions,
    };
  } else {
    const body = await response.text();
    console.error(
      `Error checking bot permissions in guild ${guildId}: [${response.status}] ${response.statusText}: ${body}`
    );
    // Return false for permissions if we can't check (likely bot not in guild)
    return {
      canManageNicknames: false,
      permissions: 0,
      error: `${response.status}: ${response.statusText}`,
    };
  }
}

/**
 * Add a role to a user in a specific guild using the bot token.
 * Requires the bot to have "Manage Roles" permission in the guild.
 */
export async function addRolesToUser(guildId, userId, roleNames) {
  try {
    // First, get the guild roles to find the role ID by name
    const rolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
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
      return false;
    }

    const roles = await rolesResponse.json();
    // Find role IDs for the given role names (case insensitive)
    const targetRoles = roles.filter((role) =>
      roleNames.includes(role.name.toLowerCase())
    );

    if (targetRoles.length === 0) {
      console.error(
        `Roles "${roleNames.join(", ")}" not found in guild ${guildId}`
      );
      return false;
    }

    // Add the role to the user
    for (const role of targetRoles) {
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
        return false;
      } else {
        console.log(
          `Successfully added role "${role.name}" to user ${userId} in guild ${guildId}`
        );
      }
    }
    return true;
  } catch (e) {
    console.error(
      `Error adding role "${roleName}" to user ${userId} in guild ${guildId}:`,
      e
    );
    return false;
  }
}

/**
 * Check if the bot has permission to manage roles in a guild.
 */
export async function checkManageRolesPermission(guildId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/@me`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${config.DISCORD_TOKEN}`,
    },
  });

  if (response.ok) {
    const data = await response.json();
    // Check if bot has MANAGE_ROLES permission (0x10000000)
    const hasManageRoles = (data.permissions & 0x10000000) === 0x10000000;
    return {
      canManageRoles: hasManageRoles,
      permissions: data.permissions,
    };
  } else {
    const body = await response.text();
    console.error(
      `Error checking manage roles permission in guild ${guildId}: [${response.status}] ${response.statusText}: ${body}`
    );
    return {
      canManageRoles: false,
      permissions: 0,
      error: `${response.status}: ${response.statusText}`,
    };
  }
}
