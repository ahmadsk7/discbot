require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const https = require('https'); // <-- [ADDED] for keep-alive pings

const {
  DISCORD_TOKEN, GUILD_ID,
  UNVERIFIED_ROLE_ID, VERIFIED_ROLE_ID, MEMBER_ROLE_ID,
  INTRO_CHANNEL_ID, LOG_CHANNEL_ID,
  JWT_SECRET, PORT,
  ARENA_INVITE_CODE, DEBUG
} = process.env;

const invitesCache = new Map();
function dlog(...args) { if (String(DEBUG).toLowerCase() === 'true') console.log('[DEBUG]', ...args); }

async function safeAddRole(member, roleId, label) {
  dlog('safeAddRole ->', label, 'roleId=', roleId);
  if (!roleId) throw new Error(`Missing roleId for ${label}`);
  if (member.roles.cache.has(roleId)) { dlog('already has', label); return; }
  await member.roles.add(roleId);
  dlog('added', label, 'to', member.user.tag);
}

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

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: [
      { name: 'verify', description: 'DMs you the verification form link' },
      { name: 'role_debug', description: 'Try adding Unverified/Verified to you and report errors' }
    ]
  });

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    dlog('Guild:', guild.name, guild.id);

    try {
      const invites = await guild.invites.fetch();
      invites.forEach(inv => invitesCache.set(inv.code, inv.uses ?? 0));
      dlog('Seeded invites cache:', [...invitesCache.entries()]);
    } catch (e) {
      console.warn('[ready] invites.fetch failed:', e?.message);
    }

    const me = await guild.members.fetchMe();
    const botTopRole = me.roles.highest;
    dlog('Bot top role:', botTopRole?.name, botTopRole?.position);

    const unver = guild.roles.cache.get(UNVERIFIED_ROLE_ID);
    const ver = guild.roles.cache.get(VERIFIED_ROLE_ID);
    const mem = guild.roles.cache.get(MEMBER_ROLE_ID);
    dlog('Unverified role:', unver?.name, unver?.position, UNVERIFIED_ROLE_ID);
    dlog('Verified role:', ver?.name, ver?.position, VERIFIED_ROLE_ID);
    dlog('Member role:', mem?.name, mem?.position, MEMBER_ROLE_ID);

    if (!me.permissions.has('ManageRoles')) console.warn('⚠️ Bot lacks Manage Roles');
    if (!me.permissions.has('ManageGuild')) console.warn('⚠️ Bot lacks Manage Guild');
    const tooLow =
      botTopRole?.position <= (unver?.position ?? -1) ||
      botTopRole?.position <= (ver?.position ?? -1) ||
      botTopRole?.position <= (mem?.position ?? -1);
    if (tooLow) console.warn('⚠️ Bot role must be ABOVE Unverified/Verified/Member');
  } catch (e) {
    console.error('[ready] error:', e);
  }
});

// --- Connection diagnostics (ADDED) ---
client.on('shardReady', (id, unavailableGuilds) => {
  dlog(`[shard] READY id=${id} unavailableGuilds=${unavailableGuilds?.size ?? 0}`);
});
client.on('shardReconnecting', (id) => dlog(`[shard] RECONNECTING id=${id}`));
client.on('shardResume', (id, replayed) => dlog(`[shard] RESUMED id=${id} events=${replayed}`));
client.on('shardDisconnect', (event, id) => {
  console.warn(`[shard] DISCONNECT id=${id} code=${event?.code} reason=${event?.reason || ''}`);
});
client.on('warn', (m) => console.warn('[client] warn', m));
client.on('error', (err) => console.error('[client] error', err?.message || err));
setInterval(() => {
  const s = client.ws?.status;
  dlog('[heartbeat] ws.status=', s, 'uptime(min)=', Math.floor(process.uptime()/60));
}, 5 * 60 * 1000);

client.on('guildMemberAdd', async (member) => {
  dlog('[join] member:', member.user.tag, 'id=', member.id, 'pending=', member.pending);
  try {
    if (member.pending) {
      dlog('[join] pending; will add role after acceptance.');
      return;
    }

    let usedCode = null;
    try {
      const invites = await member.guild.invites.fetch();
      invites.forEach(inv => {
        const prev = invitesCache.get(inv.code) ?? 0;
        const now  = inv.uses ?? 0;
        if (now > prev) usedCode = inv.code;
        invitesCache.set(inv.code, now);
      });
      dlog('[join] usedCode:', usedCode);
    } catch (e) {
      console.warn('[join] invites.fetch failed:', e?.message);
    }

    await safeAddRole(member, UNVERIFIED_ROLE_ID, 'Unverified');

    if (usedCode === ARENA_INVITE_CODE) {
      dlog('[join] matches ARENA_INVITE_CODE => upgrading to Verified');
      try { await member.roles.remove(UNVERIFIED_ROLE_ID); } catch {}
      await safeAddRole(member, VERIFIED_ROLE_ID, 'Verified (invite)');
    } else {
      dlog('[join] non-special invite => DM token link');
      const token = jwt.sign({ discordId: member.id }, JWT_SECRET, { expiresIn: '24h' });
      const url = `https://arena.build?token=${token}`;
      try {
        await member.send(
          `Thanks for verifying!\n\n🔗 [Click here to fill out the form](${url})\n\nLet us know if you run into any issues!`
        );
      } catch (e) {
        console.warn('[join] DM failed (user DMs closed):', e?.message);
      }
    }
  } catch (e) {
    console.error('guildMemberAdd error:', e);
  }
});

