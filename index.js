require('dotenv').config();
console.log('PORT from .env:', process.env.PORT);

const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');

const {
  DISCORD_TOKEN, GUILD_ID,
  UNVERIFIED_ROLE_ID, VERIFIED_ROLE_ID,
  JWT_SECRET, PORT
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

// 1) On member join: assign Unverified role
client.on('guildMemberAdd', async (member) => {
  try {
    await member.roles.add(UNVERIFIED_ROLE_ID).catch(() => {});
  } catch (e) {
    console.error('guildMemberAdd error', e);
  }
});

// 2) Reaction-based DM trigger
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

    const message = `Thanks for verifying!

🔗 [Click here to fill out the form](${url})

Let us know if you run into any issues!`;

    await member.send({ content: message }).catch(() => {});
  } catch (e) {
    console.error('reaction error', e);
  }
});

// 3) Slash command: /verify
const commands = [
  { name: 'verify', description: 'DMs you the verification form link' }
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
});

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

// 4) Webhook for form submissions
const app = express();
app.use(bodyParser.json());

app.post('/form-webhook', async (req, res) => {
  try {
    const token =
      req.body?.hidden?.token ||
      req.body?.data?.hidden?.token ||
      req.body?.fields?.token ||
      req.body?.token;

    if (!token) return res.status(400).send('No token');

    const { discordId } = jwt.verify(token, JWT_SECRET);
    skipDM.add(discordId);

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
    await member.roles.add(VERIFIED_ROLE_ID).catch(() => {});

    return res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e);
    return res.sendStatus(200);
  }
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Webhook listening on :${PORT}`));

client.login(DISCORD_TOKEN);