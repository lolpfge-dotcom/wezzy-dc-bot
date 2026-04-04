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

// Verify order with Sellhub API (List endpoint + anti-block headers)
async function verifyOrder(orderId) {
  try {
    orderId = orderId.replace("#", "").trim();

    if (!orderId) {
      return { success: false, message: "Order ID is required" };
    }

    const url = `https://dash.sellhub.cx/api/sellhub/invoices?id=${encodeURIComponent(orderId)}`;

    console.log(`[DEBUG] Checking Sellhub invoice ID: ${orderId}`);

    const response = await fetch(url, {
      headers: {
        Authorization: process.env.SELLHUB_API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    });

    console.log(`[DEBUG] API Response Status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "No error body");
      console.error(`[DEBUG] Sellhub Error Body: ${errorText.substring(0, 500)}`);

      if (errorText.includes("Cloudflare") || errorText.includes("blocked") || response.status === 403) {
        return { success: false, message: "Cloudflare blocked the request. Try again in 1-2 minutes." };
      }
      return { success: false, message: `API error (${response.status})` };
    }

    const data = await response.json();
    const invoices = data.data?.invoices || [];

    console.log(`[DEBUG] Found ${invoices.length} invoice(s) in response`);

    const order = invoices.find(inv => 
      inv.id === orderId || inv.id?.toString() === orderId
    );

    if (!order) {
      return { success: false, message: "Order not found. Make sure you're using the exact Sellhub Invoice ID." };
    }

    const orderStatus = (order.status || "").toLowerCase();
    console.log(`[DEBUG] Order found - Status: ${orderStatus}`);

    const customerEmail = order.customer?.email || order.email;
    const productName = order.product?.title || order.listing?.title || "Product";

    if (["paid", "completed", "fulfilled", "successful"].includes(orderStatus)) {
      return {
        success: true,
        order: {
          customerEmail,
          productName,
          status: orderStatus,
        },
      };
    }

    return { 
      success: false, 
      message: `Order found but status is "${orderStatus}" (must be paid or completed)` 
    };

  } catch (error) {
    console.error("[DEBUG] Fetch exception:", error.message);
    return { success: false, message: "Error checking order with Sellhub" };
  }
}

client.on("ready", () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log("🚀 Discord verification bot is ready!");
});

// Handle interactions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // Verify button
  if (interaction.customId === "verify_order") {
    const modal = new ModalBuilder()
      .setCustomId("order_verification_modal")
      .setTitle("Sellhub Order Verification");

    const orderIdInput = new TextInputBuilder()
      .setCustomId("order_id")
      .setLabel("Enter your Sellhub Invoice ID")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g., d73b9e4d-56e5-4e0f-91fe-e9f1eb327764")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(50);

    modal.addComponents(new ActionRowBuilder().addComponents(orderIdInput));

    await interaction.showModal(modal);
    return;
  }

  // Restock toggle
  if (interaction.customId === "subscribe_restock") {
    await interaction.deferUpdate();

    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);

    if (!role) {
      await interaction.followUp({ content: "❌ Restock role not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    let statusText = member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)
      ? "🔔 Restock notifications turned **OFF**."
      : "🔔 Restock notifications turned **ON**! You'll get pinged on restocks.";

    if (member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)) {
      await member.roles.remove(role);
    } else {
      await member.roles.add(role);
    }

    await interaction.followUp({ content: statusText, flags: MessageFlags.Ephemeral });
  }

  // Modal submit
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const orderId = interaction.fields.getTextInputValue("order_id");

    verifyOrder(orderId)
      .then(async (result) => {
        if (result.success) {
          const member = interaction.member;
          const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);

          if (!role) {
            return interaction.editReply({ content: "❌ Buyer role not found.", flags: MessageFlags.Ephemeral });
          }

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
            .setFooter({ text: "Make sure the order is completed and the ID is correct." })
            .setTimestamp();

          await interaction.editReply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
          console.log(`❌ Failed verification for ${interaction.user.tag} with order ${orderId}`);
        }
      })
      .catch((error) => {
        console.error("Verification error:", error);
        interaction.editReply({ content: "❌ An unexpected error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
      });
  }
});

client.on("messageCreate", async (message) => {
  if (message.content === "!setup-panel" && message.member.permissions.has("Administrator")) {
    const embed = new EmbedBuilder()
      .setColor("#101418")
      .setTitle("Order Verification")
      .setDescription(
        "Verify your purchase to access exclusive buyer channels.\n\n" +
        "**How to verify**\n" +
        "1. Click **Verify Order**\n" +
        "2. Enter your Sellhub Invoice ID\n" +
        "3. Receive buyer role instantly\n\n" +
        "**Finding your Invoice ID**\n" +
        "• Check your Sellhub purchase email\n" +
        "• Go to Sellhub Dashboard → Orders / Invoices\n" +
        "• Copy the long Invoice ID (UUID format)\n\n" +
        "Subscribe to restock alerts below."
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

  // Restock announcement command (unchanged)
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
    if (!role) return message.reply({ content: "❌ Restock role not found.", flags: MessageFlags.Ephemeral });

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

    if (!channel) return message.reply({ content: "❌ Announcement channel not found.", flags: MessageFlags.Ephemeral });

    await channel.send({
      content: `<@&${roleId}>`,
      embeds: [embed],
      allowedMentions: { parse: ['roles'] }
    });

    await message.reply({ content: "✅ Announcement sent!", flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
