import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import { getSuccessPageHTML } from "./templates.js";

const app = express();
app.use(cookieParser(config.COOKIE_SECRET));

// --- Health check ---

app.get("/", (req, res) => {
  res.send("👋");
});

// --- OAuth flow: step 1 - redirect to Discord ---

app.get("/linked-role", async (req, res) => {
  const { url, state } = discord.getOAuthUrl();
  res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
  res.redirect(url);
});

// --- OAuth flow: step 2 - Discord callback → redirect to ScoutID ---

app.get("/discord-oauth-callback", async (req, res) => {
  try {
    const code = req.query["code"];
    const discordState = req.query["state"];

    const { clientState } = req.signedCookies;
    if (clientState !== discordState) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const tokens = await discord.getOAuthTokens(code);
    const meData = await discord.getUserData(tokens);
    const userId = meData.user.id;

    await storage.storeDiscordTokens(userId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // Redirect to ScoutID for identity verification
    const {
      state,
      codeVerifier,
      url,
    } = scoutid.getOidcAuthorizationUrl();

    res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
    await storage.storeStateData(state, { discordUserId: userId, codeVerifier });
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- OAuth flow: step 3 - ScoutID callback → link accounts + assign roles ---

app.get("/scoutid-oauth-callback", async (req, res) => {
  try {
    const state = req.query["state"];
    const { discordUserId, codeVerifier } = await storage.getStateData(state);

    const { clientState } = req.signedCookies;
    if (clientState !== state) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const code = req.query["code"];
    const tokens = await scoutid.getOidcTokens({ code, codeVerifier });
    const scoutIDUser = await scoutid.getUserData(tokens);

    console.log(
      `Linked ScoutID ${scoutIDUser.scoutid} to Discord user ${discordUserId}`
    );

    await storage.storeScoutIDTokens(scoutIDUser.scoutid, {
      discord_user_id: discordUserId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // Link accounts and push metadata
    await storage.setLinkedScoutIDUserId(discordUserId, scoutIDUser.scoutid);
    await updateMetadata(discordUserId);

    // Assign Discord roles
    try {
      const guildId = config.DISCORD_GUILD_ID;
      if (guildId) {
        const desiredRoles = await roles.getDesiredRoles(scoutIDUser.scoutid);
        if (desiredRoles.length > 0) {
          await addDiscordRoles(discordUserId, desiredRoles);
        }
      }
    } catch (e) {
      console.error(`Error assigning roles for ${discordUserId}:`, e.message);
    }

    // Update nickname
    if (scoutIDUser.name) {
      await updateNickname(discordUserId, scoutIDUser.name);
    }

    res.send(getSuccessPageHTML());
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- Manual metadata refresh ---

app.get("/update-metadata", async (req, res) => {
  try {
    const userId = req.query.userId;
    await updateMetadata(userId);
    res.sendStatus(204);
  } catch (e) {
    res.sendStatus(500);
  }
});

// --- Discord interactions (slash commands) ---

const ADMIN_PERMISSION = BigInt(0x8);

app.post(
  "/interactions",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    const rawBody = req.body.toString();

    if (
      !discord.verifyInteraction(
        config.DISCORD_PUBLIC_KEY,
        signature,
        timestamp,
        rawBody
      )
    ) {
      return res.sendStatus(401);
    }

    const interaction = JSON.parse(rawBody);

    // Discord PING verification
    if (interaction.type === 1) {
      return res.json({ type: 1 });
    }

    // Slash command
    if (
      interaction.type === 2 &&
      interaction.data.name === "refresh-scoutid"
    ) {
      // Respond with deferred message (type 5), then process in background
      res.json({ type: 5 });
      setTimeout(
        () => handleRefreshCommand(interaction).catch(console.error),
        1000
      );
      return;
    }

    res.sendStatus(400);
  }
);

async function handleRefreshCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerId = interaction.member.user.id;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  const personOption = interaction.data.options?.find(
    (o) => o.name === "person"
  );
  const allOption = interaction.data.options?.find((o) => o.name === "alla");

  try {
    if (allOption?.value === true) {
      // Refresh all users - admin only
      if (!isAdmin) {
        await discord.editInteractionResponse(
          token,
          "Du måste vara admin för att uppdatera alla."
        );
        return;
      }

      const results = await roles.syncAllUserRoles(guildId);
      const lines = results.map((r) => {
        if (r.error) return `- <@${r.discordUserId}>: ${r.error}`;
        return `- <@${r.discordUserId}>: ${formatChanges(r)}`;
      });

      const message =
        lines.length > 0
          ? `Uppdaterade ${results.length} användare:\n${lines.join("\n")}`
          : "Inga länkade användare hittades.";

      // Discord 2000 char limit
      const truncated =
        message.length > 2000 ? message.substring(0, 1997) + "..." : message;
      await discord.editInteractionResponse(token, truncated);
    } else if (personOption) {
      // Refresh specific person
      const targetUserId = personOption.value;

      if (targetUserId !== callerId && !isAdmin) {
        await discord.editInteractionResponse(
          token,
          "Du måste vara admin för att uppdatera andra."
        );
        return;
      }

      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, targetUserId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${result.error}`
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${formatChanges(result)}`
        );
      }
    } else {
      // No arguments - refresh yourself
      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, callerId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${result.error}`
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${formatChanges(result)}`
        );
      }
    }
  } catch (e) {
    console.error("Error handling refresh command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

function formatChanges({ added, removed }) {
  const parts = [];
  if (added?.length > 0) parts.push(`Lade till: ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`Tog bort: ${removed.join(", ")}`);
  if (parts.length === 0) return "Inga ändringar";
  return parts.join(". ");
}

// --- Helper functions ---

async function updateMetadata(discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) return;

  let metadata = {};
  try {
    const scoutIDTokens = await storage.getScoutIDTokens(scoutId);
    const scoutIDData = await scoutid.getUserData(scoutIDTokens);
    metadata = {
      scoutid: scoutIDData.scoutid,
      email: scoutIDData.email,
      name: scoutIDData.name,
    };
  } catch (e) {
    console.error(`Error fetching ScoutID data: ${e.message}`);
  }

  const discordTokens = await storage.getDiscordTokens(discordUserId);
  await discord.pushMetadata(discordUserId, discordTokens, metadata);
}

async function updateNickname(userId, nickname) {
  try {
    if (nickname.length > 32) nickname = nickname.substring(0, 32);

    const guildId = config.DISCORD_GUILD_ID;
    if (guildId) {
      await discord.updateGuildMemberNickname(guildId, userId, nickname);
    } else {
      const discordTokens = await storage.getDiscordTokens(userId);
      if (!discordTokens) return;
      const guilds = await discord.getUserGuilds(discordTokens);
      for (const guild of guilds) {
        await discord.updateGuildMemberNickname(guild.id, userId, nickname);
      }
    }
  } catch (e) {
    console.error(`Error updating nickname for ${userId}:`, e.message);
  }
}

async function addDiscordRoles(userId, roleNames) {
  try {
    const guildId = config.DISCORD_GUILD_ID;
    if (!guildId) return;

    const guildRoles = await discord.getGuildRoles(guildId);
    const roleMap = new Map();
    for (const role of guildRoles) {
      roleMap.set(role.name.toLowerCase(), role);
    }

    console.log(`Assigning roles [${roleNames.join(", ")}] to user ${userId}`);
    for (const roleName of roleNames) {
      const role = roleMap.get(roleName.toLowerCase());
      if (role) {
        try {
          await discord.addRoleToUser(guildId, userId, role.id);
          console.log(`Added role "${roleName}" (${role.id}) to user ${userId}`);
        } catch (e) {
          console.error(
            `Failed to add role "${roleName}" (${role.id}) to user ${userId}: ${e.message} (bot role may be too low in hierarchy)`
          );
        }
      } else {
        console.warn(`Role "${roleName}" not found in guild — create it in Discord`);
      }
    }
  } catch (e) {
    console.error(`Error adding roles for ${userId}:`, e.message);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
