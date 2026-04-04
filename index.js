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
} = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Configuration
const CONFIG = {
  BUYER_ROLE_ID: process.env.BUYER_ROLE_ID,
  VERIFICATION_CHANNEL_ID: process.env.VERIFICATION_CHANNEL_ID,
  RESTOCK_ROLE_ID: process.env.RESTOCK_ROLE_ID,
  ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID,
};

// Enhanced Sellhub verification with better headers and retry
async function verifyOrder(orderId, retries = 2) {
  try {
    orderId = orderId.replace("#", "").trim();

    if (!orderId) {
      return { success: false, message: "Order ID is required" };
    }

    const url = `https://dash.sellhub.cx/api/sellhub/invoices?id=${encodeURIComponent(orderId)}`;

    console.log(`[DEBUG] Attempt ${3 - retries} | Checking Sellhub ID: ${orderId}`);

    const headers = {
      Authorization: process.env.SELLHUB_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://dash.sellhub.cx/",
      "Origin": "https://dash.sellhub.cx",
    };

    const response = await fetch(url, { headers });

    console.log(`[DEBUG] Status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "No body");
      console.error(`[DEBUG] Error body: ${errorText.substring(0, 400)}`);

      if ((response.status === 403 || errorText.includes("Cloudflare") || errorText.includes("blocked")) && retries > 0) {
        console.log(`[DEBUG] Cloudflare detected - waiting 4 seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, 4000));
        return verifyOrder(orderId, retries - 1);
      }

      return { success: false, message: "Cloudflare protection blocked the request. Please try again in 1-2 minutes." };
    }

    const data = await response.json();
    const invoices = data.data?.invoices || [];

    console.log(`[DEBUG] Invoices returned: ${invoices.length}`);

    const order = invoices.find(inv => 
      inv.id === orderId || String(inv.id) === orderId
    );

    if (!order) {
      return { success: false, message: "Order not found. Make sure you copied the exact Invoice ID from Sellhub." };
    }

    const orderStatus = (order.status || "").toLowerCase().trim();
    console.log(`[DEBUG] Order status: ${orderStatus}`);

    if (["paid", "completed", "fulfilled", "successful"].includes(orderStatus)) {
      return {
        success: true,
        order: {
          customerEmail: order.customer?.email || order.email,
          productName: order.product?.title || order.listing?.title || "Product",
          status: orderStatus,
        },
      };
    }

    return { 
      success: false, 
      message: `Order found, but status is "${orderStatus}". It must be paid or completed.` 
    };

  } catch (error) {
    console.error("[DEBUG] Exception:", error.message);
    return { success: false, message: "Error connecting to Sellhub. Please try again later." };
  }
}

client.on("ready", () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log("🚀 Sellhub verification bot is ready!");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // Open verification modal
  if (interaction.customId === "verify_order") {
    const modal = new ModalBuilder()
      .setCustomId("order_verification_modal")
      .setTitle("Sellhub Order Verification");

    const orderIdInput = new TextInputBuilder()
      .setCustomId("order_id")
      .setLabel("Enter your Sellhub Invoice ID")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. d73b9e4d-56e5-4e0f-91fe-e9f1eb327764")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(50);

    modal.addComponents(new ActionRowBuilder().addComponents(orderIdInput));
    await interaction.showModal(modal);
    return;
  }

  // Restock alerts toggle
  if (interaction.customId === "subscribe_restock") {
    await interaction.deferUpdate();
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);

    if (!role) {
      return interaction.followUp({ content: "❌ Restock role not found.", flags: MessageFlags.Ephemeral });
    }

    const hasRole = member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID);
    if (hasRole) {
      await member.roles.remove(role);
      await interaction.followUp({ content: "🔔 Restock notifications turned **OFF**.", flags: MessageFlags.Ephemeral });
    } else {
      await member.roles.add(role);
      await interaction.followUp({ content: "🔔 Restock notifications turned **ON**! You'll get pinged on restocks.", flags: MessageFlags.Ephemeral });
    }
  }

  // Process verification modal
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const orderId = interaction.fields.getTextInputValue("order_id");

    const result = await verifyOrder(orderId);

    if (result.success) {
      const member = interaction.member;
      const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);

      if (!role) return interaction.editReply({ content: "❌ Buyer role not found.", flags: MessageFlags.Ephemeral });
      if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
        return interaction.editReply({ content: "✅ You already have the buyer role!", flags: MessageFlags.Ephemeral });
      }

      await member.roles.add(role);

      const successEmbed = new EmbedBuilder()
        .setColor("#00ff00")
        .setTitle("✅ Verification Successful!")
        .setDescription(`Your order has been verified!\n\nYou've been given the **${role.name}** role.`)
        .addFields(
          { name: "Order ID", value: orderId, inline: true },
          { name: "Status", value: result.order.status.toUpperCase(), inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
      console.log(`✅ Verified ${interaction.user.tag} with order ${orderId}`);
    } else {
      const errorEmbed = new EmbedBuilder()
        .setColor("#ff0000")
        .setTitle("❌ Verification Failed")
        .setDescription(result.message)
        .addFields({ name: "Order ID", value: orderId, inline: true })
        .setFooter({ text: "Make sure the order is completed and you copied the exact Invoice ID." })
        .setTimestamp();

      await interaction.editReply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
      console.log(`❌ Failed verification for ${interaction.user.tag} with order ${orderId}`);
    }
  }
});

