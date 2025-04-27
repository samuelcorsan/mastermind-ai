// TODO: Classify the code in several files (is very messy)

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  Routes,
  REST,
  ActivityType,
} from "discord.js";
import fetch from "node-fetch";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import axios from "axios";
import { consumeCreditIfNeeded } from "./discord.js";
const {
  BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  GROQ_API_KEY,
  BRAVE_API_KEY,
} = process.env;
import {
  FINDTRIAL_SYSTEM_PROMPT,
  MASTERMIND_SYSTEM_PROMPT,
} from "./prompts.js";

// -------------------------
// DOTENV
// -------------------------
dotenv.config();

// -------------------------
// Globals: Pagination state
// -------------------------
// Map messageId => { pages: string[], current: number }
const pageMap = new Map();

/**
 * Divides a text into pages of up to pageSize characters.
 */
function paginate(text, pageSize = 1850) {
  const pages = [];
  for (let i = 0; i < text.length; i += pageSize) {
    pages.push(text.slice(i, i + pageSize));
  }
  return pages;
}

// -------------------------
// Config & Moderation system
// -------------------------
const MENTION_ID = "<@1310277424046673971>";
const MENTION_ID_2 = "<@&1353029770249502784>";

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});
const censor = new TextCensor();

const groq = new Groq({ apiKey: GROQ_API_KEY });
const model = "llama3-8b-8192";

const queue = [];
let processing = false;

