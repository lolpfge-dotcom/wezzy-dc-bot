const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  AttachmentBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Partials,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ---------------------------------------------------------------------------
// Config + startup validation
// ---------------------------------------------------------------------------
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  SELLAUTH_API_KEY: process.env.SELLAUTH_API_KEY,
  SELLAUTH_SHOP_ID: process.env.SELLAUTH_SHOP_ID,
  BUYER_ROLE_ID: process.env.BUYER_ROLE_ID,
  RESTOCK_ROLE_ID: process.env.RESTOCK_ROLE_ID,
  VERIFICATION_CHANNEL_ID: process.env.VERIFICATION_CHANNEL_ID,
  ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID,
  STORE_URL: process.env.STORE_URL || "https://wezzy.store",
  STORE_LOGO_URL: process.env.STORE_LOGO_URL || null,
  STORE_BANNER_URL: process.env.STORE_BANNER_URL || null,
  BANNER_FILE: process.env.BANNER_FILE || null,
  GIVEAWAY_CHANNEL_ID: process.env.GIVEAWAY_CHANNEL_ID || null,
  GIVEAWAY_PING_ROLE_ID: process.env.GIVEAWAY_PING_ROLE_ID || null,
  GIVEAWAY_HOUR: parseInt(process.env.GIVEAWAY_HOUR || "18", 10), // local hour 0-23 to start giveaways
  GIVEAWAY_TIMEZONE: process.env.GIVEAWAY_TIMEZONE || "Europe/Berlin",
  GIVEAWAY_DURATION_HOURS: parseInt(process.env.GIVEAWAY_DURATION_HOURS || "24", 10),
  ADMIN_CHANNEL_ID: process.env.ADMIN_CHANNEL_ID || null,
};

// Days the auto-giveaway fires (Mon/Tue/Wed/Thu/Fri/Sat/Sun).
const GIVEAWAY_DAYS = ["Fri"];

