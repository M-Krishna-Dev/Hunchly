import { InteractionType, InteractionResponseType } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { MongoClient } from "mongodb";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const COMPONENTS_V2_FLAG = 1 << 15;
const EPHEMERAL_FLAG = 1 << 6;

const BEATS = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

let cachedClient = null;

async function getCollection() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db("rps").collection("leaderboard");
}

async function incrementWins(guildId, userId) {
  const col = await getCollection();
  await col.updateOne(
    { guildId, userId },
    { $inc: { wins: 1 } },
    { upsert: true }
  );
}

async function removeIfZeroWins(guildId, userId) {
  const col = await getCollection();
  await col.deleteOne({ guildId, userId, wins: { $lte: 0 } });
}

async function getLeaderboard(guildId) {
  const col = await getCollection();
  return await col
    .find({ guildId, wins: { $gt: 0 } })
    .sort({ wins: -1 })
    .toArray();
}

async function getUserRank(guildId, userId) {
  const all = await getLeaderboard(guildId);
  const idx = all.findIndex((e) => e.userId === userId);
  if (idx === -1) return null;
  return { rank: idx + 1, score: all[idx].wins };
}

async function removeUserFromGuild(guildId, userId) {
  const col = await getCollection();
  await col.deleteOne({ guildId, userId });
}

function getResult(a, b) {
  if (a === b) return "draw";
  if (BEATS[a] === b) return "a";
  return "b";
}

function ephemeral(content) {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: EPHEMERAL_FLAG | COMPONENTS_V2_FLAG,
      components: [
        {
          type: 17,
          components: [{ type: 10, content }],
        },
      ],
    },
  };
}

function buildLeaderboardComponents(allEntries, userRank) {
  const top10 = allEntries.slice(0, 10);

  const footerText = userRank
    ? `-# You are ranked #${userRank.rank} with a score of \`${userRank.score}\`.`
    : `-# You are not ranked yet.`;

  if (top10.length === 0) {
    return [
      {
        type: 17,
        components: [
          { type: 10, content: "## Leaderboard\nNo games played yet." },
          { type: 14, divider: true },
          { type: 10, content: footerText },
        ],
      },
    ];
  }

  const rows = top10
    .map((entry, i) => `${i + 1}. <@${entry.userId}> \`${entry.wins}\``)
    .join("\n");

  return [
    {
      type: 17,
      components: [
        { type: 10, content: "## Leaderboard" },
        { type: 14, divider: true },
        { type: 10, content: rows },
        { type: 14, divider: true },
        { type: 10, content: footerText },
      ],
    },
  ];
}

function buildChallengeComponents(challengerId, opponentId) {
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Rock Paper Scissors\n<@${challengerId}> has challenged <@${opponentId}>!\n<@${opponentId}>, pick your move:`,
        },
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Rock",     custom_id: `rps_move:${challengerId}:${opponentId}:rock`     },
            { type: 2, style: 1, label: "Paper",    custom_id: `rps_move:${challengerId}:${opponentId}:paper`    },
            { type: 2, style: 1, label: "Scissors", custom_id: `rps_move:${challengerId}:${opponentId}:scissors` },
          ],
        },
      ],
    },
  ];
}

function buildChallengerPickComponents(challengerId, opponentId, opponentMove) {
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Rock Paper Scissors\n<@${opponentId}> has picked. <@${challengerId}>, now pick your move:`,
        },
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Rock",     custom_id: `rps_challenger:${challengerId}:${opponentId}:${opponentMove}:rock`     },
            { type: 2, style: 1, label: "Paper",    custom_id: `rps_challenger:${challengerId}:${opponentId}:${opponentMove}:paper`    },
            { type: 2, style: 1, label: "Scissors", custom_id: `rps_challenger:${challengerId}:${opponentId}:${opponentMove}:scissors` },
          ],
        },
      ],
    },
  ];
}

function buildResultComponents(challengerId, challengerMove, opponentId, opponentMove, result) {
  const label = { rock: "Rock", paper: "Paper", scissors: "Scissors" };
  const outcome =
    result === "draw"
      ? "It's a **draw**!"
      : result === "a"
      ? `<@${challengerId}> wins!`
      : `<@${opponentId}> wins!`;

  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Rock Paper Scissors — Result\n<@${challengerId}> played **${label[challengerMove]}**\n<@${opponentId}> played **${label[opponentMove]}**\n\n${outcome}`,
        },
      ],
    },
  ];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const isValid = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
  if (!isValid) {
    return res.status(401).end("Invalid signature");
  }

  const interaction = JSON.parse(rawBody);

  if (interaction.type === InteractionType.Ping) {
    return res.json({ type: InteractionResponseType.Pong });
  }

  const guildId = interaction.guild_id;

  if (interaction.type === InteractionType.GuildMemberRemove) {
    const userId = interaction.data?.user?.id;
    if (userId && guildId) {
      await removeUserFromGuild(guildId, userId);
    }
    return res.status(200).end();
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    const { name } = interaction.data;

    if (name === "challenge") {
      const targetUser = interaction.data.options?.find((o) => o.name === "user")?.value;
      const challengerId = interaction.member?.user?.id || interaction.user?.id;

      if (!targetUser) return res.json(ephemeral("You must mention a user to challenge."));
      if (targetUser === challengerId) return res.json(ephemeral("You cannot challenge yourself."));

      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildChallengeComponents(challengerId, targetUser),
        },
      });
    }

    if (name === "leaderboard") {
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const allEntries = await getLeaderboard(guildId);
      const userRank = await getUserRank(guildId, userId);
      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildLeaderboardComponents(allEntries, userRank),
          allowed_mentions: { parse: [] },
        },
      });
    }
  }

  if (interaction.type === InteractionType.MessageComponent) {
    const customId = interaction.data.custom_id;
    const userId = interaction.member?.user?.id || interaction.user?.id;

    if (customId.startsWith("rps_move:")) {
      const parts = customId.split(":");
      const challengerId = parts[1];
      const opponentId = parts[2];
      const opponentMove = parts[3];

      if (userId !== opponentId) return res.json(ephemeral("This challenge is not for you."));

      return res.json({
        type: InteractionResponseType.UpdateMessage,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildChallengerPickComponents(challengerId, opponentId, opponentMove),
        },
      });
    }

    if (customId.startsWith("rps_challenger:")) {
      const parts = customId.split(":");
      const challengerId = parts[1];
      const opponentId = parts[2];
      const opponentMove = parts[3];
      const challengerMove = parts[4];

      if (userId !== challengerId) return res.json(ephemeral("This challenge is not for you."));

      const result = getResult(challengerMove, opponentMove);

      if (result === "a") {
        await incrementWins(guildId, challengerId);
      } else if (result === "b") {
        await incrementWins(guildId, opponentId);
      }

      return res.json({
        type: InteractionResponseType.UpdateMessage,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildResultComponents(challengerId, challengerMove, opponentId, opponentMove, result),
        },
      });
    }
  }

  return res.status(400).end("Unknown interaction");
}