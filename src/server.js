import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as scoutnet from "./scoutnet.js";
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
    const { state, codeVerifier, url } = scoutid.getOidcAuthorizationUrl();

    res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
    await storage.storeStateData(state, {
      discordUserId: userId,
      codeVerifier,
    });
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
      `Linked ScoutID ${scoutIDUser.scoutid} to Discord user ${discordUserId}`,
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

    // Update nickname with role suffix
    if (scoutIDUser.name) {
      const suffix = await roles.getNicknameSuffix(scoutIDUser.scoutid);
      await updateNickname(discordUserId, scoutIDUser.name + suffix);
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
        rawBody,
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
    if (interaction.type === 2 && interaction.data.name === "refresh-scoutid") {
      // Respond with deferred ephemeral message (type 5, flags 64), then process in background
      res.json({ type: 5, data: { flags: 64 } });
      setTimeout(
        () => handleRefreshCommand(interaction).catch(console.error),
        1000,
      );
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "status-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      setTimeout(
        () => handleStatusCommand(interaction).catch(console.error),
        1000,
      );
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "audit-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      setTimeout(
        () => handleAuditCommand(interaction).catch(console.error),
        1000,
      );
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "link-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      setTimeout(
        () => handleLinkCommand(interaction).catch(console.error),
        1000,
      );
      return;
    }

    res.sendStatus(400);
  },
);

