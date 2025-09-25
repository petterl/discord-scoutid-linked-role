import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import { getSuccessPageHTML } from "./templates.js";

/**
 * Main HTTP server used for the bot.
 */

const app = express();
app.use(cookieParser(config.COOKIE_SECRET));

/**
 * Just a happy little route to show our server is up.
 */
app.get("/", (req, res) => {
  res.send("👋");
});

/**
 * Route configured in the Discord developer console which facilitates the
 * connection between Discord and any additional services you may use.
 * To start the flow, generate the OAuth2 consent dialog url for Discord,
 * and redirect the user there.
 */
app.get("/linked-role", async (req, res) => {
  const { url, state } = discord.getOAuthUrl();

  // Store the signed state param in the user's cookies so we can verify
  // the value later. See:
  // https://discord.com/developers/docs/topics/oauth2#state-and-security
  res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });

  // Send the user to the Discord owned OAuth2 authorization endpoint
  res.redirect(url);
});

/**
 * Route configured in the Discord developer console, the redirect Url to which
 * the user is sent after approving the bot for their Discord account. This
 * completes a few steps:
 * 1. Uses the code to acquire Discord OAuth2 tokens
 * 2. Uses the Discord Access Token to fetch the user profile
 * 3. Stores the OAuth2 Discord Tokens in Redis / Firestore
 * 4. Lets the user know it's all good and to go back to Discord
 */
