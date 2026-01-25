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

  // Verify button – defer immediately
  if (interaction.customId === "verify_order") {
    await interaction.deferReply({ flags: 64 }); // ephemeral
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
    return;
  }

  // Restock notification toggle
  if (interaction.customId === "subscribe_restock") {
    await interaction.deferUpdate();

    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);

    if (!role) {
      await interaction.editReply({ content: "❌ Restock role not found.", flags: 64 });
      return;
    }

    if (member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)) {
      await member.roles.remove(role);
      await interaction.editReply({ content: "🔔 Restock notifications turned OFF.", flags: 64 });
    } else {
      await member.roles.add(role);
      await interaction.editReply({ content: "🔔 You will now get pinged on restocks! (Click again to unsubscribe)", flags: 64 });
    }
    return;
  }

  // Modal submitted for verification
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ flags: 64 });

    const orderId = interaction.fields.getTextInputValue("order_id");

    verifyOrder(orderId)
      .then(async (result) => {
        if (result.success) {
          const member = interaction.member;
          const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID);

          if (!role) {
            await interaction.editReply({ content: "❌ Error: Buyer role not found. Please contact an administrator.", flags: 64 });
            return;
          }

          if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
            await interaction.editReply({ content: "✅ You already have the buyer role!", flags: 64 });
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
              flags: 64
            });

            console.log(`✅ Verified user ${interaction.user.tag} with order ${orderId}`);
          } catch (error) {
            console.error("Error assigning role:", error);
            await interaction.editReply({ content: "❌ Error assigning role. Please contact an administrator.", flags: 64 });
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
            flags: 64
          });

          console.log(`❌ Failed verification for ${interaction.user.tag} with order ${orderId}`);
        }
      })
      .catch((error) => {
        console.error("Verification error:", error);
        interaction.editReply({ content: "❌ An error occurred during verification.", flags: 64 }).catch(() => {});
      });
  }
});

// Commands
client.on("messageCreate", async (message) => {
  if (message.content === "!setup-panel" && message.member.permissions.has("Administrator")) {
    const embed = new EmbedBuilder()
      .setColor("#101418")
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
      .setThumbnail(null) // change to your logo URL when ready
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

    await message.channel.send({
      embeds: [embed],
      components: [row],
    });

    await message.delete().catch(() => {});
    console.log("✅ Verification panel created!");
  }

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
      return message.reply({ content: "❌ Restock role not found.", flags: 64 });
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
        embed.addFields({
          name: "Link",
          value: `[Click to grab it](${link})`,
          inline: false
        });
      } else {
        embed.setDescription(embed.data.description + `\n\nLink: ${link}`);
      }
    }

    const channel = CONFIG.ANNOUNCEMENT_CHANNEL_ID
      ? message.guild.channels.cache.get(CONFIG.ANNOUNCEMENT_CHANNEL_ID)
      : message.channel;

    if (!channel) {
      return message.reply({ content: "❌ Announcement channel not found.", flags: 64 });
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: {
        parse: [],
        roles: [roleId]
      }
    });

    await message.reply({ 
      content: "✅ Announcement sent!", 
      flags: 64 
    }).catch(() => {});
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