// Fail fast with a clear message if something essential is missing.
const required = ["DISCORD_TOKEN", "SELLAUTH_API_KEY", "SELLAUTH_SHOP_ID", "BUYER_ROLE_ID", "RESTOCK_ROLE_ID"];
const missing = required.filter((k) => !CONFIG[k]);
if (missing.length) {
  console.error(`❌ Missing required values in .env: ${missing.join(", ")}`);
  console.error("   Fill them in and restart. See .env.example for the full list.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Persistence: remember which order IDs were already claimed (anti-reuse)
// Stored as a JSON file next to the bot: { "<orderId>": "<discordUserId>" }
// ---------------------------------------------------------------------------
const CLAIMS_FILE = path.join(__dirname, "claimed_orders.json");

function loadClaims() {
  try {
    return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveClaims(claims) {
  try {
    fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims, null, 2));
  } catch (err) {
    console.error("[CLAIMS] Could not save claims file:", err.message);
  }
}

let claimedOrders = loadClaims();

// Simple per-user cooldown to slow down brute-forcing of order IDs (ms).
const VERIFY_COOLDOWN_MS = 15_000;
const lastVerifyAttempt = new Map();

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ---------------------------------------------------------------------------
// SellAuth order verification
// Looks up a single invoice by its ID or unique ID via the official API.
// Optionally cross-checks the Discord ID SellAuth recorded on the order.
// ---------------------------------------------------------------------------
async function verifyOrder(orderId, discordUserId = null, retries = 2) {
  try {
    orderId = String(orderId).replace("#", "").trim();
    if (!orderId) return { success: false, message: "Order ID is required." };

    const url = `https://api.sellauth.com/v1/shops/${CONFIG.SELLAUTH_SHOP_ID}/invoices/${encodeURIComponent(orderId)}`;
    console.log(`[VERIFY] Looking up SellAuth invoice: ${orderId}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CONFIG.SELLAUTH_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    console.log(`[VERIFY] Status: ${response.status}`);

    // Rate limited -> brief wait and retry
    if (response.status === 429 && retries > 0) {
      console.log("[VERIFY] Rate limited — waiting 3s before retry...");
      await new Promise((r) => setTimeout(r, 3000));
      return verifyOrder(orderId, discordUserId, retries - 1);
    }

    if (response.status === 404) {
      return {
        success: false,
        message: "Order not found. Make sure you copied the exact Order ID from your SellAuth confirmation.",
      };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[VERIFY] Error body: ${errorText.substring(0, 300)}`);
      return { success: false, message: "Couldn't reach the store right now. Please try again in a minute." };
    }

    const order = await response.json();

    if (!order || order.success === false || !order.id) {
      return { success: false, message: "Order not found. Double-check your Order ID." };
    }

    const status = String(order.status || "").toLowerCase().trim();
    console.log(`[VERIFY] Invoice ${order.id} status: ${status}`);

    if (!["completed", "paid"].includes(status)) {
      return {
        success: false,
        message: `Order found, but its status is "${status || "unknown"}". It must be completed/paid.`,
      };
    }

    // Stronger check: if SellAuth recorded a Discord ID on the order,
    // it must match the person verifying.
    const orderDiscordId = order.customer?.discord_id || null;
    if (orderDiscordId && discordUserId && String(orderDiscordId) !== String(discordUserId)) {
      return {
        success: false,
        message: "This order is linked to a different Discord account, so it can't be verified here.",
      };
    }

    const productName = order.items?.[0]?.product?.name || "Product";

    return {
      success: true,
      order: {
        id: String(order.id),
        customerEmail: order.email || order.customer?.email || null,
        productName,
        status,
      },
    };
  } catch (error) {
    console.error("[VERIFY] Exception:", error.message);
    return { success: false, message: "Error connecting to the store. Please try again later." };
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
const ADMIN_ONLY = PermissionFlagsBits.Administrator;

const slashCommands = [
  // ---- Top-level: panel + restock (used often, short = better) ----
  new SlashCommandBuilder()
    .setName("setup-panel")
    .setDescription("Post the order verification panel in this channel.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("restock")
    .setDescription("Announce a restock in the announcement channel.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("product").setDescription("Product name").setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName("link").setDescription("Direct product link (optional)").setRequired(false))
    .toJSON(),

  // ---- /giveaway group ----
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Giveaway controls.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("start").setDescription("Start a giveaway now (random prize from pool unless you specify one).")
        .addStringOption((o) => o.setName("prize").setDescription("Override prize name (no auto-DM if used)").setRequired(false))
        .addIntegerOption((o) => o.setName("hours").setDescription("Duration in hours (default 24)").setMinValue(1).setMaxValue(168).setRequired(false))
        .addStringOption((o) =>
          o.setName("ping").setDescription("Ping the giveaway role? (default yes)").setRequired(false)
            .addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" })
        )
    )
    .addSubcommand((s) => s.setName("end").setDescription("End the current active giveaway early."))
    .addSubcommand((s) => s.setName("reroll").setDescription("Pick a new winner for the most recently ended giveaway."))
    .addSubcommand((s) => s.setName("status").setDescription("Show schedule, pool size, and active count."))
    .addSubcommand((s) =>
      s.setName("auto").setDescription("Turn the weekly Friday auto-schedule on or off.")
        .addStringOption((o) =>
          o.setName("state").setDescription("on or off").setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
        )
    )
    .toJSON(),

  // ---- /prize group ----
  new SlashCommandBuilder()
    .setName("prize")
    .setDescription("Manage the giveaway prize pool.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("add").setDescription("Add a prize to the pool (code is private, auto-DM'd to the winner).")
        .addStringOption((o) => o.setName("name").setDescription("Public prize name").setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName("code").setDescription("The code/key/credentials to DM the winner").setRequired(true).setMaxLength(1500))
    )
    .addSubcommand((s) => s.setName("list").setDescription("List prizes in the pool (names only)."))
    .addSubcommand((s) =>
      s.setName("remove").setDescription("Remove a prize by its position number.")
        .addIntegerOption((o) => o.setName("number").setDescription("Position from /prize list").setRequired(true).setMinValue(1))
    )
    .toJSON(),

  // ---- /order group ----
  new SlashCommandBuilder()
    .setName("order")
    .setDescription("Look up and manage SellAuth order claims.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("check").setDescription("Check a SellAuth order ID without granting any roles.")
        .addStringOption((o) => o.setName("order_id").setDescription("Order ID to look up").setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName("whois").setDescription("Show which Discord user claimed a given order.")
        .addStringOption((o) => o.setName("order_id").setDescription("Order ID to look up").setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName("reset").setDescription("Release a claim so an order can be verified again.")
        .addStringOption((o) => o.setName("order_id").setDescription("Order ID to release").setRequired(true))
    )
    .toJSON(),

  // ---- /buyer group ----
  new SlashCommandBuilder()
    .setName("buyer")
    .setDescription("Manage the buyer role manually.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("verify").setDescription("Manually grant a user the buyer role (skip API check).")
        .addUserOption((o) => o.setName("user").setDescription("User to verify").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Why (logged)").setRequired(false))
    )
    .addSubcommand((s) =>
      s.setName("unverify").setDescription("Remove the buyer role from a user.")
        .addUserOption((o) => o.setName("user").setDescription("User to unverify").setRequired(true))
    )
    .toJSON(),

  // ---- Standalone insights ----
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show verification stats (claims, members with role, etc).")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("health")
    .setDescription("Show bot status: uptime, latency, API reachability.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("List all admin commands and what they do.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),
];

async function registerSlashCommands() {
  try {
    await client.application.commands.set(slashCommands);
    console.log(`🔧 Registered ${slashCommands.length} slash commands.`);
  } catch (err) {
    console.error("[SLASH] Failed to register commands:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 wezzy.store verification bot is ready!");
  await registerSlashCommands();
});

// ---------------------------------------------------------------------------
// Interactions (buttons + modal)
// ---------------------------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    // Slash commands
    if (interaction.isChatInputCommand()) {
      // Belt-and-suspenders admin gate (Discord already hides them, but double-check)
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: "🔒 Admins only.",
          flags: MessageFlags.Ephemeral,
        });
      }

      // Slash commands (grouped where it helps; flat where it doesn't)
      const cmd = interaction.commandName;
      const sub = interaction.options.getSubcommand(false);

      switch (cmd) {
        case "setup-panel":
          await interaction.reply({ content: "✅ Panel posted.", flags: MessageFlags.Ephemeral });
          return interaction.channel.send(buildVerificationPanel());

        case "restock":
          return handleRestockCommand(interaction);

        case "stats":
          return handleStatsCommand(interaction);

        case "health":
          return handleHealthCommand(interaction);

        case "help":
          return handleHelpCommand(interaction);

        case "giveaway":
          if (sub === "start") return handleGiveawayStartCommand(interaction);
          if (sub === "end") return handleGiveawayEndCommand(interaction);
          if (sub === "reroll") return handleGiveawayRerollCommand(interaction);
          if (sub === "status") return handleGiveawayStatusCommand(interaction);
          if (sub === "auto") return handleGiveawayAutoCommand(interaction);
          return;

        case "prize":
          if (sub === "add") return handlePrizeAddCommand(interaction);
          if (sub === "list") return handlePrizeListCommand(interaction);
          if (sub === "remove") return handlePrizeRemoveCommand(interaction);
          return;

        case "order":
          if (sub === "check") return handleCheckOrderCommand(interaction);
          if (sub === "whois") return handleWhoisOrderCommand(interaction);
          if (sub === "reset") return handleResetClaimCommand(interaction);
          return;

        case "buyer":
          if (sub === "verify") return handleForceVerifyCommand(interaction);
          if (sub === "unverify") return handleUnverifyCommand(interaction);
          return;
      }
      return;
    }

    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // Open verification modal
    if (interaction.customId === "verify_order") {
      const modal = new ModalBuilder()
        .setCustomId("order_verification_modal")
        .setTitle("Wezzy Order Verification");

      const orderIdInput = new TextInputBuilder()
        .setCustomId("order_id")
        .setLabel("Enter your Wezzy Order ID")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 971 or ba1181294bc7a-0000000000971")
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(50);

      modal.addComponents(new ActionRowBuilder().addComponents(orderIdInput));
      return interaction.showModal(modal);
    }

    // Restock alerts toggle
    if (interaction.customId === "subscribe_restock") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);
      if (!role) {
        return interaction.editReply({ content: "❌ Restock role not found. Ping an admin." });
      }

      const member = interaction.member;
      try {
        if (member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)) {
          await member.roles.remove(role);
          return interaction.editReply({
            content:
              "🔕 **Restock alerts turned OFF.**\n" +
              "You won't be pinged on restocks anymore.\n\n" +
              "_Tap **Restock Alerts** again any time to turn them back on._",
          });
        }
        await member.roles.add(role);
        return interaction.editReply({
          content:
            "🔔 **Restock alerts turned ON.**\n" +
            "You'll get pinged whenever a product drops back in stock.\n\n" +
            "_Tap **Restock Alerts** again any time to turn them off._",
        });
      } catch (err) {
        console.error("[RESTOCK] Role toggle failed:", err.message);
        return interaction.editReply({
          content:
            "❌ I couldn't change your role. My role may be **below** the restock role — ask an admin to move it up.",
        });
      }
    }

    // Process verification modal
    if (interaction.customId === "order_verification_modal") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Cooldown to slow down guessing
      const now = Date.now();
      const last = lastVerifyAttempt.get(interaction.user.id) || 0;
      if (now - last < VERIFY_COOLDOWN_MS) {
        const wait = Math.ceil((VERIFY_COOLDOWN_MS - (now - last)) / 1000);
        return interaction.editReply({ content: `⏳ Please wait ${wait}s before trying again.` });
      }
      lastVerifyAttempt.set(interaction.user.id, now);

      const orderId = interaction.fields.getTextInputValue("order_id").replace("#", "").trim();
      const result = await verifyOrder(orderId, interaction.user.id);

      if (!result.success) {
        const errorEmbed = new EmbedBuilder()
          .setColor("#2f3136")
          .setTitle("Verification unsuccessful")
          .setDescription(`> ${result.message}`)
          .addFields(
            { name: "Order ID", value: `\`${orderId || "—"}\``, inline: true },
            { name: "Result", value: "🔴 Not verified", inline: true }
          )
          .setFooter({
            text: "Wezzy · Verification",
            iconURL: CONFIG.STORE_LOGO_URL || undefined,
          })
          .setTimestamp();
        console.log(`❌ Failed verification for ${interaction.user.tag} (${orderId})`);
        return interaction.editReply({ embeds: [errorEmbed] });
      }

      // Anti-reuse: has this order already been claimed by someone else?
      const claimedBy = claimedOrders[result.order.id];
      if (claimedBy && claimedBy !== interaction.user.id) {
        console.log(`⚠️ Order ${orderId} already claimed by ${claimedBy}, blocked ${interaction.user.id}`);
        return interaction.editReply({
          content:
            "❌ This order has already been used to verify a different account. Each order can only be claimed once.",
        });
      }

      const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);
      if (!role) {
        return interaction.editReply({ content: "❌ Buyer role not found. Ping an admin." });
      }

      const member = interaction.member;
      if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
        // Make sure their order is recorded even if they already had the role
        claimedOrders[result.order.id] = interaction.user.id;
        saveClaims(claimedOrders);
        return interaction.editReply({ content: "✅ You already have the buyer role!" });
      }

      try {
        await member.roles.add(role);
      } catch (err) {
        console.error("[VERIFY] Could not add buyer role:", err.message);
        return interaction.editReply({
          content:
            "❌ I verified your order but couldn't give the role. My role may be **below** the buyer role — ask an admin to move it up.",
        });
      }

      // Record the claim so the same order can't be reused
      claimedOrders[result.order.id] = interaction.user.id;
      saveClaims(claimedOrders);

      const successEmbed = new EmbedBuilder()
        .setColor("#2f3136")
        .setTitle("Verification successful")
        .setDescription(
          `> Welcome to **Wezzy**. Your purchase has been confirmed and your access is now active.`
        )
        .addFields(
          { name: "Order ID", value: `\`${result.order.id}\``, inline: true },
          { name: "Status", value: "🟢 " + result.order.status.toUpperCase(), inline: true },
          { name: "Role granted", value: `<@&${role.id}>`, inline: false }
        )
        .setFooter({
          text: "Wezzy · Verification",
          iconURL: CONFIG.STORE_LOGO_URL || undefined,
        })
        .setTimestamp();

      console.log(`✅ Verified ${interaction.user.tag} with order ${result.order.id}`);
      return interaction.editReply({ embeds: [successEmbed] });
    }
  } catch (err) {
    console.error("[INTERACTION] Unhandled error:", err);
    // Best-effort reply so the user isn't left hanging
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ Something went wrong. Please try again." });
      } else if (interaction.isRepliable()) {
        await interaction.reply({ content: "❌ Something went wrong. Please try again.", flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Embed + components builders (shared by slash + legacy text commands)
// ---------------------------------------------------------------------------
function buildVerificationPanel() {
  const embed = new EmbedBuilder()
    .setColor("#2f3136")
    .setTitle("Order Verification")
    .setDescription(
      "Confirm your **Wezzy** purchase to unlock buyer-only channels and product updates."
    )
    .addFields(
      {
        name: "How it works",
        value:
          "`1.` Press **Verify Order** below.\n" +
          "`2.` Paste your Wezzy Order ID.\n" +
          "`3.` Your buyer role is granted automatically.",
        inline: false,
      },
      {
        name: "Finding your Order ID",
        value:
          "• Your purchase confirmation email\n" +
          "• Or your order page on **wezzy.store**\n" +
          "• Copy the Order / Invoice ID exactly",
        inline: false,
      },
      {
        name: "Extras",
        value:
          "Tap **Restock Alerts** to be pinged whenever something drops back in stock.",
        inline: false,
      }
    )
    .setFooter({
      text: "Wezzy · Verification",
      iconURL: CONFIG.STORE_LOGO_URL || undefined,
    });

  if (CONFIG.STORE_LOGO_URL) embed.setThumbnail(CONFIG.STORE_LOGO_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_order").setLabel("Verify Order").setStyle(ButtonStyle.Secondary).setEmoji("🔑"),
    new ButtonBuilder().setCustomId("subscribe_restock").setLabel("Restock Alerts").setStyle(ButtonStyle.Secondary).setEmoji("🔔"),
    new ButtonBuilder().setLabel("Visit store").setStyle(ButtonStyle.Link).setEmoji("🛍️").setURL(CONFIG.STORE_URL)
  );

  return { embeds: [embed], components: [row] };
}

function buildRestockMessage(product, link) {
  const buyUrl = link && link.startsWith("http") ? link : CONFIG.STORE_URL;

  const embed = new EmbedBuilder()
    .setColor("#2f3136")
    .setTitle("Restock")
    .setDescription(
      `### ${product}\n` +
        `Available now at **Wezzy** — limited quantity, first come, first served.`
    )
    .addFields(
      { name: "Status", value: "🟢 In stock", inline: true },
      { name: "Where", value: `[wezzy.store](${CONFIG.STORE_URL})`, inline: true }
    )
    .setFooter({
      text: "Wezzy · Restock notice",
      iconURL: CONFIG.STORE_LOGO_URL || undefined,
    })
    .setTimestamp();

  if (CONFIG.STORE_LOGO_URL) embed.setThumbnail(CONFIG.STORE_LOGO_URL);

  const buttons = [
    new ButtonBuilder().setLabel("Get it now").setEmoji("🛒").setStyle(ButtonStyle.Link).setURL(buyUrl),
  ];
  if (buyUrl !== CONFIG.STORE_URL) {
    buttons.push(
      new ButtonBuilder().setLabel("Browse store").setEmoji("🛍️").setStyle(ButtonStyle.Link).setURL(CONFIG.STORE_URL)
    );
  }
  const buttonRow = new ActionRowBuilder().addComponents(...buttons);

  return {
    content: `<@&${CONFIG.RESTOCK_ROLE_ID}>`,
    embeds: [embed],
    components: [buttonRow],
    allowedMentions: { parse: ["roles"] },
  };
}

// ---------------------------------------------------------------------------
// Admin slash command handlers
// ---------------------------------------------------------------------------
const BOT_STARTED_AT = Date.now();

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${sec}s`].filter(Boolean).join(" ");
}

function adminEmbed(title) {
  return new EmbedBuilder()
    .setColor("#2f3136")
    .setTitle(title)
    .setFooter({ text: "Wezzy · Admin", iconURL: CONFIG.STORE_LOGO_URL || undefined })
    .setTimestamp();
}

async function handleRestockCommand(interaction) {
  const product = interaction.options.getString("product", true).trim();
  const link = (interaction.options.getString("link") || "").trim();

  const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);
  if (!role) {
    return interaction.reply({
      content: "❌ Restock role not found. Check `RESTOCK_ROLE_ID` in `.env`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const channel = CONFIG.ANNOUNCEMENT_CHANNEL_ID
    ? interaction.guild.channels.cache.get(CONFIG.ANNOUNCEMENT_CHANNEL_ID)
    : interaction.channel;

  if (!channel) {
    return interaction.reply({
      content: "❌ Announcement channel not found. Check `ANNOUNCEMENT_CHANNEL_ID` in `.env`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await channel.send(buildRestockMessage(product, link));
  return interaction.reply({
    content: `✅ Restock posted in <#${channel.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatsCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const totalClaims = Object.keys(claimedOrders).length;
  const uniqueUsers = new Set(Object.values(claimedOrders)).size;

  let buyerCount = "—";
  let restockCount = "—";
  try {
    await interaction.guild.members.fetch();
    buyerCount = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID)?.members.size ?? "—";
    restockCount = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID)?.members.size ?? "—";
  } catch {}

  const embed = adminEmbed("📊 Stats")
    .addFields(
      { name: "Verified orders", value: `\`${totalClaims}\``, inline: true },
      { name: "Unique buyers", value: `\`${uniqueUsers}\``, inline: true },
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "Buyer role members", value: `\`${buyerCount}\``, inline: true },
      { name: "Restock subscribers", value: `\`${restockCount}\``, inline: true },
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "Uptime", value: `\`${fmtUptime(Date.now() - BOT_STARTED_AT)}\``, inline: true },
      { name: "Guild members", value: `\`${interaction.guild.memberCount}\``, inline: true }
    );

  return interaction.editReply({ embeds: [embed] });
}

