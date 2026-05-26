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

- Node.js 20 + Express 5 + Azure Table Storage (ESM modules)
- Azure Container Apps + Azure Storage Account (Table) + ACR
- Terraform in `terraform/` manages all infrastructure
- Docker build uses Sectra npm registry (`https://feeds.sectra.net/npm/`)
- Local dev uses the Azurite storage emulator (see `docker-compose.yml`)

## Key design decisions

- Fee-to-role mapping is fully configurable via env vars, not hardcoded
- Each fee category can have its own ScoutNet question ID for division assignment
- Division numbers are zero-padded to minimum 2 digits
- The bot cannot modify users above it in Discord's role hierarchy (403 is expected for admins)
- `register.js` only needs Discord API, but imports storage.js which connects to Table Storage — storage errors during registration are harmless
- Interaction responses use a 1-second delay before processing to avoid race conditions with Discord's deferred response handling
- **Scout-rollen är säkerhetsgränsen.** Saknar en länkad användare Scout-rollen i Discord (managed Linked Role) så strippas alla bot-hanterade roller och `Overifierad` sätts vid nästa `syncUserRoles`. Storage-länken behålls så användaren kan re-verifiera utan att admin behöver fråga efter scoutid igen.
- OAuth-tokens (`discord-token`, `scoutid-token`) och länkar (`link`) lagras durabelt i Azure Table Storage (ingen TTL). Cache (`scoutnet`) och OAuth-state (`state`) har ett `expiresAt`-fält (lazy expiry, 10 min) eftersom Table Storage saknar native TTL. Refresh-tokens från Discord är giltiga i månader, och persistent lagring låter `/link-scoutid` re-pusha Linked Role-metadata i bakgrunden.
- **Varför inte Redis:** Azure Redis Basic-tier saknar persistens och tappar ALL data vid varje nod-omstart/underhåll. 2026-05-26 wipeades alla länkar+tokens av en sådan omstart. Table Storage (LRS) är durabelt och billigare för detta access-mönster (bara läs/skriv vid länkning + audit).

## ScoutNet API

- Participants endpoint: `https://scoutnet.se/api/project/get/participants?id={EVENT_ID}&key={API_KEY}`
- Response has `participants` object keyed by member_no
- Each participant has: `fee_id`, `cancelled_date`, `questions` (object of questionId → answer)
- Participant data is cached in Table Storage for 10 minutes (lazy expiry via `expiresAt`)

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

## Audit och konsistenskontroll

Audit-logiken ligger i [src/audit.js](src/audit.js) och körs antingen via slash-kommando eller schemalagt.

### Kategorier som kontrolleras

1. **Scout-roll utan storage-länk** — användare med Scout-rollen men ingen ScoutID-länkning i Table Storage
2. **Länkade utan Scout-rollen** — Discord Linked Role har fallit bort (frånkopplad app, lämnad/återansluten server). Användaren måste re-verifiera via `/linked-role` själv eftersom Scout är en managed roll
3. **Storage-länk utan guild-medlem** — gamla länkningar för användare som lämnat servern
3. **Avbokade i ScoutNet** — länkade användare med `cancelled_date` satt
4. **Namnskillnader** — Discord-smeknamn matchar inte ScoutNet-namn
5. **Saknade statiska roller** — roller boten skulle tilldela som inte finns i guilden
6. **Saknade division-roller** — `Deltagare-{nr}` etc. som ScoutNet refererar till men som inte finns
7. **Okända fee_id** — `fee_id` i ScoutNet utan mappning i `SCOUTNET_FEE_ROLES`
8. **Bot-hierarki/permissions** — roller över botens position, eller saknade `MANAGE_ROLES`/`MANAGE_NICKNAMES`
9. **Roll-drift** — per användare: vilka roller saknas / vilka borde inte finnas (dry-run sync)
10. **Multipla division-roller** — användare som har t.ex. `Deltagare-05` och `Deltagare-07` samtidigt
11. **Fel nickname-suffix** — användare där `(X)` i nicket inte matchar förväntat värde

### Kommandon

- `/audit-scoutid` — full rapport (admin). Filattachment om >2000 tecken.
- `/status-scoutid` — utan argument: server-sammanfattning. Med `person`: detaljerad status för en användare.

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