client.on("messageCreate", async (message) => {
  // Setup verification panel
  if (message.content === "!setup-panel" && message.member.permissions.has("Administrator")) {
    const embed = new EmbedBuilder()
      .setColor("#101418")
      .setTitle("Order Verification")
      .setDescription(
        "Verify your Sellhub purchase to access exclusive buyer channels.\n\n" +
        "**How to verify**\n" +
        "1. Click **Verify Order**\n" +
        "2. Paste your Sellhub Invoice ID\n" +
        "3. Get the buyer role instantly\n\n" +
        "**Finding your Invoice ID**\n" +
        "• Check your purchase confirmation email\n" +
        "• Go to Sellhub Dashboard → Orders / Invoices\n" +
        "• Copy the long UUID (e.g. d73b9e4d-...)"
      )
      .setFooter({ text: "wezzy.store • Premium Cheats" })
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
    await message.delete().catch(() => {});
  }

  // Restock announcement (unchanged)
  if (message.content.startsWith("!announce-restock") && message.member.permissions.has("Administrator")) {
    await message.delete().catch(() => {});

    let contentAfter = message.content.slice("!announce-restock".length).trim();
    let product = "Product";
    let link = "";

    if (contentAfter.startsWith('"') || contentAfter.startsWith("'")) {
      const quote = contentAfter[0];
      const end = contentAfter.indexOf(quote, 1);
      if (end !== -1) {
        product = contentAfter.slice(1, end).trim();
        link = contentAfter.slice(end + 1).trim();
      }
    } else {
      const parts = contentAfter.split(/\s+/);
      product = parts[0] || "Product";
      link = parts.slice(1).join(" ").trim();
    }

    const roleId = CONFIG.RESTOCK_ROLE_ID;
    const role = message.guild.roles.cache.get(roleId);
    if (!role) {
      return message.reply({ content: "❌ Restock role not found.", flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setColor("#ff8800")
      .setTitle("🛒 RESTOCK ALERT!")
      .setDescription(`**${product}** is now available again!`)
      .setTimestamp()
      .setFooter({ text: "wezzy.store • Premium Cheats" });

    if (link) {
      link = link.replace(/^["']|["']$/g, '').trim();
      if (link.startsWith('http')) {
        embed.addFields({ name: "Link", value: `[Click to grab it](${link})`, inline: false });
      } else {
        embed.setDescription(embed.data.description + `\n\nLink: ${link}`);
      }
    }

    const channel = CONFIG.ANNOUNCEMENT_CHANNEL_ID
      ? message.guild.channels.cache.get(CONFIG.ANNOUNCEMENT_CHANNEL_ID)
      : message.channel;

    if (!channel) {
      return message.reply({ content: "❌ Announcement channel not found.", flags: MessageFlags.Ephemeral });
    }

    await channel.send({
      content: `<@&${roleId}>`,
      embeds: [embed],
      allowedMentions: { parse: ['roles'] }
    });

    await message.reply({ content: "✅ Announcement sent!", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