async function handleRefreshCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerId = interaction.member.user.id;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  const personOption = interaction.data.options?.find(
    (o) => o.name === "person",
  );
  const allOption = interaction.data.options?.find((o) => o.name === "alla");

  try {
    if (allOption?.value === true) {
      // Refresh all users - admin only
      if (!isAdmin) {
        await discord.editInteractionResponse(
          token,
          "Du måste vara admin för att uppdatera alla.",
        );
        return;
      }

      const linkedUsers = await storage.getAllLinkedUsers();
      console.log(
        `Found ${linkedUsers.length} linked users:`,
        linkedUsers.map((u) => `${u.discordUserId} -> ${u.scoutId}`),
      );

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
          "Du måste vara admin för att uppdatera andra.",
        );
        return;
      }

      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, targetUserId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${formatChanges(result)}`,
        );
      }
    } else {
      // No arguments - refresh yourself
      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, callerId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${formatChanges(result)}`,
        );
      }
    }
  } catch (e) {
    console.error("Error handling refresh command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleStatusCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const targetUserId = interaction.data.options.find(
    (o) => o.name === "person",
  ).value;

  try {
    const lines = [];
    lines.push(`**Status för <@${targetUserId}>**`);

    // ScoutID link
    const scoutId = await storage.getLinkedScoutIDUserId(targetUserId);
    if (!scoutId) {
      lines.push("🔴 Inte länkad till ScoutID");
    } else {
      lines.push(`🟢 Länkad till ScoutID: \`${scoutId}\``);

      // ScoutID name (from stored tokens)
      try {
        const scoutIDTokens = await storage.getScoutIDTokens(scoutId);
        if (scoutIDTokens) {
          const scoutIDData = await scoutid.getUserData(scoutIDTokens);
          lines.push(`👤 Namn: ${scoutIDData.name}`);
        }
      } catch (e) {
        lines.push(`👤 Namn: (kunde inte hämta — ${e.message})`);
      }

      // ScoutNet participant info
      if (config.SCOUTNET_EVENT_ID) {
        try {
          const participant = await scoutnet.getParticipant(scoutId);
          if (!participant) {
            lines.push("📋 ScoutNet: Inte registrerad i evenemanget");
          } else if (participant.cancelled_date != null) {
            lines.push(
              `📋 ScoutNet: Avregistrerad (${participant.cancelled_date})`,
            );
          } else {
            const category =
              config.SCOUTNET_FEE_ROLES?.[String(participant.fee_id)] ??
              "(okänd)";
            const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
            const division = divConfig
              ? participant.questions?.[divConfig.questionId] || null
              : null;
            lines.push(
              `📋 ScoutNet: fee_id=${participant.fee_id}, kategori=${category}, avdelning=${division ?? "(saknas)"}`,
            );
          }
        } catch (e) {
          lines.push(`📋 ScoutNet: Fel — ${e.message}`);
        }
      }

      // Desired roles
      try {
        const desiredRoles = await roles.getDesiredRoles(scoutId);
        lines.push(`🎯 Förväntade roller: ${desiredRoles.join(", ")}`);
      } catch (e) {
        lines.push(`🎯 Förväntade roller: Fel — ${e.message}`);
      }
    }

    // Current Discord roles
    try {
      const member = await discord.getGuildMember(guildId, targetUserId);
      const guildRoles = await discord.getGuildRoles(guildId);
      const roleMap = Object.fromEntries(guildRoles.map((r) => [r.id, r.name]));
      const memberRoleNames = (member.roles || [])
        .map((id) => roleMap[id] ?? id)
        .sort();
      const nick =
        member.nick || member.user?.global_name || "(inget smeknamn)";
      lines.push(`🏷️ Discord-smeknamn: ${nick}`);
      lines.push(
        memberRoleNames.length > 0
          ? `🎭 Nuvarande roller: ${memberRoleNames.join(", ")}`
          : "🎭 Nuvarande roller: (inga)",
      );
    } catch (e) {
      lines.push(`🎭 Nuvarande roller: Fel — ${e.message}`);
    }

    const message = lines.join("\n");
    await discord.editInteractionResponse(
      token,
      message.length > 2000 ? message.substring(0, 1997) + "..." : message,
    );
  } catch (e) {
    console.error("Error handling status command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleAuditCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  try {
    const [guildMembers, guildRoles, linkedUsers, participants] =
      await Promise.all([
        discord.getGuildMembers(guildId),
        discord.getGuildRoles(guildId),
        storage.getAllLinkedUsers(),
        config.SCOUTNET_EVENT_ID ? scoutnet.getParticipants() : null,
      ]);

    const scoutRoleName = config.SCOUTNET_SCOUT_ROLE;
    const scoutRole = guildRoles.find(
      (r) => r.name.toLowerCase() === scoutRoleName.toLowerCase(),
    );

    const linkedMap = new Map(
      linkedUsers.map((u) => [u.discordUserId, u.scoutId]),
    );
    const memberMap = new Map(guildMembers.map((m) => [m.user.id, m]));

    const lines = [];
    lines.push("**Audit-rapport för ScoutID-länkningar**");
    lines.push(
      `Guild-medlemmar: ${guildMembers.length} · Länkade i storage: ${linkedUsers.length}`,
    );
    lines.push("");

    // Category 1: has Scout role but no storage link
    lines.push(
      `__1. Har \`${scoutRoleName}\`-rollen men ingen storage-länk__`,
    );
    if (!scoutRole) {
      lines.push(
        `(Rollen \`${scoutRoleName}\` finns inte i guilden — hoppar över.)`,
      );
    } else {
      const orphans = guildMembers.filter(
        (m) =>
          m.roles.includes(scoutRole.id) && !linkedMap.has(m.user.id),
      );
      if (orphans.length === 0) {
        lines.push("(Inga)");
      } else {
        for (const m of orphans) {
          const name = m.nick || m.user.global_name || m.user.username;
          lines.push(`- <@${m.user.id}> (${name})`);
        }
      }
    }
    lines.push("");

    // Category 2: storage link but no guild member
    lines.push("__2. Storage-länk men inte (längre) medlem i guilden__");
    const stale = linkedUsers.filter((u) => !memberMap.has(u.discordUserId));
    if (stale.length === 0) {
      lines.push("(Inga)");
    } else {
      for (const u of stale) {
        lines.push(`- discord=\`${u.discordUserId}\` scoutid=\`${u.scoutId}\``);
      }
    }
    lines.push("");

    // Category 3: linked but cancelled in ScoutNet
    lines.push("__3. Länkad men avbokad i ScoutNet__");
    if (!participants) {
      lines.push("(SCOUTNET_EVENT_ID är inte satt — hoppar över.)");
    } else {
      const cancelled = linkedUsers.filter((u) => {
        const p = participants[u.scoutId];
        return p && p.cancelled_date != null;
      });
      if (cancelled.length === 0) {
        lines.push("(Inga)");
      } else {
        for (const u of cancelled) {
          const p = participants[u.scoutId];
          const name =
            [p.first_name, p.last_name].filter(Boolean).join(" ") || "?";
          lines.push(
            `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` ${name} (avbokad ${p.cancelled_date})`,
          );
        }
      }
    }
    lines.push("");

    // Category 4: name mismatch between Discord and ScoutNet
    lines.push("__4. Möjlig fellänkning — namn matchar inte__");
    if (!participants) {
      lines.push("(SCOUTNET_EVENT_ID är inte satt — hoppar över.)");
    } else {
      const mismatches = [];
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        const p = participants[u.scoutId];
        if (!member || !p || p.cancelled_date != null) continue;
        if (!p.first_name && !p.last_name) continue;

        const rawDisplay =
          member.nick || member.user.global_name || member.user.username || "";
        const displayClean = rawDisplay.replace(/\s*\(.*\)\s*$/, "");
        const display = normalizeName(displayClean);
        const first = normalizeName(p.first_name || "");
        const last = normalizeName(p.last_name || "");

        const firstOk = !first || display.includes(first);
        const lastOk = !last || display.includes(last);
        if (firstOk && lastOk) continue;

        mismatches.push(
          `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` Discord="${displayClean}" ScoutNet="${[p.first_name, p.last_name].filter(Boolean).join(" ")}"`,
        );
      }
      if (mismatches.length === 0) {
        lines.push("(Inga)");
      } else {
        lines.push(...mismatches);
      }
    }

    const message = lines.join("\n");
    if (message.length <= 2000) {
      await discord.editInteractionResponse(token, message);
    } else {
      await discord.editInteractionResponseWithFile(
        token,
        "Audit-rapport (full lista i bifogad fil)",
        "audit-scoutid.txt",
        message,
      );
    }
  } catch (e) {
    console.error("Error handling audit command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleLinkCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const targetUserId = interaction.data.options.find(
    (o) => o.name === "person",
  ).value;
  const scoutIdInput = interaction.data.options
    .find((o) => o.name === "scoutid")
    .value.trim();

  if (!/^\d+$/.test(scoutIdInput)) {
    await discord.editInteractionResponse(
      token,
      `Ogiltigt scoutid: \`${scoutIdInput}\` — måste vara numeriskt.`,
    );
    return;
  }

  try {
    const messageParts = [];

    const existing = await storage.getLinkedScoutIDUserId(targetUserId);
    if (existing === scoutIdInput) {
      await discord.editInteractionResponse(
        token,
        `<@${targetUserId}> är redan länkad till scoutid \`${scoutIdInput}\`.`,
      );
      return;
    }
    if (existing) {
      messageParts.push(
        `⚠️ Var länkad till \`${existing}\`, ersätter med \`${scoutIdInput}\`.`,
      );
    }

    let participant = null;
    if (config.SCOUTNET_EVENT_ID) {
      try {
        participant = await scoutnet.getParticipant(scoutIdInput);
        if (!participant) {
          messageParts.push(
            `⚠️ ScoutNet känner inte till member_no \`${scoutIdInput}\` — länkar ändå.`,
          );
        } else if (participant.cancelled_date != null) {
          messageParts.push(
            `⚠️ ScoutNet-deltagaren är avbokad (${participant.cancelled_date}).`,
          );
        }
      } catch (e) {
        messageParts.push(`⚠️ Kunde inte slå upp ScoutNet: ${e.message}`);
      }
    }

    await storage.setLinkedScoutIDUserId(targetUserId, scoutIdInput);
    await storage.clearScoutNetCache();
    const result = await roles.syncUserRoles(guildId, targetUserId);

    if (result.error) {
      messageParts.push(`Fel vid rolluppdatering: ${result.error}`);
    } else {
      messageParts.push(formatChanges(result));
    }

    await discord.editInteractionResponse(
      token,
      `<@${targetUserId}>: Länkad till scoutid \`${scoutIdInput}\`. ${messageParts.join(" ")}`,
    );
  } catch (e) {
    console.error("Error handling link command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

function normalizeName(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
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
          console.log(
            `Added role "${roleName}" (${role.id}) to user ${userId}`,
          );
        } catch (e) {
          console.error(
            `Failed to add role "${roleName}" (${role.id}) to user ${userId}: ${e.message} (bot role may be too low in hierarchy)`,
          );
        }
      } else {
        console.warn(
          `Role "${roleName}" not found in guild — create it in Discord`,
        );
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
