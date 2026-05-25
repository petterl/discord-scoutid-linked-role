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

## Discord Developer Portal

- **General Information** → Linked Roles Verification URL: `https://discord-scoutid.wsj27.scouterna.net/linked-role`
- **General Information** → Interactions Endpoint URL: `https://discord-scoutid.wsj27.scouterna.net/interactions`
- **OAuth2** → Redirect: `https://discord-scoutid.wsj27.scouterna.net/discord-oauth-callback`

## Config format reference

Aktuell prod-config (se [terraform/terraform.tfvars](terraform/terraform.tfvars)):

```
# Marker-roller (alla länkade / alla event-anmälda)
SCOUTNET_SCOUT_ROLE=scout
SCOUTNET_EVENT_ROLE=wsj-event

# fee_id:category
SCOUTNET_FEE_ROLES=25694:deltagare,27561:deltagare,25696:ist,25702:IST-Direktresa,33293:ledare,34850:ledare,25697:cmt,25693:cmt

# category:questionId:roleWithDiv:roleWithoutDiv
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ist:88168:IST-Patrull-{div}:IST-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande

# category:suffixWithDiv:suffixWithoutDiv (empty = no suffix)
SCOUTNET_NICKNAME_SUFFIXES=deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,IST-Direktresa::IST,cmt::CMT
```

## Krav på Discord-servern

Discord-rollerna ägs av [discord-wsj27-infra](https://github.com/wsj27se/discord-wsj27-infra) (Terraform). Boten letar upp roller efter namn (case-insensitive) — om en roll inte finns hoppas tilldelningen tyst över. Roller som måste finnas:

| Bot tilldelar | Källa i infra-repot |
|---|---|
| `scout` | Extern `Scout`-roll (ScoutID-bot, ej Terraform) |
| `wsj-event` | `discord_role.wsj_event` |
| `Deltagare-{nr}` / `Deltagare-Väntande` | `discord_role.participant[*]` / `discord_role.participant_pending` |
| `Ledare-{nr}` / `Ledare-Väntande` | `discord_role.leader[*]` / `discord_role.leader_pending` |
| `IST-Patrull-{nr}` / `IST-Väntande` | `discord_role.ist_patrol[*]` / `discord_role.ist_pending` |
| `IST-Direktresa` | `discord_role.ist_direct_travel` |
| `CMT` | `discord_role.cmt` |

Antal avdelningar (`var.troops`) och IST-patruller (`var.ist_patrols`) i infra-repot måste täcka alla värden ScoutNet kan returnera för division-frågorna 88168 (deltagare/IST) och 107592 (ledare).
