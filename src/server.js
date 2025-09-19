import express from 'express';
import cookieParser from 'cookie-parser';

import config from './config.js';
import * as discord from './discord.js';
import * as scoutid from './scoutid.js';
import * as storage from './storage.js';

/**
 * Main HTTP server used for the bot.
 */

 const app = express();
 app.use(cookieParser(config.COOKIE_SECRET));

 /**
  * Just a happy little route to show our server is up.
  */
 app.get('/', (req, res) => {
   res.send('👋');
 });

/**
 * Route configured in the Discord developer console which facilitates the
 * connection between Discord and any additional services you may use. 
 * To start the flow, generate the OAuth2 consent dialog url for Discord, 
 * and redirect the user there.
 */
app.get('/linked-role', async (req, res) => {
  const { url, state } = discord.getOAuthUrl();

  // Store the signed state param in the user's cookies so we can verify
  // the value later. See:
  // https://discord.com/developers/docs/topics/oauth2#state-and-security
  res.cookie('clientState', state, { maxAge: 1000 * 60 * 5, signed: true });

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
 app.get('/discord-oauth-callback', async (req, res) => {
  console.log("/discord-oauth-callback called");
  try {
    // 1. Uses the code and state to acquire Discord OAuth2 tokens
    const code = req.query['code'];
    const discordState = req.query['state'];

    // make sure the state parameter is correct
    const { clientState } = req.signedCookies;
    if (clientState !== discordState) {
      console.error('State verification failed.');
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
    const { state, nonce, codeVerifier, url} = scoutid.getOidcAuthorizationUrl();

    // Store the signed state param in the user's cookies so we can verify
    // the value later. 
    res.cookie('clientState', state, { maxAge: 1000 * 60 * 5, signed: true });

    // Store the state data for later verification
    await storage.storeStateData(state, { discordUserId: userId, codeVerifier });

    // Send the user to the ScoutID OIDC authorization endpoint
    res.redirect(url);

  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

 app.get('/scoutid-oauth-callback', async (req, res) => {
  console.log("/scoutid-oauth-callback called");
  try {
    // 1. Uses the code and state to acquire ScoutID OIDC tokens
    const state = req.query['state'];
    const { discordUserId, codeVerifier } = await storage.getStateData(state);

    // make sure the state parameter is correct
    const { clientState } = req.signedCookies;

    if (clientState !== state) {
      console.error('State verification failed.');
      return res.sendStatus(403);
    }
    
    const code = req.query['code'];
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
      code_verifier: codeVerifier
    });

    // 3. Update the users metadata in discord, assuming future updates will be posted to the `/update-metadata` endpoint
    await storage.setLinkedScoutIDUserId(discordUserId, userId);
    await updateMetadata(discordUserId);
    res.send('You did it!  Now go back to Discord.');

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
 app.post('/update-metadata', async (req, res) => {
  console.log("/update-metadata called");
  try {
    const userId = req.body.userId;
    await updateMetadata(userId)

    res.sendStatus(204);
  } catch (e) {
    res.sendStatus(500);
  }
});

/**
 * Given a Discord UserId, push static make-believe data to the Discord 
 * metadata endpoint. 
 */
async function updateMetadata(userId) {
  // Fetch the tokens from storage
  const discordTokens = await storage.getDiscordTokens(userId);
  const scoutId = await storage.getLinkedScoutIDUserId(userId);
  if (!scoutId) {
    console.log(`No linked ScoutID user for Discord user ${userId}, skipping metadata update`);
    return;
  }
  const scoutIDTokens = await storage.getScoutIDTokens(scoutId);

  let metadata = {};
  try {
    metadata = await scoutid.getUserData(scoutIDTokens);
  } catch (e) {
    e.message = `Error fetching external data: ${e.message}`;
    console.error(e);
    // If fetching the profile data for the external service fails for any reason,
    // ensure metadata on the Discord side is nulled out. This prevents cases
    // where the user revokes an external app permissions, and is left with
    // stale linked role data.
    metadata = {};
  }

  console.log(`Pushing metadata ${JSON.stringify(metadata)} for user ${scoutIDTokens.discord_user_id}`);

  // Push the data to Discord.
  await discord.pushMetadata(scoutIDTokens.discord_user_id, discordTokens, metadata);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
