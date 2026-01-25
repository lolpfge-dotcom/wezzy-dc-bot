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
} = require("discord.js")
require("dotenv").config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

// Configuration
const CONFIG = {
  BUYER_ROLE_ID:           process.env.BUYER_ROLE_ID,
  VERIFICATION_CHANNEL_ID: process.env.VERIFICATION_CHANNEL_ID,
  SELLAPP_API_KEY:         process.env.SELLAPP_API_KEY,
  SELLAPP_STORE_ID:        process.env.SELLAPP_STORE_ID,
  RESTOCK_ROLE_ID:         process.env.RESTOCK_ROLE_ID,
  ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID,
};

// Verify order with Sellapp API
async function verifyOrder(orderId) {
  try {
    orderId = orderId.replace("#", "")

    const url = `https://sell.app/api/v2/invoices/${orderId}`

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SELLAPP_API_KEY}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      return { success: false, message: "Order not found" }
    }

    const data = await response.json()

    const orderStatus = data.data?.status?.status?.status
    const customerEmail = data.data?.customer_information?.email
    const productName = data.data?.listing?.title

    if (orderStatus === "COMPLETED" || orderStatus === "PAID") {
      return {
        success: true,
        order: {
          customerEmail,
          productName,
          status: orderStatus,
        },
      }
    }

    return { success: false, message: "Order not completed" }
  } catch (error) {
    console.error("Error verifying order:", error)
    return { success: false, message: "Error checking order" }
  }
}

client.on("ready", () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`)
  console.log("🚀 Discord verification bot is ready!")
})

// Handle button interactions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return

  // Verify button clicked
  if (interaction.customId === "verify_order") {
    const modal = new ModalBuilder().setCustomId("order_verification_modal").setTitle("Order Verification")

    const orderIdInput = new TextInputBuilder()
      .setCustomId("order_id")
      .setLabel("Enter your Sellapp Order ID")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g., 12345678")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(50)

    const row = new ActionRowBuilder().addComponents(orderIdInput)
    modal.addComponents(row)

    await interaction.showModal(modal)
  }  
  // Restock button handler – add this whole block
  if (interaction.customId === "subscribe_restock") {
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(CONFIG.RESTOCK_ROLE_ID);

    if (!role) {
      return interaction.reply({ content: "❌ Restock role not found. Contact admin.", ephemeral: true });
    }

    if (member.roles.cache.has(CONFIG.RESTOCK_ROLE_ID)) {
      await member.roles.remove(role);
      await interaction.reply({ content: "🔔 Restock notifications turned OFF.", ephemeral: true });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: "🔔 You will now get pinged on restocks! (Click again to unsubscribe)", ephemeral: true });
    }
  }

  // Modal submitted
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ ephemeral: true })
    await interaction.editReply({
      content: "⏳ Verifying your order, please wait...",
    })

    const orderId = interaction.fields.getTextInputValue("order_id")

    verifyOrder(orderId)
      .then(async (result) => {
        if (result.success) {
          const member = interaction.member
          const role = interaction.guild.roles.cache.get(CONFIG.BUYER_ROLE_ID)

          if (!role) {
            await interaction.editReply({
              content: "❌ Error: Buyer role not found. Please contact an administrator.",
            })
            return
          }

          if (member.roles.cache.has(CONFIG.BUYER_ROLE_ID)) {
            await interaction.editReply({
              content: "✅ You already have the buyer role!",
            })
            return
          }

          try {
            await member.roles.add(role)

            const successEmbed = new EmbedBuilder()
              .setColor("#00ff00")
              .setTitle("✅ Verification Successful!")
              .setDescription(`Your order has been verified!\n\nYou've been given the **${role.name}** role.`)
              .addFields(
                { name: "Order ID", value: orderId, inline: true },
                { name: "Status", value: "Verified", inline: true },
              )
              .setTimestamp()

            await interaction.editReply({
              embeds: [successEmbed],
            })

            console.log(`✅ Verified user ${interaction.user.tag} with order ${orderId}`)
          } catch (error) {
            console.error("Error assigning role:", error)
            await interaction.editReply({
              content: "❌ Error assigning role. Please contact an administrator.",
            })
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
            .setTimestamp()

          await interaction.editReply({
            embeds: [errorEmbed],
          })

          console.log(`❌ Failed verification for ${interaction.user.tag} with order ${orderId}`)
        }
      })
      .catch((error) => {
        console.error("Verification error:", error)
        interaction.editReply({
          content: "❌ An error occurred during verification.",
        })
      })
  }
})

// Command to create the verification panel (run this once)
client.on("messageCreate", async (message) => {
  if (message.content === "!setup-panel" && message.member.permissions.has("Administrator")) {
    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("🔐 Order Verification")
      .setDescription(
        "**Welcome to wezzy.store!**\n\n" +
          "Click the button below to verify your purchase and get access to exclusive buyer channels.\n\n" +
          "**How to verify:**\n" +
          '1. Click the "Verify Order" button\n' +
          "2. Enter your Sellapp Order ID\n" +
          "3. Get your buyer role instantly!\n\n" +
          "**Where to find your Order ID:**\n" +
          "• Check your email receipt from Sellapp\n" +
          "• Visit your Sellapp order history\n" +
          "• Look for the invoice number",
      )
      .setThumbnail("/images/bild.png")
      .setFooter({ text: "wezzy.store - Premium Roblox Scripts" })
      .setTimestamp()

    // Verify button (old one)
    const verifyButton = new ButtonBuilder()
      .setCustomId("verify_order")
      .setLabel("Verify Order")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅");

    // New restock button – this is what you asked for
    const restockButton = new ButtonBuilder()
      .setCustomId("subscribe_restock")
      .setLabel("Restock Notifications")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔔");

    // Row with BOTH buttons
    const row = new ActionRowBuilder().addComponents(verifyButton, restockButton);

    await message.channel.send({
      embeds: [embed],
      components: [row],
    });

    await message.delete();
    console.log("✅ Verification panel created with restock button!");
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)
