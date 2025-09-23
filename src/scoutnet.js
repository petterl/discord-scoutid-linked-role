import config from "./config.js";
import * as storage from "./storage.js";

/**
 * Code specific to communicating with the ScoutNet API.
 * See https://scoutnet.se for more details.
 *
 */

/**
 * Get User data from ScoutNet
 */
export async function getUserData(member_id) {
  const data = {};

  const participant_data = await getParticipant(member_id);

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

/**
 * Get specific participant data from ScoutNet
 * Return null if participant is missing
 */
export async function getParticipant(member_id) {
  const participants = await getParticipants(config.SCOUTNET_FORM_ID);
  const key = String(member_id);
  return Object.prototype.hasOwnProperty.call(participants, key)
    ? participants[key]
    : null;
}

/**
 * Get all participants and their answers to the questions for a specific form.
 * 
 * Example response:
  {
    "participants": {
        "123": {
            "member_no": 123,
            "first_name": "Petter",
            "last_name": "Sandholdt",
            "registration_date": "2025-06-29 18:15:04",
            "cancelled_date": null,
            "questions": {
                "82553": "55897",
                "82551": [
                    "55894"
                ],
                "82560": "Nej",
            },
        },
    },
  }
*/
export async function getParticipants() {
  // Check cache first
  const cached = await storage.getScoutNetdata("participants");
  if (cached) {
    return cached;
  }
  // Not in cache, fetch from API
  const url = `https://scoutnet.se/api/project/get/participants?id=${config.SCOUTNET_EVENT_ID}&key=${config.SCOUTNET_PARTICIPANTS_APIKEY}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (response.ok) {
    // Parse and cache for 10 minutes
    const data = await response.json();
    storage.storeScoutNetdata("participants", data["participants"]);
    return data["participants"];
  } else {
    const errorText = await response.text();
    throw new Error(
      `Error fetching ScoutNet participants: [${response.status}] ${response.statusText} - ${errorText}`
    );
  }
}

/**
 * Get all forms for an event.
 */
export async function getForms() {
  // Check cache first
  const cached = await storage.getScoutNetdata("forms");
  if (cached) {
    return cached;
  }
  // Not in cache, fetch from API
  const url = `https://scoutnet.se/api/project/get/questions?id=${config.SCOUTNET_EVENT_ID}&key=${config.SCOUTNET_QUESTIONS_APIKEY}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (response.ok) {
    const data = await response.json();

    const forms = data["forms"];
    storage.storeScoutNetdata("forms", forms);
    return forms;
  } else {
    const errorText = await response.text();
    throw new Error(
      `Error fetching ScoutNet forms: [${response.status}] ${response.statusText} - ${errorText}`
    );
  }
}

/**
 * Get all questions and answer types for the questions for a specific form.
 */
export async function getQuestions(form_id) {
  // Check cache first
  const cached = await storage.getScoutNetdata("questions");
  if (cached) {
    return cached;
  }
  // Not in cache, fetch from API
  url = `https://scoutnet.se/api/project/get/questions?id=${config.SCOUTNET_EVENT_ID}&key=${config.SCOUTNET_QUESTIONS_APIKEY}&form_id=${form_id}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (response.ok) {
    const data = await response.json();
    storage.storeScoutNetdata("questions", data);
    return data;
  } else {
    const errorText = await response.text();
    throw new Error(
      `Error fetching ScoutNet participant questions: [${response.status}] ${response.statusText} - ${errorText}`
    );
  }
}