async function handleCheckOrderCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const orderId = interaction.options.getString("order_id", true).trim();
  const result = await verifyOrder(orderId);

  const embed = adminEmbed("🔎 Order check").addFields({
    name: "Order ID",
    value: `\`${orderId}\``,
    inline: false,
  });

  if (result.success) {
    embed.addFields(
      { name: "Result", value: "🟢 Valid", inline: true },
      { name: "Status", value: result.order.status.toUpperCase(), inline: true },
      { name: "Product", value: result.order.productName || "—", inline: false }
    );
    if (result.order.customerEmail) {
      embed.addFields({ name: "Customer email", value: `\`${result.order.customerEmail}\``, inline: false });
    }
    const claimedBy = claimedOrders[result.order.id];
    embed.addFields({
      name: "Claimed by",
      value: claimedBy ? `<@${claimedBy}>` : "_unclaimed_",
      inline: false,
    });
  } else {
    embed.addFields(
      { name: "Result", value: "🔴 Invalid", inline: true },
      { name: "Reason", value: result.message, inline: false }
    );
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleWhoisOrderCommand(interaction) {
  const orderId = interaction.options.getString("order_id", true).trim();
  const claimedBy = claimedOrders[orderId];
  const embed = adminEmbed("👤 Whois order").addFields(
    { name: "Order ID", value: `\`${orderId}\``, inline: false },
    {
      name: "Claimed by",
      value: claimedBy ? `<@${claimedBy}> (\`${claimedBy}\`)` : "_unclaimed_",
      inline: false,
    }
  );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleResetClaimCommand(interaction) {
  const orderId = interaction.options.getString("order_id", true).trim();
  if (!claimedOrders[orderId]) {
    return interaction.reply({
      content: `ℹ️ No claim found for \`${orderId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const previous = claimedOrders[orderId];
  delete claimedOrders[orderId];
  saveClaims(claimedOrders);
  console.log(`[ADMIN] ${interaction.user.tag} reset claim ${orderId} (was <@${previous}>)`);
  return interaction.reply({
    content: `✅ Claim released for \`${orderId}\` (previously <@${previous}>). The order can now be re-verified by anyone.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleForceVerifyCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason") || "no reason given";

  const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);
  if (!role) return interaction.editReply({ content: "❌ Buyer role not found." });

  let member;
  try {
    member = await interaction.guild.members.fetch(user.id);
  } catch {
    return interaction.editReply({ content: "❌ That user isn't in this server." });
  }

  if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
    return interaction.editReply({ content: `ℹ️ ${user} already has the buyer role.` });
  }

  try {
    await member.roles.add(role, `Force-verified by ${interaction.user.tag} — ${reason}`);
  } catch (err) {
    console.error("[ADMIN] Force-verify role-add failed:", err.message);
    return interaction.editReply({
      content: "❌ Couldn't add the role. My role may be **below** the buyer role.",
    });
  }

  console.log(`[ADMIN] ${interaction.user.tag} force-verified ${user.tag} (reason: ${reason})`);
  return interaction.editReply({ content: `✅ ${user} has been given the buyer role.` });
}

async function handleUnverifyCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser("user", true);

  const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);
  if (!role) return interaction.editReply({ content: "❌ Buyer role not found." });

  let member;
  try {
    member = await interaction.guild.members.fetch(user.id);
  } catch {
    return interaction.editReply({ content: "❌ That user isn't in this server." });
  }

  if (!member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
    return interaction.editReply({ content: `ℹ️ ${user} doesn't have the buyer role.` });
  }

  try {
    await member.roles.remove(role, `Unverified by ${interaction.user.tag}`);
  } catch (err) {
    console.error("[ADMIN] Unverify role-remove failed:", err.message);
    return interaction.editReply({
      content: "❌ Couldn't remove the role. My role may be **below** the buyer role.",
    });
  }

  console.log(`[ADMIN] ${interaction.user.tag} unverified ${user.tag}`);
  return interaction.editReply({ content: `✅ Removed buyer role from ${user}.` });
}

async function handleHealthCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Quick SellAuth ping with a guaranteed-bogus ID — we just want a status code back
  let sellauthStatus = "❓ unknown";
  try {
    const res = await fetch(
      `https://api.sellauth.com/v1/shops/${CONFIG.SELLAUTH_SHOP_ID}/invoices/healthcheck-bogus-id`,
      { headers: { Authorization: `Bearer ${CONFIG.SELLAUTH_API_KEY}`, Accept: "application/json" } }
    );
    // 404 is fine — it means we reached SellAuth and authed correctly
    if (res.status === 404 || res.ok) sellauthStatus = "🟢 reachable";
    else if (res.status === 401 || res.status === 403) sellauthStatus = "🔴 auth failed (check API key)";
    else sellauthStatus = `🟡 unexpected ${res.status}`;
  } catch {
    sellauthStatus = "🔴 unreachable";
  }

  const embed = adminEmbed("💚 Health").addFields(
    { name: "Discord gateway", value: `🟢 connected (\`${client.ws.ping}ms\`)`, inline: true },
    { name: "Uptime", value: `\`${fmtUptime(Date.now() - BOT_STARTED_AT)}\``, inline: true },
    { name: "\u200B", value: "\u200B", inline: true },
    { name: "SellAuth API", value: sellauthStatus, inline: true },
    { name: "Memory", value: `\`${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\``, inline: true },
    { name: "Node", value: `\`${process.version}\``, inline: true },
    { name: "Claims stored", value: `\`${Object.keys(claimedOrders).length}\``, inline: false }
  );

  return interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand(interaction) {
  const embed = adminEmbed("🛠️ Admin Commands").setDescription(
    "Everything below is **admin-only**. Replies are private unless they post in a channel."
  ).addFields(
    {
      name: "📢 Customer-facing",
      value:
        "`/setup-panel` — post the verification panel here.\n" +
        "`/restock product link` — announce a restock & ping subscribers.",
      inline: false,
    },
    {
      name: "📊 Insights",
      value:
        "`/stats` — verified orders, unique buyers, role counts, uptime.\n" +
        "`/health` — gateway latency, SellAuth API status, memory, Node.",
      inline: false,
    },
    {
      name: "🧾 `/order` — order lookup & claims",
      value:
        "`/order check order_id` — look up an order without granting anything.\n" +
        "`/order whois order_id` — which Discord user claimed it.\n" +
        "`/order reset order_id` — release a claim (e.g. refund / dispute).",
      inline: false,
    },
    {
      name: "🧑‍💼 `/buyer` — manual role management",
      value:
        "`/buyer verify user reason` — manually grant the buyer role.\n" +
        "`/buyer unverify user` — remove the buyer role.",
      inline: false,
    },
    {
      name: "🎁 `/prize` — manage the prize pool",
      value:
        "`/prize add name code` — add a prize (code is private, auto-DM'd to winner).\n" +
        "`/prize list` — list prizes (names only).\n" +
        "`/prize remove number` — remove a prize by its list position.",
      inline: false,
    },
    {
      name: "🎉 `/giveaway` — run giveaways",
      value:
        "`/giveaway status` — schedule, pool size, active count.\n" +
        "`/giveaway start [prize] [hours] [ping]` — fire one now.\n" +
        "`/giveaway end` — end the current one early.\n" +
        "`/giveaway reroll` — pick a new winner for the last one.\n" +
        "`/giveaway auto on|off` — toggle the weekly Friday auto-schedule.",
      inline: false,
    }
  );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ===========================================================================
// GIVEAWAY SYSTEM
// 3 giveaways per week (Mon/Wed/Fri at GIVEAWAY_HOUR local time), 24h duration,
// 1 winner each, prize randomly picked from a configurable list, anyone enters.
// ===========================================================================

// ---- Storage --------------------------------------------------------------
const GIVEAWAY_DATA_FILE = path.join(__dirname, "giveaway_data.json");

function loadGiveawayData() {
  try {
    const data = JSON.parse(fs.readFileSync(GIVEAWAY_DATA_FILE, "utf8"));
    if (!Array.isArray(data.prizes)) data.prizes = [];
    if (!Array.isArray(data.active)) data.active = [];
    if (!Array.isArray(data.history)) data.history = [];
    if (typeof data.autoEnabled !== "boolean") data.autoEnabled = true;
    if (typeof data.pingOnStart !== "boolean") data.pingOnStart = true;
    // Back-compat: convert any plain-string prizes to objects (no code attached)
    data.prizes = data.prizes.map((p) =>
      typeof p === "string" ? { name: p, code: null, addedBy: null, addedAt: Date.now() } : p
    );
    return data;
  } catch {
    return { prizes: [], active: [], history: [], autoEnabled: true, pingOnStart: true };
  }
}

function saveGiveawayData() {
  try {
    fs.writeFileSync(GIVEAWAY_DATA_FILE, JSON.stringify(giveawayData, null, 2));
  } catch (err) {
    console.error("[GIVEAWAY] Could not save data file:", err.message);
  }
}

let giveawayData = loadGiveawayData();

// ---- Helpers --------------------------------------------------------------
function consumeRandomPrize() {
  const pool = giveawayData.prizes;
  if (!pool.length) return null;
  const idx = Math.floor(Math.random() * pool.length);
  const [prize] = pool.splice(idx, 1);
  saveGiveawayData();
  return prize;
}

function fmtRelative(ts) {
  return `<t:${Math.floor(ts / 1000)}:R>`;
}
function fmtAbsolute(ts) {
  return `<t:${Math.floor(ts / 1000)}:f>`;
}

function buildGiveawayEmbed(g, { ended = false, winner = null } = {}) {
  const endsLine = ended
    ? `Ended ${fmtRelative(g.endsAt)}`
    : `Ends ${fmtRelative(g.endsAt)} · ${fmtAbsolute(g.endsAt)}`;

  const desc = ended
    ? `### 🎁 ${g.prize}\n\n${endsLine}`
    : `### 🎁 ${g.prize}\n\n` +
      `React with 🎉 to enter.\n` +
      `**1 winner** will be drawn ${fmtRelative(g.endsAt)} and the prize will be DM'd automatically.\n\n` +
      `${endsLine}`;

  const winnersField = ended
    ? (winner ? `<@${winner}>` : "_no entries_")
    : "`1`";

  const embed = new EmbedBuilder()
    .setColor("#2f3136")
    .setTitle(ended ? "Giveaway · Ended" : "Giveaway · Live")
    .setDescription(desc)
    .addFields(
      { name: "Hosted by", value: `<@${client.user.id}>`, inline: true },
      { name: "Entries", value: `\`${g.entryCount ?? 0}\``, inline: true },
      { name: ended ? "Winner" : "Winners", value: winnersField, inline: true }
    )
    .setFooter({ text: "Wezzy · Giveaway", iconURL: CONFIG.STORE_LOGO_URL || undefined })
    .setTimestamp(g.startedAt);

  if (CONFIG.STORE_LOGO_URL) embed.setThumbnail(CONFIG.STORE_LOGO_URL);
  return embed;
}

function giveawayChannelFor(guild) {
  if (CONFIG.GIVEAWAY_CHANNEL_ID) return guild.channels.cache.get(CONFIG.GIVEAWAY_CHANNEL_ID);
  return null;
}

// ---- Start / end ----------------------------------------------------------
async function startGiveaway(guild, { prize, durationMs, ping = true } = {}) {
  const channel = giveawayChannelFor(guild);
  if (!channel) throw new Error("Giveaway channel not configured (GIVEAWAY_CHANNEL_ID).");

  // Either a forced prize (object or string), or consume one from the pool
  let prizeObj = null;
  if (prize && typeof prize === "object") {
    prizeObj = prize;
  } else if (typeof prize === "string" && prize.trim()) {
    prizeObj = { name: prize.trim(), code: null, addedBy: null, addedAt: Date.now() };
  } else {
    prizeObj = consumeRandomPrize();
  }
  if (!prizeObj) throw new Error("No prizes in the pool. Add some with `/prize-add`.");

  const startedAt = Date.now();
  const duration = durationMs || CONFIG.GIVEAWAY_DURATION_HOURS * 3600 * 1000;
  const endsAt = startedAt + duration;

  const g = {
    id: `g_${startedAt}`,
    guildId: guild.id,
    channelId: channel.id,
    messageId: null,
    prize: prizeObj.name,
    prizeCode: prizeObj.code || null, // private — never shown publicly
    hostId: client.user.id,
    startedAt,
    endsAt,
    entryCount: 0,
    ended: false,
  };

  const content = ping && CONFIG.GIVEAWAY_PING_ROLE_ID
    ? `<@&${CONFIG.GIVEAWAY_PING_ROLE_ID}>`
    : null;

  const msg = await channel.send({
    content: content || undefined,
    embeds: [buildGiveawayEmbed(g)],
    allowedMentions: content ? { parse: ["roles"] } : { parse: [] },
  });

  await msg.react("🎉").catch(() => {});
  g.messageId = msg.id;

  giveawayData.active.push(g);
  saveGiveawayData();

  console.log(`🎉 Started giveaway ${g.id} · prize: ${g.prize} (code: ${g.prizeCode ? "yes" : "no"}) · ends ${new Date(g.endsAt).toISOString()}`);
  return g;
}

async function endGiveaway(g, { reason = "scheduled" } = {}) {
  if (g.ended) return null;
  const guild = client.guilds.cache.get(g.guildId);
  if (!guild) {
    g.ended = true;
    saveGiveawayData();
    return null;
  }
  const channel = guild.channels.cache.get(g.channelId);
  if (!channel) {
    g.ended = true;
    saveGiveawayData();
    return null;
  }

  let msg = null;
  try {
    msg = await channel.messages.fetch(g.messageId);
  } catch {
    g.ended = true;
    saveGiveawayData();
    return null;
  }

  // Pull reactions and pick a winner
  const reaction = msg.reactions.cache.get("🎉");
  let users = [];
  if (reaction) {
    const fetched = await reaction.users.fetch().catch(() => null);
    if (fetched) users = [...fetched.values()].filter((u) => !u.bot);
  }
  g.entryCount = users.length;

  let winner = null;
  if (users.length > 0) winner = users[Math.floor(Math.random() * users.length)].id;

  g.ended = true;
  g.endedAt = Date.now();
  g.winnerId = winner;
  g.endReason = reason;

  // Move from active -> history
  giveawayData.active = giveawayData.active.filter((x) => x.id !== g.id);
  giveawayData.history.unshift(g);
  giveawayData.history = giveawayData.history.slice(0, 50); // keep last 50

  // Attempt automatic prize delivery via DM
  let deliveryStatus = "none"; // none | dmed | dm-failed | no-code
  if (winner) {
    try {
      const winnerUser = await client.users.fetch(winner);
      if (g.prizeCode) {
        const dmEmbed = new EmbedBuilder()
          .setColor("#2f3136")
          .setTitle("🎉 You won the Wezzy giveaway!")
          .setDescription(
            `Congrats — you won the **${g.prize}** giveaway.\n\n` +
              `Your prize is below. Keep it safe — it's only sent once.`
          )
          .addFields({ name: "Prize", value: g.prize, inline: false }, { name: "Your code / details", value: "```\n" + g.prizeCode + "\n```", inline: false })
          .setFooter({ text: "Wezzy · Giveaway", iconURL: CONFIG.STORE_LOGO_URL || undefined })
          .setTimestamp();
        await winnerUser.send({ embeds: [dmEmbed] });
        deliveryStatus = "dmed";
        g.deliveredAt = Date.now();
      } else {
        deliveryStatus = "no-code";
      }
    } catch (err) {
      console.warn(`[GIVEAWAY] DM to winner ${winner} failed:`, err.message);
      deliveryStatus = "dm-failed";
    }
  }
  g.deliveryStatus = deliveryStatus;
  saveGiveawayData();

  // Update the original message (no more buttons, no more reaction needed)
  await msg.edit({
    content: winner ? `🎉 Congratulations <@${winner}>!` : "Giveaway ended.",
    embeds: [buildGiveawayEmbed(g, { ended: true, winner })],
    components: [],
    allowedMentions: { users: winner ? [winner] : [] },
  }).catch(() => {});

  // Standalone result post — tone depends on whether delivery succeeded
  if (winner) {
    let followUp;
    if (deliveryStatus === "dmed") {
      followUp = `🎉 <@${winner}> won the **${g.prize}** giveaway! Check your DMs — your prize is on the way.`;
    } else if (deliveryStatus === "dm-failed") {
      followUp =
        `🎉 <@${winner}> won the **${g.prize}** giveaway!\n` +
        `⚠️ I couldn't DM you — your DMs may be closed. Please open DMs from this server, then ping a moderator to claim.`;
    } else {
      // no-code (manual prize)
      followUp = `🎉 <@${winner}> won the **${g.prize}** giveaway! A moderator will reach out shortly.`;
    }
    await channel.send({
      content: followUp,
      allowedMentions: { users: [winner] },
    }).catch(() => {});

    // Heads-up for admins if delivery failed
    if (deliveryStatus === "dm-failed") {
      const adminChannelId = CONFIG.ADMIN_CHANNEL_ID || CONFIG.ANNOUNCEMENT_CHANNEL_ID;
      if (adminChannelId) {
        const adminChannel = guild.channels.cache.get(adminChannelId);
        if (adminChannel) {
          await adminChannel.send({
            content: `⚠️ Giveaway prize couldn't be DM'd to <@${winner}> (DMs closed). Please deliver **${g.prize}** manually.`,
            allowedMentions: { users: [] },
          }).catch(() => {});
        }
      }
    }
  } else {
    await channel.send({
      content: `Giveaway for **${g.prize}** ended with no valid entries.`,
    }).catch(() => {});
  }

  console.log(`🏁 Ended giveaway ${g.id} · winner: ${winner || "none"} · delivery: ${deliveryStatus} (${reason})`);
  return { winner, entries: g.entryCount, deliveryStatus };
}

// ---- Auto-scheduler -------------------------------------------------------
// Runs once a minute. Starts a giveaway when local time hits the configured
// hour on Mon / Wed / Fri (once per day). Also auto-ends giveaways past endsAt.
let lastAutoStartKey = null; // de-dupe so we only fire once per slot

function localPartsNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.GIVEAWAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday, // Mon, Tue, ...
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    key: `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`,
  };
}

async function giveawayTick() {
  // 1) Auto-end any active giveaway whose time is up
  for (const g of [...giveawayData.active]) {
    if (Date.now() >= g.endsAt) {
      try {
        await endGiveaway(g, { reason: "scheduled" });
      } catch (err) {
        console.error("[GIVEAWAY] auto-end failed:", err.message);
      }
    }
  }

  // 2) Auto-start on Mon/Wed/Fri at configured hour
  if (!giveawayData.autoEnabled) return;
  if (!CONFIG.GIVEAWAY_CHANNEL_ID) return;

  const { weekday, hour, key } = localPartsNow();
  if (!GIVEAWAY_DAYS.includes(weekday)) return;
  if (hour !== CONFIG.GIVEAWAY_HOUR) return;
  if (lastAutoStartKey === key) return; // already fired this slot

  lastAutoStartKey = key;

  const guild = client.guilds.cache.first();
  if (!guild) return;

  if (!giveawayData.prizes.length) {
    console.warn("[GIVEAWAY] Auto-start skipped: no prizes in pool.");
    return;
  }

  try {
    await startGiveaway(guild, { ping: giveawayData.pingOnStart });
    console.log(`[GIVEAWAY] Auto-started for ${weekday} ${hour}:00 ${CONFIG.GIVEAWAY_TIMEZONE}`);
  } catch (err) {
    console.error("[GIVEAWAY] Auto-start failed:", err.message);
  }
}

// On boot: resume any active giveaways. If a giveaway's end time passed while
// the bot was down, end it now.
async function resumeGiveawaysOnBoot() {
  for (const g of [...giveawayData.active]) {
    if (Date.now() >= g.endsAt) {
      try { await endGiveaway(g, { reason: "resumed-and-ended" }); } catch {}
    }
  }
}

client.once("ready", async () => {
  await resumeGiveawaysOnBoot();
  setInterval(() => { giveawayTick().catch(() => {}); }, 60_000);
});

// ---- Slash command handlers ----------------------------------------------
async function handleGiveawayStartCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const customPrize = interaction.options.getString("prize");
  const customHours = interaction.options.getInteger("hours");
  const pingChoice = interaction.options.getString("ping"); // "yes" | "no" | null
  const ping = pingChoice ? pingChoice === "yes" : giveawayData.pingOnStart;

  try {
    const g = await startGiveaway(interaction.guild, {
      prize: customPrize || undefined,
      durationMs: customHours ? customHours * 3600 * 1000 : undefined,
      ping,
    });
    const note = customPrize ? "\n_Note: custom prize had no code — winner won't be auto-DM'd._" : "";
    return interaction.editReply({
      content: `✅ Started giveaway in <#${g.channelId}> for **${g.prize}**. Ends <t:${Math.floor(g.endsAt/1000)}:R>.${note}`,
    });
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }
}

async function handleGiveawayEndCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!giveawayData.active.length) {
    return interaction.editReply({ content: "ℹ️ No active giveaway to end." });
  }
  const g = giveawayData.active[giveawayData.active.length - 1]; // most recent
  const result = await endGiveaway(g, { reason: "manual" });
  if (!result) return interaction.editReply({ content: "❌ Could not end the giveaway (message not found?)." });
  return interaction.editReply({
    content: result.winner
      ? `🏁 Ended early. Winner: <@${result.winner}> · ${result.entries} entries.`
      : `🏁 Ended early with no entries.`,
  });
}

