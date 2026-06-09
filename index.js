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
// Ready
// ---------------------------------------------------------------------------
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🚀 wezzy.store verification bot is ready!");
});

// ---------------------------------------------------------------------------
// Interactions (buttons + modal)
// ---------------------------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) return;
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    // Open verification modal
    if (interaction.customId === "verify_order") {
      const modal = new ModalBuilder()
        .setCustomId("order_verification_modal")
        .setTitle("SellAuth Order Verification");

      const orderIdInput = new TextInputBuilder()
        .setCustomId("order_id")
        .setLabel("Enter your SellAuth Order ID")
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
          .setColor("#ff0000")
          .setTitle("❌ Verification Failed")
          .setDescription(result.message)
          .addFields({ name: "Order ID", value: orderId || "—", inline: true })
          .setFooter({ text: "Make sure the order is completed and the Invoice ID is exact." })
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
        .setColor("#00ff00")
        .setTitle("✅ Verification Successful!")
        .setDescription(`Your order has been verified!\n\nYou've been given the **${role.name}** role.`)
        .addFields(
          { name: "Order ID", value: result.order.id, inline: true },
          { name: "Status", value: result.order.status.toUpperCase(), inline: true }
        )
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
// Admin text commands
// ---------------------------------------------------------------------------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || !message.member || message.author.bot) return;
    const isAdmin = message.member.permissions.has("Administrator");

    // Setup verification panel
    if (message.content === "!setup-panel" && isAdmin) {
      const embed = new EmbedBuilder()
        .setColor("#101418")
        .setTitle("Order Verification")
        .setDescription(
          "Verify your SellAuth purchase to access exclusive buyer channels.\n\n" +
            "**How to verify**\n" +
            "1. Click **Verify Order**\n" +
            "2. Paste your SellAuth Order ID\n" +
            "3. Get the buyer role instantly\n\n" +
            "**Finding your Order ID**\n" +
            "• Check your purchase confirmation email\n" +
            "• Or open your order page from SellAuth\n" +
            "• Copy the Order / Invoice ID"
        )
        .setFooter({ text: "wezzy.store" })
        .setTimestamp();

      const verifyButton = new ButtonBuilder()
        .setCustomId("verify_order")
        .setLabel("Verify Order")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔑");

      const restockButton = new ButtonBuilder()
        .setCustomId("subscribe_restock")
        .setLabel("Restock Alerts")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🔔");

      const row = new ActionRowBuilder().addComponents(verifyButton, restockButton);
      await message.channel.send({ embeds: [embed], components: [row] });
      return message.delete().catch(() => {});
    }

    // Restock announcement:  !announce-restock "Product Name" https://link
    if (message.content.startsWith("!announce-restock") && isAdmin) {
      await message.delete().catch(() => {});

      let rest = message.content.slice("!announce-restock".length).trim();
      let product = "Product";
      let link = "";
      let image = "";

      if (rest.startsWith('"') || rest.startsWith("'")) {
        const quote = rest[0];
        const end = rest.indexOf(quote, 1);
        if (end !== -1) {
          product = rest.slice(1, end).trim();
          rest = rest.slice(end + 1).trim();
        }
      } else {
        const parts = rest.split(/\s+/);
        product = parts.shift() || "Product";
        rest = parts.join(" ");
      }

      // From what's left: first URL = buy link, second URL = banner image
      const urls = rest.split(/\s+/).filter(Boolean).map((u) => u.replace(/^["']|["']$/g, ""));
      link = urls.find((u) => u.startsWith("http")) || "";
      image = urls.filter((u) => u.startsWith("http"))[1] || "";

      const role = message.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);
      if (!role) {
        return message.channel.send("❌ Restock role not found.").then((m) =>
          setTimeout(() => m.delete().catch(() => {}), 5000)
        );
      }

      const buyUrl = link && link.startsWith("http") ? link : CONFIG.STORE_URL;
      const bannerUrl = image && image.startsWith("http") ? image : CONFIG.STORE_BANNER_URL;
      const announceFiles = [];

      const embed = new EmbedBuilder()
        .setColor("#ff8800")
        .setTitle("🔥 Back in stock")
        .setDescription(
          `**${product}** just dropped back in — grab it before it's gone.`
        )
        .setFooter({
          text: "wezzy.store · Restock",
          iconURL: CONFIG.STORE_LOGO_URL || undefined,
        })
        .setTimestamp();

      if (bannerUrl) {
        embed.setImage(bannerUrl);
      } else if (CONFIG.BANNER_FILE) {
        const bannerPath = path.isAbsolute(CONFIG.BANNER_FILE)
          ? CONFIG.BANNER_FILE
          : path.join(__dirname, CONFIG.BANNER_FILE);
        if (fs.existsSync(bannerPath)) {
          const fileName = path.basename(bannerPath);
          announceFiles.push(new AttachmentBuilder(bannerPath, { name: fileName }));
          embed.setImage(`attachment://${fileName}`);
        } else if (CONFIG.STORE_LOGO_URL) {
          embed.setThumbnail(CONFIG.STORE_LOGO_URL);
        }
      } else if (CONFIG.STORE_LOGO_URL) {
        embed.setThumbnail(CONFIG.STORE_LOGO_URL);
      }

      const buttons = [
        new ButtonBuilder().setLabel("Get it now").setEmoji("🛒").setStyle(ButtonStyle.Link).setURL(buyUrl),
      ];
      // Add a secondary "Browse store" button only if the buy link isn't already the store homepage
      if (buyUrl !== CONFIG.STORE_URL) {
        buttons.push(
          new ButtonBuilder().setLabel("Browse store").setEmoji("🛍️").setStyle(ButtonStyle.Link).setURL(CONFIG.STORE_URL)
        );
      }
      const buttonRow = new ActionRowBuilder().addComponents(...buttons);

      const channel = CONFIG.ANNOUNCEMENT_CHANNEL_ID
        ? message.guild.channels.cache.get(CONFIG.ANNOUNCEMENT_CHANNEL_ID)
        : message.channel;

      if (!channel) {
        return message.channel.send("❌ Announcement channel not found.").then((m) =>
          setTimeout(() => m.delete().catch(() => {}), 5000)
        );
      }

      await channel.send({
        content: `<@&${CONFIG.RESTOCK_ROLE_ID}>`,
        embeds: [embed],
        components: [buttonRow],
        files: announceFiles,
        allowedMentions: { parse: ["roles"] },
      });
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
