import config from "./config.js";

console.log(`ID ${config.DISCORD_REDIRECT_URI}`);

/**
 * Register the metadata to be stored by Discord. This should be a one time action.
 * Note: uses a Bot token for authentication, not a user token.
 */
const url = `https://discord.com/api/v10/applications/${config.DISCORD_CLIENT_ID}/role-connections/metadata`;
// supported types: number_lt=1, number_gt=2, number_eq=3 number_neq=4, datetime_lt=5, datetime_gt=6, boolean_eq=7, boolean_neq=8
const body = [
  {
    key: "accepted",
    name: "Antagen",
    description: "Registrerad som antagen på Scoutnet",
    type: 7, // boolean_eq
  },
  {
    key: "leader",
    name: "Ledare",
    description: "Registrerad som ledare på Scoutnet",
    type: 7, // boolean_eq
  },
  {
    key: "ist",
    name: "IST",
    description: "Registrerad som IST (Funktionär) på Scoutnet",
    type: 7, // boolean_eq
  },
  {
    key: "troop",
    name: "Avdelning",
    description: "Nummer på avdelningen i Scoutnet",
    type: 3, // number_eq
  },
  {
    key: "patrol",
    name: "Patrull",
    description: "Nummer på patrullen i Scoutnet",
    type: 3, // number_eq
  },
];

const response = await fetch(url, {
  method: "PUT",
  body: JSON.stringify(body),
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bot ${config.DISCORD_TOKEN}`,
  },
});
if (response.ok) {
  const data = await response.json();
  console.log(data);
} else {
  //throw new Error(`Error pushing discord metadata schema: [${response.status}] ${response.statusText}`);
  const data = await response.text();
  console.log(data);
}