client.on('guildMemberUpdate', async (oldM, newM) => {
  try {
    if (oldM.pending && !newM.pending) {
      dlog('[screening] accepted rules:', newM.user.tag);
      const hasUnver = newM.roles.cache.has(UNVERIFIED_ROLE_ID);
      const hasVer   = newM.roles.cache.has(VERIFIED_ROLE_ID);
      if (!hasUnver && !hasVer) await safeAddRole(newM, UNVERIFIED_ROLE_ID, 'Unverified (post-screening)');
    }
  } catch (e) {
    console.error('guildMemberUpdate error:', e);
  }
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

  if (interaction.commandName === 'role_debug') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(interaction.user.id);

      dlog('[role_debug] running for', member.user.tag);

      await safeAddRole(member, UNVERIFIED_ROLE_ID, 'Unverified');
      try { await member.roles.remove(UNVERIFIED_ROLE_ID); } catch {}
      await safeAddRole(member, VERIFIED_ROLE_ID, 'Verified');

      await interaction.editReply('✅ Role debug succeeded: Unverified → Verified. Check server roles + console logs.');
    } catch (e) {
      console.error('[role_debug] error:', e);
      await interaction.editReply('❌ Role debug failed. See console for error.');
    }
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (!INTRO_CHANNEL_ID || message.channel.id !== INTRO_CHANNEL_ID) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    const isVerified = member.roles.cache.has(VERIFIED_ROLE_ID);
    const isMember   = member.roles.cache.has(MEMBER_ROLE_ID);
    if (!isVerified) { dlog('[intro] user not Verified, ignoring'); return; }
    if (isMember) { dlog('[intro] already has Member'); return; }

    await safeAddRole(member, MEMBER_ROLE_ID, 'Member (introductions)');

    if (LOG_CHANNEL_ID) {
      const ch = message.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (ch && ch.isTextBased()) {
        ch.send(`👤 ${member} just got the <@&${MEMBER_ROLE_ID}> role for introducing themselves.`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('messageCreate intro error', e);
  }
});

const app = express();
app.use(bodyParser.json());

app.get('/_status', async (_, res) => {
  try {
    const inGuild = client.guilds.cache.has(GUILD_ID);
    const guild = inGuild ? client.guilds.cache.get(GUILD_ID) : null;
    res.json({
      up: true,
      wsStatus: client.ws?.status,
      loggedInAs: client.user ? `${client.user.tag} (${client.user.id})` : null,
      guildId: GUILD_ID,
      inGuild,
      guildName: guild?.name || null,
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/form-webhook', async (req, res) => {
  try {
    const discordIdFromZap = req.body?.discord_id;
    const token =
      req.body?.hidden?.token ||
      req.body?.data?.hidden?.token ||
      req.body?.fields?.token ||
      req.body?.token;

    const discordId = discordIdFromZap || (token ? jwt.verify(token, JWT_SECRET).discordId : null);
    if (!discordId) return res.status(400).send('No discord id');

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
    await safeAddRole(member, VERIFIED_ROLE_ID, 'Verified (form)');

    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e, req.body);
    return res.sendStatus(200);
  }
});

app.post('/form-webhook-fast', (req, res) => {
  res.status(200).send('ok');
  (async () => {
    try {
      console.log('[webhook-fast] body:', JSON.stringify(req.body));
      const discordIdFromZap = req.body?.discord_id;
      const token =
        req.body?.hidden?.token ||
        req.body?.data?.hidden?.token ||
        req.body?.fields?.token ||
        req.body?.token;
      console.log('[webhook-fast] discordIdFromZap:', discordIdFromZap, ' token?', Boolean(token));
      const discordId =
        discordIdFromZap ||
        (token ? jwt.verify(token, JWT_SECRET).discordId : null);
      console.log('[webhook-fast] resolved discordId:', discordId);
      if (!discordId) { console.warn('[webhook-fast] ❌ No discord id'); return; }
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(discordId).catch(e => {
        console.error('[webhook-fast] fetch member failed:', e?.message);
        return null;
      });
      if (!member) { console.warn('[webhook-fast] ❌ Member not in guild'); return; }
      await member.roles.remove(UNVERIFIED_ROLE_ID).catch(e =>
        console.warn('[webhook-fast] remove Unverified:', e?.message)
      );
      await safeAddRole(member, VERIFIED_ROLE_ID, 'Verified (form)');
      console.log('[webhook-fast] ✅ Verified via form:', member.user.tag);
    } catch (e) {
      console.error('[webhook-fast] handler error:', e);
    }
  })();
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Webhook listening on :${PORT}`));

const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.KEEPALIVE_URL ||
  '';
if (PUBLIC_URL) {
  setInterval(() => {
    try { https.get(PUBLIC_URL, () => {}); } catch {}
  }, 4 * 60 * 1000);
  dlog('[keepalive] pinging', PUBLIC_URL);
} else {
  dlog('[keepalive] no PUBLIC_URL set; skipping self-ping');
}

// sanity before login
if (!DISCORD_TOKEN) {
  console.error('[login] ❌ DISCORD_TOKEN is missing in env');
}
if (!GUILD_ID) {
  console.error('[login] ❌ GUILD_ID is missing in env');
}

// make login outcome explicit
client.login(DISCORD_TOKEN)
  .then(() => console.log('[login] ✅ success'))
  .catch((e) => console.error('[login] ❌ failed:', e && (e.code || e.message || e)));
