require('dotenv').config();
console.log('PORT from .env:', process.env.PORT);

const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const {
  DISCORD_TOKEN, GUILD_ID,
  UNVERIFIED_ROLE_ID, VERIFIED_ROLE_ID,
  JWT_SECRET, PORT,
  MEMBER_ROLE_ID, INTRO_CHANNEL_ID, ARENA_INVITE_CODE
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

const skipDM = new Set();
const TARGET_MESSAGE_ID = '1403162481358012630';
const TARGET_EMOJI = '✅';

// track invite uses so we know which invite was used on join
const invitesCache = new Map();

// ---------- READY ----------
const commands = [{ name: 'verify', description: 'DMs you the verification form link' }];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // register slash command
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });

  // seed invite cache
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const invites = await guild.invites.fetch();
    invites.forEach(inv => invitesCache.set(inv.code, inv.uses ?? 0));
  } catch (e) {
    console.error('ready invite cache error', e);
  }
});

// keep cache fresh when new invites are created
client.on('inviteCreate', (inv) => {
  invitesCache.set(inv.code, inv.uses ?? 0);
});

// ---------- MEMBER JOIN ----------
client.on('guildMemberAdd', async (member) => {
  try {
    const invites = await member.guild.invites.fetch();
    let usedCode = null;

    invites.forEach(inv => {
      const prev = invitesCache.get(inv.code) ?? 0;
      const now = inv.uses ?? 0;
      if (now > prev) usedCode = inv.code;
      invitesCache.set(inv.code, now);
    });

    if (usedCode === ARENA_INVITE_CODE) {
      // arena.build path → give Verified (sees prelim channels) and skip DM
      await member.roles.add(VERIFIED_ROLE_ID).catch(() => {});
    } else {
      // vanity/public path → Unverified + DM verification link
      await member.roles.add(UNVERIFIED_ROLE_ID).catch(() => {});

      const token = jwt.sign({ discordId: member.id }, JWT_SECRET, { expiresIn: '24h' });
      const url = `https://arena.build?token=${token}`; // replace with direct Tally link if preferred
      const dmMessage = `🔗 [Click here to fill out the form](${url})\n\nOnce you submit, you'll be verified.`;
      await member.send({ content: dmMessage }).catch(() => {});
    }
  } catch (e) {
    console.error('guildMemberAdd error', e);
  }
});

// ---------- REACTION → DM VERIFY LINK (optional helper) ----------
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    if (reaction.message.id !== TARGET_MESSAGE_ID || reaction.emoji.name !== TARGET_EMOJI) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);

    const token = jwt.sign({ discordId: member.id }, JWT_SECRET, { expiresIn: '24h' });
    const url = `https://tally.so/r/mOkk2Y?token=${token}`;

    const msg = `Thanks for verifying!\n\n🔗 [Click here to fill out the form](${url})\n\nLet us know if you run into any issues!`;
    await member.send({ content: msg }).catch(() => {});
  } catch (e) {
    console.error('reaction error', e);
  }
});

// ---------- /verify (optional helper) ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'verify') {
    const token = jwt.sign({ discordId: interaction.user.id }, JWT_SECRET, { expiresIn: '24h' });
    const url = `https://arena.build/form?token=${token}`;
    try {
      await interaction.user.send(`Here’s your verification link:\n${url}`);
      await interaction.reply({ content: 'Check your DMs 👍', ephemeral: true });
    } catch (e) {
      await interaction.reply({
        content: 'I could not DM you. Please enable DMs from server members, then run /verify again.',
        ephemeral: true
      });
    }
  }
});

// ---------- WEBHOOK: form submissions (public/vanity path) ----------
const app = express();
app.use(bodyParser.json());

app.post('/form-webhook', async (req, res) => {
  try {
    // Prefer direct discord_id (from Tally Discord login via Zapier)
    const discordIdFromZap = req.body?.discord_id;

    // Fallback: JWT token (for /verify or reaction link flow)
    const token =
      req.body?.hidden?.token ||
      req.body?.data?.hidden?.token ||
      req.body?.fields?.token ||
      req.body?.token;

    const discordId = discordIdFromZap || (token ? jwt.verify(token, JWT_SECRET).discordId : null);
    if (!discordId) return res.status(400).send('No discord id');

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    // swap Unverified → Verified
    await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
    await member.roles.add(VERIFIED_ROLE_ID).catch(() => {});

    return res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e, req.body);
    return res.sendStatus(200);
  }
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Webhook listening on :${PORT}`));

client.login(DISCORD_TOKEN);
