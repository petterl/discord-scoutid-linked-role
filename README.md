# Discord ScoutID Linked Role

This repository contains a linked role bot that will link your discord account to an scoutID account.

## Project structure

All of the files for the project are on the left-hand side. Here's a quick glimpse at the structure:

```
├── assets          -> Images used in this tutorial
├── src
│   ├── config.js   -> Parsing of local configuration
│   ├── discord.js  -> Discord specific auth & API wrapper
│   ├── register.js -> Tool to register the metadata schema
│   ├── scoutid.js  -> ScoutID specific auth & API wrapper
│   ├── server.js   -> Main entry point for the application
│   ├── storage.js  -> Provider for storing OAuth2 tokens
├── .env -> your credentials and IDs
├── package.json
└── README.md
```

## Running app locally

Before you start, you'll need to [create a Discord app](https://discord.com/developers/applications) with the `bot` scope

### Docker build

1. First clone the project
2. Build the docker image

```
docker build . -t discord-scoutid-linked-role
```

### Get app credentials

Fetch the credentials from your app's settings and add them to a `.env` file. You'll need your bot token (`DISCORD_TOKEN`), client ID (`DISCORD_CLIENT_ID`), client secret (`DISCORD_CLIENT_SECRET`). You'll also need a redirect URI (`DISCORD_REDIRECT_URI`) and a randomly generated UUID (`COOKIE_SECRET`), which are both explained below.

The scoutID credentials you get by mailing ou

```
DISCORD_CLIENT_ID=<your OAuth2 client Id>
DISCORD_CLIENT_SECRET=<your OAuth2 client secret>
DISCORD_TOKEN=<your bot token>
DISCORD_REDIRECT_URI=https://<your-project-url>/discord-oauth-callback

SCOUTID_CLIENT_ID=<your ScoutID client id>
SCOUTID_CLIENT_SECRET=<your ScoutID client secret>
SCOUTID_REDIRECT_URI=https://<your-project-url>/scoutid-oauth-callback
SCOUTID_SCOPES=openid profile email roles
SCOUTID_EVENT_ID=<set to an eventID if you require people to have a role on that event to verify>

COOKIE_SECRET=<random generated UUID>
```

For the UUID (`COOKIE_SECRET`), you can run the following commands:

```
$ node
crypto.randomUUID()
```

Copy and paste the value into your `.env` file.

### Running your app

After your credentials are added, you can run your app:

```
$ docker run -it --env-file .env discord-scoutid-linked-role
```

And, just once, you need to register you connection metadata schema. In a new window, run:

```
$ docker run -it --env-file .env discord-scoutid-linked-role node src/register.js
```

### Set up interactivity

The project needs a public endpoint where Discord can send requests. To develop and test locally, you can use something like [`ngrok`](https://ngrok.com/) to tunnel HTTP traffic.

To use ngrok you can use the docker-compose file setup

```
$ docker-compose up -d
```

You can now connect to http://localhost:4040 to see the status.

Copy the forwarding address that starts with `https`, in this case `https://1234-someurl.ngrok.io`, then go to your [app's settings](https://discord.com/developers/applications).

On the **General Information** tab, there will be an **Linked Roles Verification URL**. Paste your ngrok address there, and append `/linked-role` (`https://1234-someurl.ngrok.io/linked-role` in the example).

You should also paste your ngrok address into the `DISCORD_REDIRECT_URI` and 'SCOUTID_REDIRECT_URL' variables in your `.env` file, with `/discord-oauth-callback` and `/scoutid-oauth-callback` appended (`https://1234-someurl.ngrok.io/discord-oauth-callback` in the example). Then go to the **General** tab under **OAuth2** in your [app's settings](https://discord.com/developers/applications), and add that same address to the list of **Redirects**.

Click **Save Changes** and restart your app.

## Other resources

- Read **[the tutorial](https://discord.com/developers/docs/tutorials/configuring-app-metadata-for-linked-roles)** for in-depth information.
- Join the **[Discord Developers server](https://discord.gg/discord-developers)** to ask questions about the API, attend events hosted by the Discord API team, and interact with other devs.

# TODO

- [ ] Switch to database
- [ ] pipeline for deployment
- [ ] Set nickname to scoutid name