app.get("/discord-oauth-callback", async (req, res) => {
  console.log("/discord-oauth-callback called");
  try {
    // 1. Uses the code and state to acquire Discord OAuth2 tokens
    const code = req.query["code"];
    const discordState = req.query["state"];

    // make sure the state parameter is correct
    const { clientState } = req.signedCookies;
    if (clientState !== discordState) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const tokens = await discord.getOAuthTokens(code);

    // 2. Uses the Discord Access Token to fetch the user profile
    const meData = await discord.getUserData(tokens);
    const userId = meData.user.id;
    await storage.storeDiscordTokens(userId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // 3. Get ScoutID auth url to be able to redirect to it
    const { state, nonce, codeVerifier, url } =
      scoutid.getOidcAuthorizationUrl();

    // Store the signed state param in the user's cookies so we can verify
    // the value later.
    res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });

    // Store the state data for later verification
    await storage.storeStateData(state, {
      discordUserId: userId,
      codeVerifier,
    });

    // Send the user to the ScoutID OIDC authorization endpoint
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get("/scoutid-oauth-callback", async (req, res) => {
  console.log("/scoutid-oauth-callback called");
  try {
    // 1. Uses the code and state to acquire ScoutID OIDC tokens
    const state = req.query["state"];
    const { discordUserId, codeVerifier } = await storage.getStateData(state);

    // make sure the state parameter is correct
    const { clientState } = req.signedCookies;

    if (clientState !== state) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const code = req.query["code"];
    const tokens = await scoutid.getOidcTokens({ code, codeVerifier });

    // 2. Uses the Access Token to fetch the user profile
    const scoutIDUserData = await scoutid.getUserData(tokens);

    const userId = scoutIDUserData.scoutid;
    console.log(`Got ScoutID user ${userId} for Discord user ${discordUserId}`);
    await storage.storeScoutIDTokens(userId, {
      discord_user_id: discordUserId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      code_verifier: codeVerifier,
    });

    // 3. Update the users metadata in discord, assuming future updates will be posted to the `/update-metadata` endpoint
    await storage.setLinkedScoutIDUserId(discordUserId, userId);

    const metadata = await getMetadata(discordUserId);
    await updateMetadata(discordUserId, metadata);

    // 4. Add Discord role to the user
    // await addDiscordRoles(discordUserId, ["wsj27", "ledare"]);

    if (!scoutIDUserData.name) {
      console.log(
        `No name found in ScoutID data for user ${userId}, skipping nickname update`
      );
      return;
    } else {
      let nickname = scoutIDUserData.name;
      await updateNickname(discordUserId, nickname);
    }

    // 4. Lets the user know it's all good and to go back to Discord
    res.send(getSuccessPageHTML());
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/**
 * Example route that would be invoked when an external data source changes.
 * This example calls a common `updateMetadata` method that pushes static
 * data to Discord.
 */
app.get("/update-metadata", async (req, res) => {
  console.log("/update-metadata called");
  try {
    const userId = req.query.userId;
    const metadata = await getMetadata(userId);
    await updateMetadata(userId, metadata);

    res.sendStatus(204);
  } catch (e) {
    res.sendStatus(500);
  }
});

/**
 * Given a Discord UserId, push static make-believe data to the Discord
 * metadata endpoint.
 */
async function getMetadata(userId) {
  const scoutId = await storage.getLinkedScoutIDUserId(userId);
  if (!scoutId) {
    console.log(
      `No linked ScoutID user for Discord user ${userId}, skipping metadata update`
    );
    return;
  }
  const scoutIDTokens = await storage.getScoutIDTokens(scoutId);

  let metadata = {};
  try {
    const scoutIDdata = await scoutid.getUserData(scoutIDTokens);

    metadata = {
      scoutid: scoutIDdata.scoutid,
      email: scoutIDdata.email,
      name: scoutIDdata.name,
    };
  } catch (e) {
    e.message = `Error fetching external data: ${e.message}`;
    console.error(e);
    // If fetching the profile data for the external service fails for any reason,
    // ensure metadata on the Discord side is nulled out. This prevents cases
    // where the user revokes an external app permissions, and is left with
    // stale linked role data.
    metadata = {};
  }
  return metadata;
}

/**
 * Given a Discord UserId, push static make-believe data to the Discord
 * metadata endpoint.
 */
async function updateMetadata(userId, metadata) {
  // Fetch the tokens from storage
  const discordTokens = await storage.getDiscordTokens(userId);

  console.log(
    `Pushing metadata ${JSON.stringify(metadata)} for user ${userId}`
  );

  // Push the data to Discord.
  await discord.pushMetadata(userId, discordTokens, metadata);
}

/**
 * Update a Discord user's nickname to their ScoutID name.
 * This will attempt to update the nickname in all guilds where:
 * 1. The user is a member
 * 2. The bot is present and has "Manage Nicknames" permission
 */
async function updateNickname(userId, nickname) {
  try {
    if (nickname.length > 32) {
      nickname = nickname.substring(0, 32);
    }

    console.log(
      `Updating nickname for Discord user ${userId} to "${nickname}"`
    );

    // Get Discord user tokens to fetch their guilds
    const discordTokens = await storage.getDiscordTokens(userId);
    if (!discordTokens) {
      console.log(
        `No Discord tokens found for user ${userId}, skipping nickname update`
      );
      return;
    }

    try {
      const userGuilds = [];
      // Get the guilds the user is a member of
      if (config.DISCORD_GUILD_ID) {
        userGuilds.push({
          id: config.DISCORD_GUILD_ID,
          name: "Configured Guild",
        });
      } else {
        userGuilds.push(...(await discord.getUserGuilds(discordTokens)));
      }
      console.log(`User ${userId} is a member of ${userGuilds.length} guilds`);

      // Attempt to update nickname in each guild
      let successCount = 0;
      for (const guild of userGuilds) {
        try {
          const success = await discord.updateGuildMemberNickname(
            guild.id,
            userId,
            nickname
          );
          if (success) successCount++;
        } catch (e) {
          // Bot might not be in this guild, or other permission issues
          console.log(
            `Cannot update nickname in guild ${guild.id} (${guild.name}): ${e.message}`
          );
        }
      }

      console.log(
        `Successfully updated nickname in ${successCount} out of ${userGuilds.length} guilds`
      );
    } catch (e) {
      console.error(`Error fetching user guilds for ${userId}:`, e.message);
    }
  } catch (e) {
    console.error(`Error updating nickname for user ${userId}:`, e);
  }
}

/**
 * Add the roles to a Discord user in all applicable guilds.
 * This will attempt to add the role in all guilds where:
 * 1. The user is a member
 * 2. The bot is present and has "Manage Roles" permission
 * 3. The roles exists
 */
async function addDiscordRoles(userId, roles) {
  try {
    console.log(
      `Adding roles ${JSON.stringify(roles)} for Discord user ${userId}`
    );

    // Get Discord user tokens to fetch their guilds
    const discordTokens = await storage.getDiscordTokens(userId);
    if (!discordTokens) {
      console.log(
        `No Discord tokens found for user ${userId}, skipping WSJ role assignment`
      );
      return;
    }

    try {
      const userGuilds = [];
      if (config.DISCORD_GUILD_ID) {
        userGuilds.push({
          id: config.DISCORD_GUILD_ID,
          name: "Configured Guild",
        });
      } else {
        userGuilds.push(...(await discord.getUserGuilds(discordTokens)));
      }
      console.log(
        `User ${userId} is a member of ${userGuilds.length} guilds for role assignment`
      );

      // Attempt to add roles in each guild
      let successCount = 0;
      for (const guild of userGuilds) {
        try {
          const success = await discord.addRolesToUser(guild.id, userId, roles);
          if (success) successCount++;
        } catch (e) {
          // Bot might not be in this guild, or other permission issues
          console.log(
            `Cannot add WSJ role in guild ${guild.id} (${guild.name}): ${e.message}`
          );
        }
      }

      console.log(
        `Successfully added roles in ${successCount} out of ${userGuilds.length} guilds`
      );
    } catch (e) {
      console.error(
        `Error fetching user guilds for role assignment for ${userId}:`,
        e.message
      );
    }
  } catch (e) {
    console.error(`Error adding roles for user ${userId}:`, e);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
