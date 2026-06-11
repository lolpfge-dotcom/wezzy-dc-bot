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
};

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
  ],
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
  // ---- Public-facing actions (admin uses them, output is public) ----
  new SlashCommandBuilder()
    .setName("restock")
    .setDescription("Announce a restock in the announcement channel.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("product").setDescription("Product name").setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName("link").setDescription("Direct product link (optional)").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("setup-panel")
    .setDescription("Post the order verification panel in this channel.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),

  // ---- Admin tools ----
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show verification stats (claims, members with role, etc).")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("check-order")
    .setDescription("Check a SellAuth order ID without granting any roles.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("order_id").setDescription("Order ID to look up").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("whois-order")
    .setDescription("Show which Discord user claimed a given order ID.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("order_id").setDescription("Order ID to look up").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reset-claim")
    .setDescription("Remove a claim so an order can be verified again (e.g. customer lost access).")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("order_id").setDescription("Order ID to release").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("force-verify")
    .setDescription("Manually grant a user the buyer role (skip API check). Use sparingly.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("user").setDescription("User to verify").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why (logged)").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unverify")
    .setDescription("Remove the buyer role from a user.")
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("user").setDescription("User to unverify").setRequired(true))
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

      switch (interaction.commandName) {
        case "setup-panel":
          await interaction.reply({ content: "✅ Panel posted.", flags: MessageFlags.Ephemeral });
          return interaction.channel.send(buildVerificationPanel());

        case "restock":
          return handleRestockCommand(interaction);

        case "stats":
          return handleStatsCommand(interaction);

        case "check-order":
          return handleCheckOrderCommand(interaction);

        case "whois-order":
          return handleWhoisOrderCommand(interaction);

        case "reset-claim":
          return handleResetClaimCommand(interaction);

        case "force-verify":
          return handleForceVerifyCommand(interaction);

        case "unverify":
          return handleUnverifyCommand(interaction);

        case "health":
          return handleHealthCommand(interaction);

        case "help":
          return handleHelpCommand(interaction);
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
          return interaction.editReply({ content: "🔔 Restock notifications turned **OFF**." });
        }
        await member.roles.add(role);
        return interaction.editReply({
          content: "🔔 Restock notifications turned **ON**! You'll get pinged on restocks.",
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
        "`/health` — gateway latency, SellAuth API status, memory, Node.\n" +
        "`/check-order order_id` — look up an order without granting anything.",
      inline: false,
    },
    {
      name: "🧑‍💼 Claim & role management",
      value:
        "`/whois-order order_id` — which Discord user claimed it.\n" +
        "`/reset-claim order_id` — release a claim (e.g. refund / dispute).\n" +
        "`/force-verify user reason` — manually grant the buyer role.\n" +
        "`/unverify user` — remove the buyer role.",
      inline: false,
    }
  );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

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
