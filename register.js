import { REST, Routes } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const rest = new REST({ version: "10" }).setToken(TOKEN);

const commands = [
  {
    name: "challenge",
    description: "Challenge another user to rock paper scissors",
    options: [
      {
        name: "user",
        description: "The user you want to challenge",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show the rock paper scissors leaderboard",
  },
];

(async () => {
  try {
    console.log("Registering application commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Commands registered successfully.");
  } catch (error) {
    console.error("Failed to register commands:", error);
    process.exit(1);
  }
})();