import * as dotenv from 'dotenv'

/**
 * Load environment variables from a .env file, if it exists.
 */

dotenv.config()

const config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,

  SCOUTID_CLIENT_ID: process.env.SCOUTID_CLIENT_ID,
  SCOUTID_CLIENT_SECRET: process.env.SCOUTID_CLIENT_SECRET,
  SCOUTID_REDIRECT_URI: process.env.SCOUTID_REDIRECT_URI,
  SCOUTID_SCOPES: process.env.SCOUTID_SCOPES,
  SCOUTID_EVENT_ID: process.env.SCOUTID_EVENT_ID,

  COOKIE_SECRET: process.env.COOKIE_SECRET,
};

export default config;