// -------------------------
// Brave Search
// -------------------------
async function getSearchResult(query) {
  console.log("🔍 Buscando en Brave:", query);
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query
  )}`;

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": BRAVE_API_KEY,
  };

  try {
    const { data } = await axios.get(endpoint, { headers });
    return data.web?.results?.slice(0, 3) || [];
  } catch (e) {
    console.error("Error Brave API:", e);
    return [];
  }
}

async function run_conversation(message) {
  const messages = [
    {
      role: "system",
      content: FINDTRIAL_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: message,
    },
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "getSearchResult",
        description:
          "Returns an array of web search results (title, snippet, url, etc.)",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The query to search for in Google",
            },
          },
          required: ["query"],
        },
      },
    },
  ];

  const chatCompletion = await groq.chat.completions.create({
    messages,
    model,
    tools,
    tool_choice: "auto",
    max_tokens: 4096,
  });

  const response_message = chatCompletion.choices[0]?.message;
  const tool_calls = response_message.tool_calls;

  if (!tool_calls || tool_calls.length === 0) {
    return response_message.content;
  }

  for (const call of tool_calls) {
    const args = JSON.parse(call.function.arguments);
    const toolResult = await getSearchResult(args.query);

    messages.push({
      role: "tool",
      name: call.function.name,
      tool_call_id: call.id,
      content: JSON.stringify(toolResult),
    });
  }

  const followUp = await groq.chat.completions.create({
    model,
    messages,
  });

  return followUp.choices[0]?.message.content;
}

// -------------------------
// SLASH COMMANDS
// -------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("findtrial")
    .setDescription("Look for football clubs where you can do a trial")
    .addStringOption((opt) =>
      opt
        .setName("country")
        .setDescription("The country where you are looking to do the trial")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("city")
        .setDescription("The city where you are looking to do the trial")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("division")
        .setDescription(
          "The division of your country where you are looking to play"
        )
        .setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

(async () => {
  try {
    console.log("🚀 Logging /findtrial command...");
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Command registered");
  } catch (error) {
    console.error(error);
  }
})();

// -------------------------
// QUEUE
// -------------------------
async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  const job = queue.shift();
  const { interaction, userPrompt, initialMessageSent } = job;

  if (!initialMessageSent) {
    try {
      await interaction.editReply("🔎 Processing your request...");
    } catch (err) {
      console.warn("⚠️ The initial message could not be edited:", err.message);
    }
  }

  try {
    const startTime = Date.now();
    const reply = await run_conversation(userPrompt);

    const elapsed = Date.now() - startTime;
    const delay = Math.max(0, 5000 - elapsed);

    setTimeout(async () => {
      await interaction.editReply({
        content: reply,
        flags: ["SuppressEmbeds"],
      });
      processing = false;
      processNext();
    }, delay);
  } catch (err) {
    console.error("❌ An error occurred while processing your request.", err);
    await interaction.editReply(
      "❌ An error occurred while processing your request."
    );
    processing = false;
    processNext();
  }

  processing = false;
  processNext();
}

// -------------------------
// Initialization of Groq and Discord
// -------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const messageHistory = new Map();

process.on("uncaughtException", (error) => {
  console.error("Excepción no capturada:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Promesa rechazada sin capturar:", promise, "razón:", reason);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "findtrial"
  ) {
    const user = interaction.user;
    const city = interaction.options.getString("city");
    const country = interaction.options.getString("country");
    let division = interaction.options.getString("division");

    if (division) {
      division = division
        .replace(
          /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)?\s*division\b/i,
          ""
        )
        .trim();
    }

    const position = queue.length - 1;
    let initialMessageSent = false;
    const usaCountries = [
      "usa",
      "united states",
      "estados unidos",
      "us",
      "united states of america",
      "u.s.a",
      "u.s",
    ];

    let userPrompt = `football clubs ${city} ${country} ${division} division`;

    if (usaCountries.includes(country.toLowerCase())) {
      userPrompt = userPrompt.replace("football", "soccer");
    }

    if (matcher.hasMatch(userPrompt)) {
      await interaction.reply({
        content:
          "🚫 Your message contains inappropriate language. Please rephrase it without offensive words. If you think this is a moderation error contact us.",
        flags: ["Ephemeral"],
      });
      return;
    }

    const ok = await consumeCreditIfNeeded(user);
    if (!ok) {
      await interaction.reply({
        content:
          "🚫 You have run out of free uses. To continue using the bot, please purchase a paid plan to keep improving as a player.",
        flags: ["Ephemeral"],
      });
      return;
    }

    if (position > 0) {
      await interaction.deferReply();
      await interaction.editReply(
        `⌛ There is ${position} request(s) before yours. Please wait in the queue...`
      );
      initialMessageSent = true;
    } else {
      await interaction.deferReply();
    }

    queue.push({ interaction, userPrompt, initialMessageSent });
    processNext();
  }

  if (interaction.isButton()) {
    if (["prev_page", "next_page"].includes(interaction.customId)) {
      const state = pageMap.get(interaction.message.id);
      if (!state)
        return interaction.reply({
          content: "Pagination expired.",
          ephemeral: true,
        });
      if (
        interaction.customId === "next_page" &&
        state.current < state.pages.length - 1
      )
        state.current++;
      if (interaction.customId === "prev_page" && state.current > 0)
        state.current--;
      const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("prev_page")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(state.current === 0),
        new ButtonBuilder()
          .setCustomId("next_page")
          .setEmoji("▶️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(state.current === state.pages.length - 1)
      );
      let content = state.pages[state.current];
      if (state.current > 0) {
        content += "\n\n**Click on the arrow above to go backwards.**";
      }
      await interaction.update({ content, components: [newRow] });
      return;
    }
    if (interaction.customId === "toggle_news_role") {
      const roleId = "1359976773181247800";
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasRole = member.roles.cache.has(roleId);

      try {
        await interaction.deferUpdate();

        if (hasRole) {
          await member.roles.remove(roleId);
          await interaction.followUp({
            content: "You’ve unsubscribed from football news updates.",
            flags: ["Ephemeral"],
          });
        } else {
          await member.roles.add(roleId);
          await interaction.followUp({
            content: "You’ve subscribed to football news updates!",
            flags: ["Ephemeral"],
          });
        }
      } catch (error) {
        console.error("Error changing role:", error);
        await interaction.followUp({
          content: "There was a problem updating your subscription.",
          flags: ["Ephemeral"],
        });
      }
    }
  }
});

client.once("ready", () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);

  const activities = [
    { name: "match analysis ⚽", type: ActivityType.WATCHING },
    { name: "training tips", type: ActivityType.LISTENING },
    { name: "your gameplay 🧠", type: ActivityType.WATCHING },
    { name: "how to improve", type: ActivityType.LISTENING },
    { name: "mention me to begin", type: ActivityType.PLAYING },
    { name: "/findtrial to join a club 🔍", type: ActivityType.PLAYING },
  ];

  let i = 0;
  setInterval(() => {
    client.user.setActivity(activities[i]);
    i = (i + 1) % activities.length;
  }, 10000); // Changes every 10 seconds

  /*setInterval(checkForNewTweet, 120000);*/
});

// Message handling for interaction with Groq
client.on("messageCreate", async (message) => {
  if (
    message.author.bot ||
    (!message.content.includes(MENTION_ID) &&
      !message.content.includes(MENTION_ID_2))
  )
    return;

  const images = Array.from(message.attachments.values()).filter((att) =>
    att.contentType?.startsWith("image/")
  );

  let userMessage = message.content;

  userMessage = userMessage
    .replace(MENTION_ID, "")
    .replace(MENTION_ID_2, "")
    .trim();

  if (!userMessage) return;

  const userId = message.author.id;
  if (!messageHistory.has(userId)) {
    messageHistory.set(userId, []);
  }

  const history = messageHistory.get(userId);
  if (history.length > 10) {
    history.shift();
  }

  if (images.length > 0) {
    const contentBlocks = [];
    if (userMessage) {
      contentBlocks.push({
        type: "text",
        text: userMessage,
      });
    }
    for (const img of images) {
      contentBlocks.push({
        type: "image_url",
        image_url: {
          url: img.url,
        },
      });
    }
    history.push({
      role: "user",
      content: contentBlocks,
    });
  } else {
    history.push({
      role: "user",
      content: userMessage,
    });
  }

  try {
    await message.channel.sendTyping();

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "system",
          content: MASTERMIND_SYSTEM_PROMPT,
        },
        ...history,
      ],
    });

    let reply =
      response.choices[0]?.message?.content ||
      "I don’t have a response at this moment.";

    history.push({ role: "assistant", content: reply });

    const pages = paginate(reply, 1850);
    if (pages.length === 1) {
      await message.reply(pages[0]);
    } else {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("prev_page")
          .setEmoji("◀")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("next_page")
          .setEmoji("▶")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(false)
      );
      const firstText =
        pages[0] +
        "\n\n**The character limit has been reached, to continue viewing the message click on the forward arrow.**";
      const sent = await message.reply({
        content: firstText,
        components: [row],
      });
      pageMap.set(sent.id, { pages, current: 0 });
    }
  } catch (error) {
    console.error("Error with OpenAI:", error);
    await message.channel.send(
      "❌ An error occurred. Try again and if the problem persists contact us."
    );
  }
});

// -------------------------
// Functionality to detect new tweets from @fabrizioromano and send an embed to a specific channel.
// TODO: fix it (does not work)
// -------------------------

// Variables to store the user id of X and the last viewed tweet.
let twitterUserId = null;
let lastTweetId = null;
const TWITTER_USERNAME = "fabrizioromano";

// Function to get the user id in X using the user name
async function getTwitterUserId(username) {
  const userUrl = `https://api.twitter.com/2/users/by/username/${username}`;
  try {
    const response = await fetch(userUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}`,
      },
    });
    const data = await response.json();
    if (data.data && data.data.id) {
      return data.data.id;
    } else {
      console.error("No se encontró el usuario en X:", data);
    }
  } catch (error) {
    console.error("Error al obtener el userId de X:", error);
  }
  return null;
}

// Function to check if there is a new tweet
async function checkForNewTweet() {
  try {
    if (!twitterUserId) {
      twitterUserId = await getTwitterUserId(TWITTER_USERNAME);
      if (!twitterUserId) return;
    }

    const tweetTimelineUrl = `https://api.twitter.com/2/users/${twitterUserId}/tweets?exclude=retweets,replies&max_results=5&expansions=attachments.media_keys&media.fields=url,type`;

    const response = await fetch(tweetTimelineUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}`,
      },
    });

    const data = await response.json();
    if (!data.data || data.data.length === 0) return;

    const latestTweet = data.data[0];
    if (lastTweetId === latestTweet.id) return;
    lastTweetId = latestTweet.id;

    const mediaMap = new Map();
    if (data.includes && data.includes.media) {
      for (const media of data.includes.media) {
        if (media.type === "photo") {
          mediaMap.set(media.media_key, media.url);
        }
      }
    }

    let imageUrl = null;
    if (latestTweet.attachments?.media_keys?.length > 0) {
      const firstImageKey = latestTweet.attachments.media_keys.find((key) =>
        mediaMap.has(key)
      );
      imageUrl = mediaMap.get(firstImageKey);
    }

    const guild = client.guilds.cache.get("1274766916740845638");
    if (!guild) {
      console.error("No se encontró el servidor.");
      return;
    }

    const channel = guild.channels.cache.get("1359962363926806568");
    if (!channel) {
      console.error("No se encontró el canal.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("New football new")
      .setDescription(latestTweet.text)
      .setTimestamp();

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const button = new ButtonBuilder()
      .setCustomId("toggle_news_role")
      .setEmoji("📅")
      .setLabel("Notify me about football news")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(button);

    await channel.send({
      content: "<@&1359976773181247800>",
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    console.error("Error al verificar nuevos tweets:", error);
  }
}

// -------------------------
// Discord bot login
// -------------------------
client.login(process.env.BOT_TOKEN).catch((err) => {
  console.error("❌ Error al iniciar sesión:", err);
});
