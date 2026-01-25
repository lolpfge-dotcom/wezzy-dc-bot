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
  SELLAPP_API_KEY: process.env.SELLAPP_API_KEY,
  SELLAPP_STORE_ID: process.env.SELLAPP_STORE_ID,
  RESTOCK_ROLE_ID: process.env.RESTOCK_ROLE_ID,
  ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID,
};

// Verify order with Sellapp API
async function verifyOrder(orderId) {
  try {
    orderId = orderId.replace("#", "");

    const url = `https://sell.app/api/v2/invoices/${orderId}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SELLAPP_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return { success: false, message: "Order not found" };
    }

    const data = await response.json();

    const orderStatus = data.data?.status?.status?.status;
    const customerEmail = data.data?.customer_information?.email;
    const productName = data.data?.listing?.title;

    if (orderStatus === "COMPLETED" || orderStatus === "PAID") {
      return {
        success: true,
        order: {
          customerEmail,
          productName,
          status: orderStatus,
        },
      };
    }

    return { success: false, message: "Order not completed" };
  } catch (error) {
    console.error("Error verifying order:", error);
    return { success: false, message: "Error checking order" };
  }
}

client.on("ready", () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log("🚀 Discord verification bot is ready!");
});

// Handle button interactions and modal submits
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // Verify button clicked
  if (interaction.customId === "verify_order") {
    const modal = new ModalBuilder().setCustomId("order_verification_modal").setTitle("Order Verification");

    const orderIdInput = new TextInputBuilder()
      .setCustomId("order_id")
      .setLabel("Enter your Sellapp Order ID")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g., 12345678")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(50);

    const row = new ActionRowBuilder().addComponents(orderIdInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  // Restock notification toggle
  if (interaction.customId === "subscribe_restock") {
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);

    if (!role) {
      await interaction.reply({ content: "❌ Restock role not found. Contact admin.", ephemeral: true });
      return;
    }

    if (member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)) {
      await member.roles.remove(role);
      await interaction.reply({ content: "🔔 Restock notifications turned OFF.", ephemeral: true });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: "🔔 You will now get pinged on restocks! (Click again to unsubscribe)", ephemeral: true });
    }
  }

  // Modal submitted for verification
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({
      content: "⏳ Verifying your order, please wait...",
    });

    const orderId = interaction.fields.getTextInputValue("order_id");

    verifyOrder(orderId)
      .then(async (result) => {
        if (result.success) {
          const member = interaction.member;
          const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);

          if (!role) {
            await interaction.editReply({
              content: "❌ Error: Buyer role not found. Please contact an administrator.",
            });
            return;
          }

          if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
            await interaction.editReply({
              content: "✅ You already have the buyer role!",
            });
            return;
          }

          try {
            await member.roles.add(role);

            const successEmbed = new EmbedBuilder()
              .setColor("#00ff00")
              .setTitle("✅ Verification Successful!")
              .setDescription(`Your order has been verified!\n\nYou've been given the **${role.name}** role.`)
              .addFields(
                { name: "Order ID", value: orderId, inline: true },
                { name: "Status", value: "Verified", inline: true },
              )
              .setTimestamp();

            await interaction.editReply({
              embeds: [successEmbed],
            });

            console.log(`✅ Verified user ${interaction.user.tag} with order ${orderId}`);
          } catch (error) {
            console.error("Error assigning role:", error);
            await interaction.editReply({
              content: "❌ Error assigning role. Please contact an administrator.",
            });
          }
        } else {
          const errorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Verification Failed")
            .setDescription(result.message || "Could not verify your order.")
            .addFields(
              { name: "Order ID", value: orderId, inline: true },
              { name: "Status", value: "Failed", inline: true },
            )
            .setFooter({ text: "Make sure your order is completed and the ID is correct." })
            .setTimestamp();

          await interaction.editReply({
            embeds: [errorEmbed],
          });

          console.log(`❌ Failed verification for ${interaction.user.tag} with order ${orderId}`);
        }
      })
      .catch((error) => {
        console.error("Verification error:", error);
        interaction.editReply({
          content: "❌ An error occurred during verification.",
        });
      });
  }
});

