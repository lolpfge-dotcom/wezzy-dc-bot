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
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
})

// Configuration
const CONFIG = {
  BUYER_ROLE_ID: process.env.BUYER_ROLE_ID,
  VERIFICATION_CHANNEL_ID: process.env.VERIFICATION_CHANNEL_ID,
  SELLAPP_API_KEY: process.env.SELLAPP_API_KEY,
  SELLAPP_STORE_ID: process.env.SELLAPP_STORE_ID,
}

const CONFIG_DIR = path.join(__dirname, "config")
const CONFIG_FILE = path.join(CONFIG_DIR, "monitored_channels.json")

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

function loadMonitoredChannels() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8")
      const parsed = JSON.parse(data)
      console.log("✅ Loaded monitored channels from file")
      return parsed
    } else {
      console.log("📝 Creating new config file...")
      const defaultConfig = { outputChannel: null, monitoredChannels: [] }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2))
      return defaultConfig
    }
  } catch (error) {
    console.error("❌ Error loading config:", error.message)
    return { outputChannel: null, monitoredChannels: [] }
  }
}

function saveMonitoredChannels(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { flag: "w" })
    console.log("✅ Saved config to file")
    return true
  } catch (error) {
    console.error("❌ Error saving config:", error.message)
    return false
  }
}

// Load config at startup
const monitoredConfig = loadMonitoredChannels()

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
    console.error("❌ Error verifying order:", error)
    return { success: false, message: "Error checking order" }
  }
}

client.on("ready", () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`)
  console.log("🚀 Discord verification bot is ready!")
  console.log(`📡 Monitoring ${monitoredConfig.monitoredChannels.length} channels`)
})

client.on("messageCreate", async (message) => {
  // Don't process bot messages or messages from DMs
  if (message.author.bot || !message.guild) {
    return
  }

  const isMonitored = monitoredConfig.monitoredChannels.some(
    (ch) => ch.guildId === message.guildId && ch.channelId === message.channelId,
  )

  if (isMonitored && monitoredConfig.outputChannel) {
    try {
      const outputChannel = await client.channels.fetch(monitoredConfig.outputChannel)

      if (!outputChannel) {
        console.log("❌ Output channel not found:", monitoredConfig.outputChannel)
        return
      }

      // Create embed for the update
      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setAuthor({
          name: message.author.username,
          iconURL: message.author.displayAvatarURL(),
        })
        .setDescription(message.content || "*No text content*")
        .addFields(
          {
            name: "Source",
            value: `[${message.guild.name}](https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id})`,
            inline: true,
          },
          {
            name: "Channel",
            value: `#${message.channel.name}`,
            inline: true,
          },
        )
        .setTimestamp(message.createdTimestamp)
        .setFooter({ text: "Update Log" })

      // Add attachments if any
      if (message.attachments.size > 0) {
        const attachment = message.attachments.first()
        if (attachment.contentType?.startsWith("image/")) {
          embed.setImage(attachment.url)
        }
      }

      await outputChannel.send({ embeds: [embed] })
      console.log(`✅ Forwarded message from ${message.guild.name}#${message.channel.name}`)
    } catch (error) {
      console.error("❌ Error forwarding message:", error.message)
    }
  }

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

    const button = new ButtonBuilder()
      .setCustomId("verify_order")
      .setLabel("Verify Order")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")

    const row = new ActionRowBuilder().addComponents(button)

    await message.channel.send({
      embeds: [embed],
      components: [row],
    })

    await message.delete()
    console.log("✅ Verification panel created!")
  }
})

// Handle button and modal interactions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isChatInputCommand()) return

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

  // Modal submitted
  if (interaction.customId === "order_verification_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const orderId = interaction.fields.getTextInputValue("order_id")

    const result = await verifyOrder(orderId)

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
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "set_output") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ You need administrator permissions", flags: MessageFlags.Ephemeral })
        return
      }

      const channel = interaction.options.getChannel("channel")
      monitoredConfig.outputChannel = channel.id
      saveMonitoredChannels(monitoredConfig)

      await interaction.reply({
        content: `✅ Output channel set to ${channel}`,
        flags: MessageFlags.Ephemeral,
      })
    }

    if (interaction.commandName === "monitor_channel") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ You need administrator permissions", flags: MessageFlags.Ephemeral })
        return
      }

      const guildId = interaction.options.getString("guild_id")
      const channelId = interaction.options.getString("channel_id")

      const existing = monitoredConfig.monitoredChannels.find(
        (ch) => ch.guildId === guildId && ch.channelId === channelId,
      )

      if (existing) {
        await interaction.reply({
          content: "❌ This channel is already being monitored",
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      monitoredConfig.monitoredChannels.push({ guildId, channelId })
      saveMonitoredChannels(monitoredConfig)

      await interaction.reply({
        content: `✅ Now monitoring channel ${channelId} from server ${guildId}`,
        flags: MessageFlags.Ephemeral,
      })
    }

    if (interaction.commandName === "unmonitor_channel") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ You need administrator permissions", flags: MessageFlags.Ephemeral })
        return
      }

      const guildId = interaction.options.getString("guild_id")
      const channelId = interaction.options.getString("channel_id")

      monitoredConfig.monitoredChannels = monitoredConfig.monitoredChannels.filter(
        (ch) => !(ch.guildId === guildId && ch.channelId === channelId),
      )
      saveMonitoredChannels(monitoredConfig)

      await interaction.reply({
        content: `✅ Removed channel ${channelId} from monitoring`,
        flags: MessageFlags.Ephemeral,
      })
    }

    if (interaction.commandName === "list_monitored") {
      if (monitoredConfig.monitoredChannels.length === 0) {
        await interaction.reply({
          content: "📭 No channels are currently being monitored",
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      const list = monitoredConfig.monitoredChannels
        .map((ch) => `• Guild: \`${ch.guildId}\` | Channel: \`${ch.channelId}\``)
        .join("\n")

      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("📡 Monitored Channels")
        .setDescription(list)
        .setFooter({ text: `Total: ${monitoredConfig.monitoredChannels.length}` })

      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      })
    }
  }
})

client.once("ready", async () => {
  try {
    const commands = [
      {
        name: "set_output",
        description: "Set the channel where updates will be posted",
        options: [
          {
            name: "channel",
            description: "The output channel for updates",
            type: 7,
            required: true,
          },
        ],
      },
      {
        name: "monitor_channel",
        description: "Add a channel to monitor for updates",
        options: [
          {
            name: "guild_id",
            description: "Server ID to monitor",
            type: 3,
            required: true,
          },
          {
            name: "channel_id",
            description: "Channel ID to monitor",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "unmonitor_channel",
        description: "Remove a channel from monitoring",
        options: [
          {
            name: "guild_id",
            description: "Server ID",
            type: 3,
            required: true,
          },
          {
            name: "channel_id",
            description: "Channel ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "list_monitored",
        description: "List all monitored channels",
      },
    ]

    await client.application.commands.set(commands)
    console.log("✅ Slash commands registered")
  } catch (error) {
    console.error("Error registering commands:", error)
  }
})

client.login(process.env.DISCORD_BOT_TOKEN)
