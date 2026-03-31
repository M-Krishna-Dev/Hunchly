import { InteractionType, InteractionResponseType } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { MongoClient } from "mongodb";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const COMPONENTS_V2_FLAG = 1 << 15;
const EPHEMERAL_FLAG = 1 << 6;

let cachedClient = null;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db("numguess");
}

async function getGamesCol() {
  const db = await getDb();
  return db.collection("games");
}

async function getLeaderboardCol() {
  const db = await getDb();
  return db.collection("leaderboard");
}

async function incrementWins(guildId, userId) {
  const col = await getLeaderboardCol();
  await col.updateOne(
    { guildId, userId },
    { $inc: { wins: 1 } },
    { upsert: true }
  );
}

async function getLeaderboard(guildId) {
  const col = await getLeaderboardCol();
  return col.find({ guildId, wins: { $gt: 0 } }).sort({ wins: -1 }).toArray();
}

async function getUserRank(guildId, userId) {
  const all = await getLeaderboard(guildId);
  const idx = all.findIndex((e) => e.userId === userId);
  if (idx === -1) return null;
  return { rank: idx + 1, score: all[idx].wins };
}

async function saveGame(gameId, data) {
  const col = await getGamesCol();
  await col.updateOne({ gameId }, { $set: { gameId, ...data } }, { upsert: true });
}

async function getGame(gameId) {
  const col = await getGamesCol();
  return col.findOne({ gameId });
}

async function deleteGame(gameId) {
  const col = await getGamesCol();
  await col.deleteOne({ gameId });
}

// ─── Helper: resolve userId from any interaction type ───────────────────────
function resolveUserId(interaction) {
  // In guild context, member.user.id is the correct field
  // In DM context, user.id is used
  return (
    interaction.member?.user?.id ??
    interaction.user?.id ??
    null
  );
}

// ─── Response builders ───────────────────────────────────────────────────────

function ephemeral(content) {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: EPHEMERAL_FLAG | COMPONENTS_V2_FLAG,
      components: [{ type: 17, components: [{ type: 10, content }] }],
    },
  };
}

function buildChallengeComponents(challengerId, opponentId) {
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Number Guessing Game\n<@${challengerId}> has challenged <@${opponentId}>!\n<@${opponentId}>, do you accept?`,
        },
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: "Accept", custom_id: `ng_accept:${challengerId}:${opponentId}` },
            { type: 2, style: 4, label: "Decline", custom_id: `ng_decline:${challengerId}:${opponentId}` },
          ],
        },
      ],
    },
  ];
}

function buildSetNumberPrompt(setterId, guesserId, round) {
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Round ${round} — Set Your Number\n<@${setterId}>, pick a secret number between **1 and 100**.\nOnly you can see this — <@${guesserId}> will try to guess it.`,
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Set Number",
              custom_id: `ng_set_modal:${setterId}:${guesserId}:${round}`,
            },
          ],
        },
      ],
    },
  ];
}

function buildGuessPrompt(guesserId, setterId, round, guessCount, hint) {
  const hintLine = hint ? `\nHint: **${hint}**` : "";
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Round ${round} — Guess the Number\n<@${guesserId}>, guess the number between **1 and 100**!${hintLine}\nGuesses so far: \`${guessCount}\``,
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Make a Guess",
              custom_id: `ng_guess_modal:${setterId}:${guesserId}:${round}`,
            },
          ],
        },
      ],
    },
  ];
}

function buildRoundResultComponents(setterId, guesserId, guesses, round, nextSetterId, nextGuesserId) {
  return [
    {
      type: 17,
      components: [
        {
          type: 10,
          content: `## Round ${round} Complete\n<@${guesserId}> guessed the number in **${guesses} guess${guesses !== 1 ? "es" : ""}**!`,
        },
        { type: 14, divider: true },
        {
          type: 10,
          content: `Now roles swap. <@${nextSetterId}> will set a number and <@${nextGuesserId}> will guess.`,
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Continue to Round 2",
              custom_id: `ng_start_round2:${nextSetterId}:${nextGuesserId}`,
            },
          ],
        },
      ],
    },
  ];
}

function buildFinalResultComponents(guildId, p1Id, p1Guesses, p2Id, p2Guesses, winnerId) {
  const outcomeText =
    p1Guesses === p2Guesses
      ? "It's a **draw**! Nobody wins this round."
      : `<@${winnerId}> wins with fewer guesses!`;

  return [
    {
      type: 17,
      components: [
        { type: 10, content: "## Game Over — Final Result" },
        { type: 14, divider: true },
        {
          type: 10,
          content: `<@${p1Id}> took **${p1Guesses} guess${p1Guesses !== 1 ? "es" : ""}**\n<@${p2Id}> took **${p2Guesses} guess${p2Guesses !== 1 ? "es" : ""}**`,
        },
        { type: 14, divider: true },
        { type: 10, content: outcomeText },
      ],
    },
  ];
}

