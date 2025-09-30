/**
 * Code specific for wsj27 registration in ScoutNet
 */
import * as scoutnet from "./scoutnet.js";

/**
 * Get User roles
 *
 * Returns an array of role names to be assigned in Discord
 *
 * Example return value: ["wsj27", "ledare"]
 */
export async function getUserRoles(member_id) {
  const roles = [];

  const user_data = await scoutnet.getUserData(member_id);

  if (user_data) {
    if (user_data["is_leader"]) {
      roles.push("ledare");
    }
    if (user_data["is_ist"]) {
      roles.push("ist");
    }
    if (user_data["avdelning"] && user_data["avdelning"] !== 0) {
      roles.push("avd" + user_data["avdelning"]);
    }
  }

  return roles;
}

/**
 * Get User data from ScoutNet
 */
export async function getUserData(member_id) {
  const data = {};

  const participant_data = await scoutnet.getParticipant(member_id);

  if (participant_data) {
    data["is_participant"] = participant_data["cancelled_date"] == null;
    data["is_leader"] = participant_data["questions"]
      ? participant_data["questions"]["82553"] === "55897"
      : false;
    data["is_ist"] = participant_data["questions"]
      ? participant_data["questions"]["82555"] === "55897"
      : false;
    data["troop"] = participant_data["questions"]
      ? participant_data["questions"]["82552"] || 0
      : null;
    data["patrol"] = participant_data["questions"]
      ? participant_data["questions"]["82554"] || 0
      : null;
  } else {
    data["is_participant"] = false;
    data["is_leader"] = false;
    data["is_ist"] = false;
    data["troop"] = null;
    data["patrol"] = null;
  }

  return data;
}
