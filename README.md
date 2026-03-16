# Discord ScoutID Linked Role

A Discord bot that links Discord accounts to ScoutID and automatically assigns roles based on ScoutNet event data.

## What it does

1. **ScoutID linking** - Users click "Link your ScoutID" in Discord and authenticate via ScoutID (OIDC). On success they get the `scout` role and their nickname is updated.
2. **Event roles** - If `SCOUTNET_EVENT_ID` is configured, the bot checks if the user is registered in that event and assigns an event role.
3. **Fee-based roles** - Maps the participant's fee category to a Discord role. Categories with a division config get division-specific roles (e.g. `Deltagare-02`, `IST-Patrull-05`), others get a waiting role (e.g. `Deltagare-Väntande`) or a static role (e.g. `IST-Direktresa`, `cmt`).
4. **Division roles** - Each fee category can have its own ScoutNet question for division assignment, with separate role patterns for "has division" and "no division yet".
5. **Slash command** - `/refresh-scoutid` lets users refresh their own roles. Admins can refresh other users or all linked users at once.

## Role assignment logic

Fee categories and their role patterns:

| Fee ID | Category | Division question | With division | Without division |
|--------|----------|-------------------|---------------|------------------|
| 25694, 27561 | deltagare | 88168 | `Deltagare-{div}` | `Deltagare-Väntande` |
| 25696 | ist | 88168 | `IST-Patrull-{div}` | `IST-Väntande` |
| 25702 | IST-Direktresa | — | `IST-Direktresa` | — |
| 33293, 34850 | ledare | 107592 | `Ledare-{div}` | `Ledare-Väntande` |
| 25697, 25693 | cmt | — | `cmt` | — |

Division numbers are zero-padded to minimum 2 digits (e.g. `3` → `03`, `100` → `100`).

**Note:** The bot cannot modify roles for users who have a higher role than the bot in the Discord role hierarchy (e.g. server admins above the bot).

## Project structure

```
src/
├── server.js     Main Express server with OAuth flow + interactions endpoint
├── config.js     Environment configuration
├── discord.js    Discord OAuth2 & API (roles, nicknames, slash commands)
├── scoutid.js    ScoutID OIDC authentication
├── scoutnet.js   ScoutNet API client (event participants)
├── roles.js      Role determination and sync logic
├── storage.js    Redis storage for tokens and linked accounts
├── register.js   One-time metadata + slash command registration
└── templates/
    └── success.html
```

## Setup

### 1. Create a Discord app

Create an app at https://discord.com/developers/applications with the `bot` scope. You need:
- Bot token (`DISCORD_TOKEN`)
- Client ID (`DISCORD_CLIENT_ID`), secret, public key
- The bot needs **Manage Roles** and **Manage Nicknames** permissions

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials. Key role config:

```bash
SCOUTNET_FEE_ROLES=25694:deltagare,27561:deltagare,25696:ist,25702:IST-Direktresa,33293:ledare,34850:ledare,25697:cmt,25693:cmt
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ist:88168:IST-Patrull-{div}:IST-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande
```

### 3. Run with Docker Compose (local dev)

```bash
docker-compose up -d
```

### 4. Register metadata and slash command (once)

```bash
docker run --rm --env-file .env acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest node src/register.js
```

### 5. Configure Discord Developer Portal

- **General Information** → **Linked Roles Verification URL**: `https://discord-scoutid.wsj27.scouterna.net/linked-role`
- **General Information** → **Interactions Endpoint URL**: `https://discord-scoutid.wsj27.scouterna.net/interactions`
- **OAuth2** → Add redirect: `https://discord-scoutid.wsj27.scouterna.net/discord-oauth-callback`

### 6. Discord server role hierarchy

In Server Settings → Roles, make sure the bot's role ("ScoutID bot") is **above** all the roles it needs to assign (Scout, Deltagare-*, IST-*, Ledare-*, cmt, etc.).

## Slash command: `/refresh-scoutid`

| Usage | Who can run | What it does |
|-------|-------------|-------------|
| `/refresh-scoutid` | Everyone | Refreshes your own roles |
| `/refresh-scoutid person:@user` | Admins | Refreshes that user's roles |
| `/refresh-scoutid alla:true` | Admins | Refreshes all linked users |

The command shows what roles were added or removed.

## Deployment to Azure

Infrastructure is managed with Terraform in the `terraform/` directory (Azure Container Apps + Redis + ACR).

### Build and push the Docker image

Build from WSL (uses Sectra npm registry):

```bash
# Login to Azure and ACR
az login
az acr login --name acrwsj27prodsec

# Build and push
docker build --no-cache -t acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest .
docker push acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest
```

### Deploy with Terraform

```bash
cd terraform
terraform init              # first time only
terraform plan -var-file="secrets.tfvars"
terraform apply -var-file="secrets.tfvars"
```

### Update a running deployment

After pushing a new image:

```bash
az containerapp update \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec \
  --image acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest
```

### View logs

```bash
az containerapp logs show \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec \
  --follow
```

## Local development with ngrok

The `docker-compose.yml` includes an ngrok service for tunneling. Set `NGROK_AUTHTOKEN` and `NGROK_URL` in `.env`, then check http://localhost:4040 for your public URL.

## Troubleshooting

- **403 when adding roles**: The bot can't assign roles to users above it in the role hierarchy, or the role itself is above the bot. Check role ordering in Discord Server Settings.
- **Redis connection errors in register.js**: Harmless — register.js only talks to Discord API but imports storage which tries to connect to Redis.
- **"Applikationen svarade inte"**: Check that the Interactions Endpoint URL is set correctly in the Discord Developer Portal and the container is running.
