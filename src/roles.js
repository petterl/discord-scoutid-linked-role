import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";

/**
 * Role management: determines and syncs Discord roles based on ScoutNet data.
 *
 * Role assignment:
 *   1. Scout role   - always (linked ScoutID)
 *   2. Event role   - if registered in the event
 *   3. Fee role     - based on fee_id → category, with optional division pattern
 *
 * Division roles use per-category question IDs:
 *   deltagare uses q88168, ledare uses q107592, etc.
 *   Categories without a division config use the category name as the role.
 *
 * Nickname suffix:
 *   Appended to the user's real name, e.g. "Petter Sandholdt (CMT)".
 *   Configured via SCOUTNET_NICKNAME_SUFFIXES.
 */

/**
 * Get participant's fee category and division from ScoutNet.
 * Returns { category, division } or null if not in event.
 */
async function getParticipantInfo(scoutnetMemberId) {
  if (!config.SCOUTNET_EVENT_ID) return null;

  const participant = await scoutnet.getParticipant(scoutnetMemberId);
  if (!participant || participant.cancelled_date != null) return null;

  const category =
    config.SCOUTNET_FEE_ROLES && participant.fee_id
      ? config.SCOUTNET_FEE_ROLES[String(participant.fee_id)]
      : null;

  const divConfig = category
    ? config.SCOUTNET_DIVISION_ROLES?.[category]
    : null;
  const division = divConfig
    ? participant.questions?.[divConfig.questionId] || null
    : null;

  return { category, division };
}

/**
 * Determine which roles a user should have.
 */
export async function getDesiredRoles(scoutnetMemberId) {
  const roles = [config.SCOUTNET_SCOUT_ROLE];

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info) return roles;

    roles.push(config.SCOUTNET_EVENT_ROLE);

    if (info.category) {
      const divConfig = config.SCOUTNET_DIVISION_ROLES?.[info.category];
      if (divConfig) {
        if (info.division) {
          const padded = String(info.division).padStart(2, "0");
          roles.push(divConfig.withDiv.replace("{div}", padded));
        } else {
          roles.push(divConfig.withoutDiv);
        }
      } else {
        roles.push(info.category);
      }
    }
  } catch (e) {
    console.error(
      `Error fetching ScoutNet data for member ${scoutnetMemberId}:`,
      e.message
    );
  }

  return roles;
}

/**
 * Get the nickname suffix for a user based on their ScoutNet data.
 * E.g. " (CMT)", " (AL12)", " (IST-05)", " (03)".
 * Returns empty string if no suffix applies.
 */
export async function getNicknameSuffix(scoutnetMemberId) {
  if (!config.SCOUTNET_NICKNAME_SUFFIXES) return "";

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info?.category) return "";

    const suffixConfig = config.SCOUTNET_NICKNAME_SUFFIXES[info.category];
    if (!suffixConfig) return "";

    if (info.division && suffixConfig.withDiv) {
      const padded = String(info.division).padStart(2, "0");
      return ` (${suffixConfig.withDiv.replace("{div}", padded)})`;
    }

    if (suffixConfig.withoutDiv) {
      return ` (${suffixConfig.withoutDiv})`;
    }

    return "";
  } catch (e) {
    console.error(
      `Error getting nickname suffix for member ${scoutnetMemberId}:`,
      e.message
    );
    return "";
  }
}

/**
 * All statically known managed role names (for removal logic).
 * Division roles are handled separately via prefix matching.
 */
function getManagedRoleNames() {
  const roles = new Set();
  roles.add(config.SCOUTNET_SCOUT_ROLE);
  if (config.SCOUTNET_EVENT_ID) {
    roles.add(config.SCOUTNET_EVENT_ROLE);
    if (config.SCOUTNET_FEE_ROLES) {
      for (const category of new Set(
        Object.values(config.SCOUTNET_FEE_ROLES)
      )) {
        const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
        if (divConfig) {
          roles.add(divConfig.withoutDiv);
        } else {
          roles.add(category);
        }
      }
    }
  }
  return [...roles];
}

/**
 * Get prefixes for dynamic division roles, for pattern-based removal.
 * E.g. "Deltagare-{div}" → prefix "deltagare-"
 */
