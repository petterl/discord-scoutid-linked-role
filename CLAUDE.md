# Discord ScoutID Linked Role Bot

## Build & Deploy

```bash
# Build from WSL (requires Sectra npm registry)
docker build --no-cache -t acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest .
docker push acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest

# Deploy to Azure
az containerapp update --name app-discord-scoutid-prod-sec --resource-group rg-discord-scoutid-prod-sec --image acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest

# View logs
az containerapp logs show --name app-discord-scoutid-prod-sec --resource-group rg-discord-scoutid-prod-sec --follow

# Register slash command (once)
docker run --rm --env-file .env acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role:latest node src/register.js
```

## Architecture

- Node.js 20 + Express 5 + Redis (ESM modules)
- Azure Container Apps + Azure Redis Cache + ACR
- Terraform in `terraform/` manages all infrastructure
- Docker build uses Sectra npm registry (`https://feeds.sectra.net/npm/`)

## Key design decisions

- Fee-to-role mapping is fully configurable via env vars, not hardcoded
- Each fee category can have its own ScoutNet question ID for division assignment
- Division numbers are zero-padded to minimum 2 digits
- The bot cannot modify users above it in Discord's role hierarchy (403 is expected for admins)
- `register.js` only needs Discord API, but imports storage.js which tries Redis — Redis errors during registration are harmless
- Interaction responses use a 1-second delay before processing to avoid race conditions with Discord's deferred response handling

## ScoutNet API

- Participants endpoint: `https://scoutnet.se/api/project/get/participants?id={EVENT_ID}&key={API_KEY}`
- Response has `participants` object keyed by member_no
- Each participant has: `fee_id`, `cancelled_date`, `questions` (object of questionId → answer)
- Participant data is cached in Redis for 10 minutes

## Config format reference

```
# fee_id:category
SCOUTNET_FEE_ROLES=25694:deltagare,27561:deltagare,...

# category:questionId:roleWithDiv:roleWithoutDiv
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande,...
```