// Commands: !setup-panel and !announce-restock
client.on("messageCreate", async (message) => {
  if (message.content === "!setup-panel" && message.member.permissions.has("Administrator")) {
    const embed = new EmbedBuilder()
  .setColor("#101418")                    // dark premium gray-black
  .setTitle("Order Verification")
  .setDescription(
    "Welcome to **wezzy.store**\n" +
    "Verify your purchase to access exclusive buyer channels.\n\n" +

    "**How to verify**\n" +
    "1. Click **Verify Order**\n" +
    "2. Enter your Sellapp Order ID\n" +
    "3. Receive buyer role instantly\n\n" +

    "**Finding your Order ID**\n" +
    "• Sellapp purchase email receipt\n" +
    "• Sellapp order history\n" +
    "• Invoice number in dashboard\n\n" +

    "Subscribe to restock alerts below to be notified instantly when items become available again."
  )
  .setThumbnail(null)
  .setFooter({ 
    text: "wezzy.store • Premium Roblox Scripts",
    iconURL: "YOUR_LOGO_URL"               // optional small logo
  })
  .setTimestamp();

const verifyButton = new ButtonBuilder()
  .setCustomId("verify_order")
  .setLabel("Verify Order")
  .setStyle(ButtonStyle.Secondary)        // calmer gray button
  .setEmoji("🔑");                        // subtle access icon

const restockButton = new ButtonBuilder()
  .setCustomId("subscribe_restock")
  .setLabel("Restock Alerts")
  .setStyle(ButtonStyle.Primary)
  .setEmoji("🔔");

    const row = new ActionRowBuilder().addComponents(verifyButton, restockButton);

    await message.channel.send({
      embeds: [embed],
      components: [row],
    });

    await message.delete();
    console.log("✅ Verification panel created with restock button!");
  }

  if (message.content.startsWith("!announce-restock") && message.member.permissions.has("Administrator")) {
  const args = message.content.slice("!announce-restock".length).trim().split(/ +/);
  let product = args[0] || "Product";
  let link = args[1] || "";

  // Handle quoted product names with spaces (e.g. !announce-restock "Cool Script v2" https://...)
  if (product.startsWith('"') || product.startsWith("'")) {
    const endQuoteIndex = message.content.indexOf(product[0], "!announce-restock".length + product.length);
    if (endQuoteIndex > -1) {
      product = message.content.slice("!announce-restock".length + 1, endQuoteIndex).trim();
      link = message.content.slice(endQuoteIndex + 1).trim();
    }
  }

  const role = message.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);
  if (!role) {
    return message.reply("❌ Restock role not found.");
  }

  const embed = new EmbedBuilder()
    .setColor("#ff8800")
    .setTitle("🛒 RESTOCK ALERT!")
    .setDescription(`**${product}** is now available again!`)
    .setTimestamp()
    .setFooter({ text: "wezzy.store - Premium cheats" });

  if (link) {
  // Clean the link: remove any extra quotes or spaces
  link = link.replace(/^["']|["']$/g, '').trim();
  
  // Make sure it's a valid URL (basic check)
  if (link.startsWith('http://') || link.startsWith('https://')) {
    embed.addFields({
      name: "Link",
      value: `[Grab it here](${link})`,
      inline: false
    });
  } else {
    embed.addFields({
      name: "Link",
      value: link,  // fallback: just show raw link if invalid
      inline: false
    });
  }
}

  const channel = CONFIG.ANNOUNCEMENT_CHANNEL_ID
    ? message.guild.channels.cache.get(CONFIG.ANNOUNCEMENT_CHANNEL_ID)
    : message.channel;

  if (!channel) {
    return message.reply("❌ Announcement channel not found.");
  }

  // Send clean: role mention + embed only (no extra text)
  await channel.send({
    content: role.toString(),           // just the mention (pings users)
    embeds: [embed],
    allowedMentions: { parse: ['roles'] }  // only parse roles, suppress @everyone/@here if any
  });

  await message.reply({ content: "✅ Announcement sent!", ephemeral: true });
}
});

client.login(process.env.DISCORD_BOT_TOKEN);