async function handleGiveawayRerollCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const last = giveawayData.history[0];
  if (!last) return interaction.editReply({ content: "ℹ️ No past giveaways to reroll." });

  const guild = interaction.guild;
  const channel = guild.channels.cache.get(last.channelId);
  if (!channel) return interaction.editReply({ content: "❌ Original channel not found." });

  let msg;
  try { msg = await channel.messages.fetch(last.messageId); }
  catch { return interaction.editReply({ content: "❌ Original giveaway message not found." }); }

  const reaction = msg.reactions.cache.get("🎉");
  let users = [];
  if (reaction) {
    const fetched = await reaction.users.fetch().catch(() => null);
    if (fetched) users = [...fetched.values()].filter((u) => !u.bot && u.id !== last.winnerId);
  }
  if (!users.length) return interaction.editReply({ content: "ℹ️ No other entrants to reroll from." });

  const newWinner = users[Math.floor(Math.random() * users.length)];
  await channel.send({
    content: `🔁 Reroll: <@${newWinner.id}> won the **${last.prize}** giveaway! DM <@${last.hostId}> to claim your prize.`,
    allowedMentions: { users: [newWinner.id, last.hostId] },
  });
  return interaction.editReply({ content: `✅ Rerolled. New winner: <@${newWinner.id}>.` });
}