function buildLeaderboardComponents(allEntries, userRank) {
  const top10 = allEntries.slice(0, 10);
  const footerText = userRank
    ? `-# You are ranked #${userRank.rank} with \`${userRank.score}\` wins.`
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
    .map((entry, i) => `${i + 1}. <@${entry.userId}>・\`${entry.wins}\``)
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

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const rawBody = await getRawBody(req);

  if (!verifyKey(rawBody, signature, timestamp, PUBLIC_KEY)) {
    return res.status(401).end("Invalid signature");
  }

  const interaction = JSON.parse(rawBody);

  if (interaction.type === InteractionType.Ping) {
    return res.json({ type: InteractionResponseType.Pong });
  }

  const guildId = interaction.guild_id;

  // FIX: use dedicated resolver so userId is never undefined
  const userId = resolveUserId(interaction);
  if (!userId) {
    console.error("Could not resolve userId from interaction:", JSON.stringify(interaction, null, 2));
    return res.status(400).end("Could not resolve user ID");
  }

  // ─── Slash Commands ─────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.ApplicationCommand) {
    const { name } = interaction.data;

    if (name === "guess") {
      const targetUser = interaction.data.options?.find((o) => o.name === "user")?.value;
      if (!targetUser) return res.json(ephemeral("You must mention a user to challenge."));
      if (targetUser === userId) return res.json(ephemeral("You cannot challenge yourself."));

      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildChallengeComponents(userId, targetUser),
        },
      });
    }

    if (name === "leaderboard") {
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

  // ─── Message Components (buttons) ───────────────────────────────────────────
  if (interaction.type === InteractionType.MessageComponent) {
    const customId = interaction.data.custom_id;
    const parts = customId.split(":");

    // ── Decline challenge ──────────────────────────────────────────────────
    if (customId.startsWith("ng_decline:")) {
      const challengerId = parts[1];
      const opponentId = parts[2];
      if (userId !== opponentId) return res.json(ephemeral("This is not your challenge."));
      return res.json({
        type: InteractionResponseType.UpdateMessage,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: [
            {
              type: 17,
              components: [
                {
                  type: 10,
                  content: `## Number Guessing Game\n<@${opponentId}> declined the challenge.`,
                },
              ],
            },
          ],
        },
      });
    }

    // ── Accept challenge ───────────────────────────────────────────────────
    if (customId.startsWith("ng_accept:")) {
      const challengerId = parts[1];
      const opponentId = parts[2];
      if (userId !== opponentId) return res.json(ephemeral("This is not your challenge."));

      // FIX: post a NEW public message for the set-number prompt instead of
      // updating the challenge message. This prevents the setter from being
      // blocked by the message author mismatch in ephemeral/update flows,
      // and keeps the challenge message intact as a record.
      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildSetNumberPrompt(challengerId, opponentId, 1),
          allowed_mentions: { parse: [] },
        },
      });
    }

    // ── Open "Set Number" modal ────────────────────────────────────────────
    if (customId.startsWith("ng_set_modal:")) {
      const setterId = parts[1];
      const guesserId = parts[2];
      const round = parseInt(parts[3]);

      // FIX: clear error message tells setter if they click the wrong button
      if (userId !== setterId) {
        return res.json(ephemeral(`Only <@${setterId}> can set the number for this round.`));
      }

      return res.json({
        type: 5, // MODAL
        data: {
          custom_id: `ng_set_submit:${setterId}:${guesserId}:${round}`,
          title: `Round ${round} — Set Your Number`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "number",
                  label: "Enter a number between 1 and 100",
                  style: 1,
                  min_length: 1,
                  max_length: 3,
                  required: true,
                },
              ],
            },
          ],
        },
      });
    }

    // ── Open "Make a Guess" modal ──────────────────────────────────────────
    if (customId.startsWith("ng_guess_modal:")) {
      const setterId = parts[1];
      const guesserId = parts[2];
      const round = parseInt(parts[3]);

      if (userId !== guesserId) {
        return res.json(ephemeral(`Only <@${guesserId}> can guess this round.`));
      }

      return res.json({
        type: 5, // MODAL
        data: {
          custom_id: `ng_guess_submit:${setterId}:${guesserId}:${round}`,
          title: `Round ${round} — Make a Guess`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "guess",
                  label: "Your guess (1–100)",
                  style: 1,
                  min_length: 1,
                  max_length: 3,
                  required: true,
                },
              ],
            },
          ],
        },
      });
    }

    // ── Start round 2 ─────────────────────────────────────────────────────
    if (customId.startsWith("ng_start_round2:")) {
      const setterId = parts[1];
      const guesserId = parts[2];
      if (userId !== setterId && userId !== guesserId) {
        return res.json(ephemeral("You are not part of this game."));
      }

      return res.json({
        type: InteractionResponseType.UpdateMessage,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildSetNumberPrompt(setterId, guesserId, 2),
          allowed_mentions: { parse: [] },
        },
      });
    }
  }

  // ─── Modal Submissions ───────────────────────────────────────────────────────
  if (interaction.type === InteractionType.ModalSubmit) {
    const customId = interaction.data.custom_id;
    const parts = customId.split(":");

    // ── Save secret number ─────────────────────────────────────────────────
    if (customId.startsWith("ng_set_submit:")) {
      const setterId = parts[1];
      const guesserId = parts[2];
      const round = parseInt(parts[3]);

      // Guard: only the setter should be submitting this modal
      if (userId !== setterId) {
        return res.json(ephemeral("You are not the setter for this round."));
      }

      const raw = interaction.data.components[0].components[0].value.trim();
      const secret = parseInt(raw);

      if (isNaN(secret) || secret < 1 || secret > 100) {
        return res.json(ephemeral("Invalid number. Pick a number between 1 and 100."));
      }

      const gameId = `${guildId}:${setterId}:${guesserId}:${round}`;
      await saveGame(gameId, { setterId, guesserId, guildId, secret, guessCount: 0, round });

      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildGuessPrompt(guesserId, setterId, round, 0, null),
          allowed_mentions: { parse: [] },
        },
      });
    }

    // ── Process guess ──────────────────────────────────────────────────────
    if (customId.startsWith("ng_guess_submit:")) {
      const setterId = parts[1];
      const guesserId = parts[2];
      const round = parseInt(parts[3]);

      // Guard: only the guesser should be submitting this modal
      if (userId !== guesserId) {
        return res.json(ephemeral("You are not the guesser for this round."));
      }

      const raw = interaction.data.components[0].components[0].value.trim();
      const guess = parseInt(raw);

      if (isNaN(guess) || guess < 1 || guess > 100) {
        return res.json(ephemeral("Invalid guess. Pick a number between 1 and 100."));
      }

      const gameId = `${guildId}:${setterId}:${guesserId}:${round}`;
      const game = await getGame(gameId);
      if (!game) return res.json(ephemeral("Game not found. The setter must set a number first."));

      const newCount = game.guessCount + 1;
      await saveGame(gameId, { ...game, guessCount: newCount });

      if (guess === game.secret) {
        await deleteGame(gameId);

        if (round === 1) {
          // Store round 1 result keyed by the original player order (challenger = p1)
          await saveGame(`r1result:${guildId}:${setterId}:${guesserId}`, { guessCount: newCount });

          return res.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              flags: COMPONENTS_V2_FLAG,
              // Roles swap: round-1 guesser becomes setter, round-1 setter becomes guesser
              components: buildRoundResultComponents(setterId, guesserId, newCount, 1, guesserId, setterId),
              allowed_mentions: { parse: [] },
            },
          });
        } else {
          // Round 2 done — look up round 1 result
          // In round 1: setterId was the challenger, guesserId was the opponent
          // In round 2 (roles swapped): setterId is now the original opponent, guesserId is original challenger
          // The r1result key was saved as: r1result:guildId:round1Setter:round1Guesser
          // round1Setter = original challengerId = round2 guesserId
          // round1Guesser = original opponentId = round2 setterId
          const r1Key = `r1result:${guildId}:${guesserId}:${setterId}`;
          const round1Data = await getGame(r1Key);
          const p1Guesses = round1Data?.guessCount ?? 0;
          const p2Guesses = newCount;

          await deleteGame(r1Key);

          // p1 = original challenger (guesserId in round 2)
          // p2 = original opponent (setterId in round 2)
          const p1Id = guesserId;
          const p2Id = setterId;

          let winnerId = null;
          if (p1Guesses !== p2Guesses) {
            winnerId = p1Guesses < p2Guesses ? p1Id : p2Id;
            await incrementWins(guildId, winnerId);
          }

          return res.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              flags: COMPONENTS_V2_FLAG,
              components: buildFinalResultComponents(guildId, p1Id, p1Guesses, p2Id, p2Guesses, winnerId),
              allowed_mentions: { parse: [] },
            },
          });
        }
      }

      // Wrong guess — send a hint
      const hint = guess < game.secret ? "Go higher" : "Go lower";
      return res.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          flags: COMPONENTS_V2_FLAG,
          components: buildGuessPrompt(guesserId, setterId, round, newCount, hint),
          allowed_mentions: { parse: [] },
        },
      });
    }
  }

  return res.status(400).end("Unknown interaction");
}
