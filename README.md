# Discord Order Verification Bot - Simple Setup Guide

This bot lets customers verify their Sellapp orders and get a buyer role automatically.

---

## Step 1: Get Your Discord Bot Token

1. Go to https://discord.com/developers/applications
2. Click your bot (or create a new application)
3. Click **"Bot"** on the left sidebar
4. Click **"Reset Token"** and copy it
5. Save this token - you'll need it in Step 4

---

## Step 2: Get Your Role ID

1. Open Discord
2. Go to **User Settings** → **Advanced** → Turn on **Developer Mode**
3. Go to **Server Settings** → **Roles**
4. Right-click your "Buyer" role (or whatever you want to call it)
5. Click **"Copy Role ID"**
6. Save this ID - you'll need it in Step 4

---

## Step 3: Get Your Channel ID

1. In Discord, right-click the channel where you want the verification panel
2. Click **"Copy Channel ID"**
3. Save this ID - you'll need it in Step 4

---

## Step 4: Setup the Bot Files

1. Download the `discord-bot` folder from your project
2. Open the folder in your terminal/command prompt
3. Run: `npm install`
4. Create a file called `.env` (no name, just .env)
5. Copy this into the `.env` file and fill in your values:

\`\`\`
DISCORD_TOKEN=your_bot_token_from_step_1
BUYER_ROLE_ID=your_role_id_from_step_2
VERIFICATION_CHANNEL_ID=your_channel_id_from_step_3
SELLAPP_API_KEY=your_sellapp_api_key
SELLAPP_STORE_ID=your_sellapp_store_id
\`\`\`

**Where to find Sellapp keys:**
- Go to your Sellapp dashboard
- Settings → API
- Copy your API Key and Store ID

---

## Step 5: Invite Bot to Your Server

1. Go back to https://discord.com/developers/applications
2. Click your bot → **OAuth2** → **URL Generator**
3. Check these boxes:
   - Under **Scopes**: `bot` and `applications.commands`
   - Under **Bot Permissions**: `Manage Roles`, `Send Messages`, `Embed Links`
4. Copy the URL at the bottom
5. Open the URL in your browser and invite the bot to your server

---

## Step 6: Start the Bot

1. In your terminal (in the discord-bot folder), run:
\`\`\`
npm start
\`\`\`

2. You should see: "Bot is online!"

---

## Step 7: Create the Verification Panel

1. Go to your verification channel in Discord
2. Type: `!setup-panel`
3. The bot will create a panel with a "Verify Order" button

**Done!** Users can now click the button, enter their order ID, and get verified.

---

## How Users Verify

1. User clicks **"Verify Order"** button
2. A popup appears asking for their Sellapp Order ID
3. They paste their order ID (from Sellapp confirmation email)
4. Bot checks if the order is real and paid
5. If valid → User gets the buyer role ✅
6. If invalid → User gets an error message ❌

---

## Troubleshooting

**Bot shows offline:**
- Make sure you ran `npm start`
- Check your bot token is correct in `.env`

**Button doesn't work:**
- Make sure bot has "Manage Roles" permission
- Check the bot's role is ABOVE the buyer role in Server Settings → Roles

**"Order not found" error:**
- User needs to use the exact Order ID from Sellapp
- Order must be marked as "completed" in Sellapp

**Role not being given:**
- Bot's role must be higher than buyer role
- Drag bot role above buyer role in Server Settings → Roles

---

## Need Help?

Check the console where you ran `npm start` - it shows error messages that can help you debug.