async function handlePrizeAddCommand(interaction) {
  const name = interaction.options.getString("name", true).trim();
  const code = interaction.options.getString("code", true).trim();
  giveawayData.prizes.push({
    name,
    code,
    addedBy: interaction.user.id,
    addedAt: Date.now(),
  });
  saveGiveawayData();
  console.log(`[GIVEAWAY] ${interaction.user.tag} added prize "${name}" (pool size: ${giveawayData.prizes.length})`);
  return interaction.reply({
    content: `✅ Added **${name}** to the prize pool. (Pool size: \`${giveawayData.prizes.length}\`)\n_The code is stored privately and will be DM'd to the winner._`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePrizeListCommand(interaction) {
  const list = giveawayData.prizes;
  const embed = adminEmbed("🎁 Prize pool").setDescription(
    list.length
      ? list.map((p, i) => `\`${i + 1}.\` **${p.name}** _(added <t:${Math.floor((p.addedAt || Date.now()) / 1000)}:R>)_`).join("\n")
      : "_Empty — add some with_ `/prize-add name:<...> code:<...>`"
  );
  embed.setFooter({ text: `Codes are private and never shown. Total: ${list.length}` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handlePrizeRemoveCommand(interaction) {
  const n = interaction.options.getInteger("number", true);
  if (n < 1 || n > giveawayData.prizes.length) {
    return interaction.reply({
      content: `❌ No prize at position \`${n}\`. Use \`/prize-list\` to see valid numbers.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const [removed] = giveawayData.prizes.splice(n - 1, 1);
  saveGiveawayData();
  console.log(`[GIVEAWAY] ${interaction.user.tag} removed prize "${removed.name}"`);
  return interaction.reply({
    content: `✅ Removed **${removed.name}**. (Pool size: \`${giveawayData.prizes.length}\`)`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleGiveawayStatusCommand(interaction) {
  const lines = [];
  lines.push(`**Auto-schedule:** ${giveawayData.autoEnabled ? "🟢 ON" : "🔴 OFF"}`);
  lines.push(`**Channel:** ${CONFIG.GIVEAWAY_CHANNEL_ID ? `<#${CONFIG.GIVEAWAY_CHANNEL_ID}>` : "_not set_"}`);
  lines.push(`**Schedule:** ${GIVEAWAY_DAYS.join(" / ") || "_none_"} at ${String(CONFIG.GIVEAWAY_HOUR).padStart(2, "0")}:00 ${CONFIG.GIVEAWAY_TIMEZONE}`);
  lines.push(`**Duration:** ${CONFIG.GIVEAWAY_DURATION_HOURS}h · **Winners:** 1`);
  lines.push(`**Prizes in pool:** ${giveawayData.prizes.length}`);
  lines.push(`**Active right now:** ${giveawayData.active.length}`);
  lines.push(`**Past giveaways stored:** ${giveawayData.history.length}`);

  const embed = adminEmbed("🎉 Giveaway status").setDescription(lines.join("\n"));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleGiveawayAutoCommand(interaction) {
  const state = interaction.options.getString("state", true);
  giveawayData.autoEnabled = state === "on";
  saveGiveawayData();
  return interaction.reply({
    content: giveawayData.autoEnabled
      ? `🟢 Automatic giveaways **enabled**. They'll fire ${GIVEAWAY_DAYS.join(" / ")} at ${String(CONFIG.GIVEAWAY_HOUR).padStart(2, "0")}:00 ${CONFIG.GIVEAWAY_TIMEZONE}.`
      : "🔴 Automatic giveaways **disabled**. You can still run `/giveaway-start` manually.",
    flags: MessageFlags.Ephemeral,
  });
}

// ---- Entry tracking via reaction add/remove -------------------------------
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.emoji.name !== "🎉") return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    const g = giveawayData.active.find((x) => x.messageId === reaction.message.id);
    if (!g) return;
    g.entryCount = (g.entryCount || 0) + 1;
    saveGiveawayData();
  } catch {}
});

client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.emoji.name !== "🎉") return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    const g = giveawayData.active.find((x) => x.messageId === reaction.message.id);
    if (!g) return;
    g.entryCount = Math.max(0, (g.entryCount || 0) - 1);
    saveGiveawayData();
  } catch {}
});

// ---------------------------------------------------------------------------
// Legacy text command (!setup-panel) – kept as a fallback
// ---------------------------------------------------------------------------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || !message.member || message.author.bot) return;
    const isAdmin = message.member.permissions.has("Administrator");

    if (message.content === "!setup-panel" && isAdmin) {
      await message.channel.send(buildVerificationPanel());
      return message.delete().catch(() => {});
    }
  } catch (err) {
    console.error("[MESSAGE] Unhandled error:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Safety nets so a stray error never kills the process silently
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => console.error("[UNHANDLED REJECTION]", reason));
process.on("uncaughtException", (err) => console.error("[UNCAUGHT EXCEPTION]", err));

client.login(CONFIG.DISCORD_TOKEN).catch((err) => {
  console.error("❌ Failed to log in. Check your DISCORD_TOKEN in .env. Details:", err.message);
  process.exit(1);
});