function getDivisionPrefixes() {
  if (!config.SCOUTNET_DIVISION_ROLES) return [];
  const prefixes = [];
  for (const { withDiv } of Object.values(config.SCOUTNET_DIVISION_ROLES)) {
    const idx = withDiv.indexOf("{div}");
    if (idx >= 0) prefixes.push(withDiv.substring(0, idx).toLowerCase());
  }
  return prefixes;
}

/**
 * Sync one user's Discord roles to match their ScoutNet data.
 * Returns { added: string[], removed: string[] } or { error: string }.
 */
export async function syncUserRoles(guildId, discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) return { error: "Inte länkad till ScoutID" };

  // Update nickname with suffix
  try {
    const member = await discord.getGuildMember(guildId, discordUserId);
    const suffix = await getNicknameSuffix(scoutId);
    const currentNick = member.nick || member.user?.global_name || "";
    // Strip any existing suffix in parentheses and reapply
    const baseName = currentNick.replace(/\s*\(.*\)\s*$/, "");
    if (baseName) {
      const newNick = (baseName + suffix).substring(0, 32);
      if (newNick !== currentNick) {
        await discord.updateGuildMemberNickname(guildId, discordUserId, newNick);
      }
    }
  } catch (e) {
    console.error(`Error updating nickname for ${discordUserId}:`, e.message);
  }

  const desiredRoles = await getDesiredRoles(scoutId);
  const managedRoles = getManagedRoleNames();
  const divPrefixes = getDivisionPrefixes();

  // Build role name → ID map from the guild
  const guildRoles = await discord.getGuildRoles(guildId);
  const roleMap = new Map();
  for (const role of guildRoles) {
    roleMap.set(role.name.toLowerCase(), role);
  }

  // Get member's current role IDs
  const member = await discord.getGuildMember(guildId, discordUserId);
  const currentRoleIds = new Set(member.roles);
  const desiredSet = new Set(desiredRoles.map((r) => r.toLowerCase()));

  const added = [];
  const removed = [];

  // Add roles the user should have
  for (const roleName of desiredRoles) {
    const role = roleMap.get(roleName.toLowerCase());
    if (role && !currentRoleIds.has(role.id)) {
      try {
        await discord.addRoleToUser(guildId, discordUserId, role.id);
        added.push(roleName);
      } catch (e) {
        console.error(
          `Failed to add role "${roleName}" (${role.id}) to user ${discordUserId}: ${e.message}`
        );
      }
    }
  }

  // Remove static managed roles the user should no longer have
  for (const managedName of managedRoles) {
    const role = roleMap.get(managedName.toLowerCase());
    if (
      role &&
      currentRoleIds.has(role.id) &&
      !desiredSet.has(managedName.toLowerCase())
    ) {
      try {
        await discord.removeRoleFromUser(guildId, discordUserId, role.id);
        removed.push(managedName);
      } catch (e) {
        console.error(
          `Failed to remove role "${managedName}" (${role.id}) from user ${discordUserId}: ${e.message}`
        );
      }
    }
  }

  // Remove old division roles (prefix-matched) that don't match current
  for (const prefix of divPrefixes) {
    for (const [name, role] of roleMap) {
      if (
        name.startsWith(prefix) &&
        currentRoleIds.has(role.id) &&
        !desiredSet.has(name)
      ) {
        try {
          await discord.removeRoleFromUser(guildId, discordUserId, role.id);
          removed.push(role.name);
        } catch (e) {
          console.error(
            `Failed to remove role "${role.name}" (${role.id}) from user ${discordUserId}: ${e.message}`
          );
        }
      }
    }
  }

  return { added, removed };
}

/**
 * Sync roles for all linked users. Clears ScoutNet cache first.
 * Returns array of { discordUserId, added, removed, error }.
 */
export async function syncAllUserRoles(guildId) {
  await storage.clearScoutNetCache();

  const linkedUsers = await storage.getAllLinkedUsers();
  const results = [];

  for (const { discordUserId } of linkedUsers) {
    try {
      const result = await syncUserRoles(guildId, discordUserId);
      results.push({ discordUserId, ...result });
    } catch (e) {
      results.push({ discordUserId, error: e.message });
    }
    // Small delay to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return results;
}
