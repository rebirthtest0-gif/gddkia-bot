const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, REST, Routes, ChannelType, UserSelectMenuBuilder } = require('discord.js');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
require('dotenv').config();

// ==================== KONFIGURACJA ====================
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID  = process.env.ROLE_ID;
const ROLE_ID2 = process.env.ROLE_ID_2;
const ROLE_ID3 = process.env.ROLE_ID_3;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

// SYSTEM PRACY
const SHIFT_CHANNEL_ID = process.env.SHIFT_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const SHIFT_LOGO_URL = process.env.SHIFT_LOGO_URL;

// SYSTEM TICKETÓW
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const TICKET_CAT_KIEROWNICTWO = process.env.TICKET_CAT_KIEROWNICTWO;
const TICKET_CAT_SKARGA = process.env.TICKET_CAT_SKARGA;
const TICKET_CAT_INNE = process.env.TICKET_CAT_INNE;
const TICKET_LOG_CHANNEL = process.env.TICKET_LOG_CHANNEL;
const TICKET_STAFF_ROLE_1 = process.env.TICKET_STAFF_ROLE_1;
const TICKET_STAFF_ROLE_2 = process.env.TICKET_STAFF_ROLE_2;

// NOWE ZMIENNE KONFIGURACYJNE (z fallbackiem na podane ID)
const RECRUITMENT_ROLE_ID = process.env.RECRUITMENT_ROLE_ID || '1530216178822152388';
const TIME_LOG_CHANNEL_ID = process.env.TIME_LOG_CHANNEL_ID || '1530216180839878894';
const TIME_LOG_PING_ROLE_ID = process.env.TIME_LOG_PING_ROLE_ID || '1530216178834870373';

// BAZA DANYCH — na Railway ustaw DB_PATH=/data/bot.db + Volume pod /data
const DB_PATH = process.env.DB_PATH || './bot.db';

if (!TOKEN || !GUILD_ID || !CHANNEL_ID || !ROLE_ID || !ROLE_ID2 || !ROLE_ID3 || !WEBHOOK_SECRET) {
  console.error('❌ BŁĄD: Brakuje podstawowych zmiennych środowiskowych! Sprawdź .env');
  process.exit(1);
}

// ==================== SQLITE ====================
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS shifts (
    userId TEXT PRIMARY KEY,
    totalSecondsAllTime INTEGER DEFAULT 0,
    weeklySeconds INTEGER DEFAULT 0,
    weeklyShiftCount INTEGER DEFAULT 0,
    currentShift TEXT,
    lastWeekKey TEXT,
    weeklyPoints INTEGER DEFAULT 0,
    totalPoints INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS active_tickets (
    channelId TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    type TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )
`);

// Nowa tabela na raporty pracy
db.exec(`
  CREATE TABLE IF NOT EXISTS work_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    description TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    weekKey TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )
`);

// Migracja: dodaj kolumny punktów jeśli nie istnieją (dla istniejących baz)
const shiftColumns = db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name);
if (!shiftColumns.includes('weeklyPoints')) {
  db.exec('ALTER TABLE shifts ADD COLUMN weeklyPoints INTEGER DEFAULT 0');
}
if (!shiftColumns.includes('totalPoints')) {
  db.exec('ALTER TABLE shifts ADD COLUMN totalPoints INTEGER DEFAULT 0');
}

// ==================== CACHE W PAMIĘCI ====================
const shiftData = new Map();
const activeTickets = new Map();

function dbLoadAll() {
  const shiftRows = db.prepare('SELECT * FROM shifts').all();
  for (const row of shiftRows) {
    shiftData.set(row.userId, {
      totalSecondsAllTime: row.totalSecondsAllTime,
      weeklySeconds: row.weeklySeconds,
      weeklyShiftCount: row.weeklyShiftCount,
      currentShift: row.currentShift ? JSON.parse(row.currentShift) : null,
      lastWeekKey: row.lastWeekKey,
      weeklyPoints: row.weeklyPoints || 0,
      totalPoints: row.totalPoints || 0
    });
  }
  console.log(`📁 Wczytano ${shiftRows.length} rekordów pracy z SQLite`);

  const ticketRows = db.prepare('SELECT * FROM active_tickets').all();
  for (const row of ticketRows) {
    activeTickets.set(row.channelId, {
      ownerId: row.ownerId,
      type: row.type,
      createdAt: row.createdAt
    });
  }
  console.log(`📁 Wczytano ${ticketRows.length} aktywnych ticketów z SQLite`);
}

function dbSaveShift(userId, data) {
  db.prepare(`
    INSERT INTO shifts (userId, totalSecondsAllTime, weeklySeconds, weeklyShiftCount, currentShift, lastWeekKey, weeklyPoints, totalPoints)
    VALUES (@userId, @totalSecondsAllTime, @weeklySeconds, @weeklyShiftCount, @currentShift, @lastWeekKey, @weeklyPoints, @totalPoints)
    ON CONFLICT(userId) DO UPDATE SET
      totalSecondsAllTime = excluded.totalSecondsAllTime,
      weeklySeconds = excluded.weeklySeconds,
      weeklyShiftCount = excluded.weeklyShiftCount,
      currentShift = excluded.currentShift,
      lastWeekKey = excluded.lastWeekKey,
      weeklyPoints = excluded.weeklyPoints,
      totalPoints = excluded.totalPoints
  `).run({
    userId,
    totalSecondsAllTime: data.totalSecondsAllTime,
    weeklySeconds: data.weeklySeconds,
    weeklyShiftCount: data.weeklyShiftCount,
    currentShift: data.currentShift ? JSON.stringify(data.currentShift) : null,
    lastWeekKey: data.lastWeekKey,
    weeklyPoints: data.weeklyPoints || 0,
    totalPoints: data.totalPoints || 0
  });
}

function dbDeleteTicket(channelId) {
  db.prepare('DELETE FROM active_tickets WHERE channelId = ?').run(channelId);
}

function dbSaveTicket(channelId, ticket) {
  db.prepare(`
    INSERT INTO active_tickets (channelId, ownerId, type, createdAt)
    VALUES (@channelId, @ownerId, @type, @createdAt)
    ON CONFLICT(channelId) DO UPDATE SET
      ownerId = excluded.ownerId,
      type = excluded.type,
      createdAt = excluded.createdAt
  `).run({
    channelId,
    ownerId: ticket.ownerId,
    type: ticket.type,
    createdAt: ticket.createdAt
  });
}

// ==================== DISCORD CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ==================== EXPRESS WEBHOOK ====================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'online', bot: client.user ? client.user.tag : 'łączenie...', uptime: process.uptime() });
});

app.post('/api/submit', async (req, res) => {
  try {
    const authHeader = req.headers['x-webhook-secret'];
    if (authHeader !== WEBHOOK_SECRET) {
      console.log('🚫 Odrzucono request - zły secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const data = req.body;
    if (!data || !data.answers) return res.status(400).json({ error: 'Invalid data' });
    const answers = data.answers;
    const timestamp = data.timestamp || new Date().toISOString();
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return res.status(500).json({ error: 'Channel not found' });

    const embed = new EmbedBuilder()
      .setColor(0xf26522)
      .setTitle('🛣️ Nowe podanie do GDDKiA')
      .setDescription('Kliknij przycisk poniżej, aby rozpatrzyć podanie.')
      .addFields(
        { name: '👤 Imię i Nazwisko (IC)', value: answers.q1 || 'Brak', inline: true },
        { name: '🎂 Wiek (OOC)', value: answers.q2 || 'Brak', inline: true },
        { name: '💬 Nick Discord', value: answers.q3 || 'Brak', inline: true },
        { name: '⏰ Godziny dziennie', value: answers.q4 || 'Brak', inline: true },
        { name: '🏢 Poprzednia frakcja', value: answers.q5 || 'Brak', inline: true },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '❓ Dlaczego GDDKiA?', value: (answers.q6 || 'Brak').substring(0, 1024) },
        { name: '📚 Co wiesz o GDDKiA?', value: (answers.q7 || 'Brak').substring(0, 1024) },
        { name: '💪 Mocne strony', value: (answers.q8 || 'Brak').substring(0, 1024) },
        { name: '🌟 Dlaczego Ty?', value: (answers.q9 || 'Brak').substring(0, 1024) },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '🎭 Zachowanie wobec obywatela', value: (answers.q10 || 'Brak').substring(0, 1024) },
        { name: '🛠️ Uszkodzona droga', value: (answers.q11 || 'Brak').substring(0, 1024) },
        { name: '🚧 Zabezpieczenie robót', value: (answers.q12 || 'Brak').substring(0, 1024) },
        { name: '⚠️ Uszkodzony znak', value: (answers.q13 || 'Brak').substring(0, 1024) },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '📋 Polecenie przełożonego', value: (answers.q14 || 'Brak').substring(0, 1024) },
        { name: '✨ Cechy pracownika', value: (answers.q15 || 'Brak').substring(0, 1024) },
        { name: '🤝 Współpraca z frakcjami', value: (answers.q16 || 'Brak').substring(0, 1024) },
        { name: '⚖️ Złamanie regulaminu', value: (answers.q17 || 'Brak').substring(0, 1024) },
        { name: '📝 Przykładowa służba', value: (answers.q18 || 'Brak').substring(0, 1024) },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '✅ Znajomość regulaminu', value: answers.q19 || 'Brak', inline: true },
        { name: '✅ Zobowiązanie do przestrzegania', value: answers.q20 || 'Brak', inline: true }
      )
      .setFooter({ text: `ID podania: ${Date.now()} | ${new Date(timestamp).toLocaleString('pl-PL')}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('accept_' + Date.now()).setLabel('✅ Zaakceptuj').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('reject_' + Date.now()).setLabel('❌ Odrzuć').setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    console.log('✅ Podanie wysłane na kanał:', CHANNEL_ID);
    res.json({ success: true, applicationId: Date.now().toString() });
  } catch (err) {
    console.error('❌ Błąd podczas przetwarzania podania:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== SYSTEM PRACY (SHIFT) ====================
function getWeekKey() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getUserShiftData(userId) {
  if (!shiftData.has(userId)) {
    const currentWeek = getWeekKey();
    const fresh = {
      totalSecondsAllTime: 0,
      weeklySeconds: 0,
      weeklyShiftCount: 0,
      currentShift: null,
      lastWeekKey: currentWeek,
      weeklyPoints: 0,
      totalPoints: 0
    };
    shiftData.set(userId, fresh);
    dbSaveShift(userId, fresh);
  }
  const data = shiftData.get(userId);
  const currentWeek = getWeekKey();
  if (data.lastWeekKey !== currentWeek) {
    data.weeklySeconds = 0;
    data.weeklyShiftCount = 0;
    data.weeklyPoints = 0;
    data.lastWeekKey = currentWeek;
    dbSaveShift(userId, data);
  }
  return data;
}

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function getCurrentSessionMs(data) {
  if (!data.currentShift) return 0;
  if (data.currentShift.isPaused) return data.currentShift.accumulatedMs;
  return data.currentShift.accumulatedMs + (Date.now() - data.currentShift.startTime);
}

function buildShiftEmbed(userId) {
  const data = getUserShiftData(userId);
  const sessionSec = Math.floor(getCurrentSessionMs(data) / 1000);
  const totalWeeklySec = data.weeklySeconds + sessionSec;
  const avgSec = data.weeklyShiftCount > 0 ? Math.floor(data.weeklySeconds / data.weeklyShiftCount) : 0;

  let statusText = '⏹️ Nie rozpoczęta';
  if (data.currentShift) {
    statusText = data.currentShift.isPaused ? '⏸️ Zapauzowana' : '▶️ W trakcie';
  }

  const embed = new EmbedBuilder()
    .setColor(0xf26522)
    .setTitle('Menadżer Pracy')
    .setThumbnail(SHIFT_LOGO_URL || null)
    .addFields(
      { name: '📋 Informacje Główne', value: '\u200B' },
      { name: 'Twoja Praca', value: `${data.weeklyShiftCount} shiftów`, inline: true },
      { name: 'Czas Całkowity Pracy', value: formatTime(totalWeeklySec), inline: true },
      { name: 'Twój Czas Zazwyczaj', value: data.weeklyShiftCount > 0 ? formatTime(avgSec) : 'Brak danych', inline: true },
      { name: '⭐ Punkty (tydzień)', value: String(data.weeklyPoints || 0), inline: true },
      { name: '⭐ Punkty (ogółem)', value: String(data.totalPoints || 0), inline: true },
      { name: 'Status', value: statusText, inline: true }
    )
    .setFooter({ text: `Aktualizacja: ${new Date().toLocaleString('pl-PL')}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`shift_start_${userId}`)
      .setLabel('▶️ Zacznij Pracę')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!!data.currentShift),
    new ButtonBuilder()
      .setCustomId(`shift_pause_${userId}`)
      .setLabel(data.currentShift?.isPaused ? '⏯️ Wznów Pracę' : '⏸️ Zatrzymaj Pracę')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!data.currentShift),
    new ButtonBuilder()
      .setCustomId(`shift_end_${userId}`)
      .setLabel('⏹️ Zakończ Pracę')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!data.currentShift)
  );

  return { embeds: [embed], components: [row] };
}

async function sendWeeklyLeaderboard() {
  if (!LEADERBOARD_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();

    const entries = Array.from(shiftData.entries())
      .map(([userId, data]) => ({ userId, ...data }))
      .filter(e => e.weeklySeconds > 0 || e.weeklyPoints > 0)
      .sort((a, b) => b.weeklySeconds - a.weeklySeconds)
      .slice(0, 5);

    const embed = new EmbedBuilder()
      .setColor(0xf26522)
      .setTitle('📊 Podsumowanie tygodnia GDDKiA')
      .setDescription('TOP 5 pracowników według czasu pracy w tym tygodniu')
      .setThumbnail(SHIFT_LOGO_URL || null)
      .setTimestamp();

    if (entries.length === 0) {
      embed.setDescription('Brak danych do wyświetlenia.');
    } else {
      entries.forEach((entry, index) => {
        const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index];
        const member = guild.members.cache.get(entry.userId);
        const displayName = member ? (member.displayName || member.user.username) : 'Nieznany użytkownik';
        const roles = member ? member.roles.cache
          .filter(r => r.id !== guild.id)
          .sort((a, b) => b.position - a.position)
          .first(3)
          .map(r => r.name)
          .join(', ') || 'Brak ról' : 'Brak ról';

        embed.addFields({
          name: `${medal} ${displayName}`,
          value: `Czas: **${formatTime(entry.weeklySeconds)}** | Shiftów: **${entry.weeklyShiftCount}** | Punkty: **${entry.weeklyPoints || 0}**\nRole: ${roles}`,
          inline: false
        });
      });
    }

    await channel.send({ embeds: [embed] });

    const currentWeek = getWeekKey();
    for (const [userId, data] of shiftData) {
      data.weeklySeconds = 0;
      data.weeklyShiftCount = 0;
      data.weeklyPoints = 0;
      data.lastWeekKey = currentWeek;
      dbSaveShift(userId, data);
    }
    console.log('📊 Wysłano tabelę tygodniową i zresetowano dane.');
  } catch (err) {
    console.error('Błąd wysyłania leaderboard:', err);
  }
}

// ==================== SYSTEM TICKETÓW ====================
function hasStaffRole(member) {
  if (!TICKET_STAFF_ROLE_1 && !TICKET_STAFF_ROLE_2) return false;
  const r1 = TICKET_STAFF_ROLE_1 ? member.roles.cache.has(TICKET_STAFF_ROLE_1) : false;
  const r2 = TICKET_STAFF_ROLE_2 ? member.roles.cache.has(TICKET_STAFF_ROLE_2) : false;
  return r1 || r2;
}

function buildTicketEmbed() {
  return new EmbedBuilder()
    .setColor(0xf26522)
    .setTitle('🎫 Ticket')
    .setDescription('Witamy! Twój ticket zostanie niebawem rozpatrzony. Prosimy o cierpliwość.')
    .setFooter({ text: `Utworzono: ${new Date().toLocaleString('pl-PL')}` })
    .setTimestamp();
}

function buildTicketButtons(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_add_${channelId}`)
      .setLabel('➕ Dodaj Osobę')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket_close_${channelId}`)
      .setLabel('🔒 Zamknij Ticket')
      .setStyle(ButtonStyle.Danger)
  );
}

async function sendTicketPanel() {
  if (!TICKET_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(TICKET_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0xf26522)
      .setTitle('🎫 System Ticketów GDDKiA')
      .setDescription('Wybierz odpowiedni rodzaj ticketu, klikając przycisk poniżej.')
      .setThumbnail(SHIFT_LOGO_URL || null)
      .setFooter({ text: 'GDDKiA Katowice RP' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open_kierownictwo').setLabel('📝 Ticket Kierownictwo').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket_open_skarga').setLabel('⚠️ Ticket Skarga').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket_open_inne').setLabel('❓ Ticket Inne').setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ embeds: [embed], components: [row] });
    console.log('✅ Wysłano panel ticketów na kanał:', TICKET_CHANNEL_ID);
  } catch (err) {
    console.error('Błąd wysyłania panelu ticketów:', err);
  }
}

async function createTicket(interaction, type) {
  if (!TICKET_CAT_KIEROWNICTWO || !TICKET_CAT_SKARGA || !TICKET_CAT_INNE) {
    return interaction.reply({ content: '❌ System ticketów nie jest w pełni skonfigurowany.', ephemeral: true });
  }

  const guild = interaction.guild;
  const user = interaction.user;

  for (const [chId, ticket] of activeTickets) {
    if (ticket.ownerId === user.id && ticket.type === type) {
      return interaction.reply({ content: `❌ Masz już otwarty ticket tego typu: <#${chId}>`, ephemeral: true });
    }
  }

  let categoryId;
  let channelName;
  switch (type) {
    case 'kierownictwo':
      categoryId = TICKET_CAT_KIEROWNICTWO;
      channelName = `kontakt-kierownictwo-${user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 90);
      break;
    case 'skarga':
      categoryId = TICKET_CAT_SKARGA;
      channelName = `skarga-${user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 90);
      break;
    case 'inne':
      categoryId = TICKET_CAT_INNE;
      channelName = `inny-powod-${user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 90);
      break;
  }

  try {
    const permissionOverwrites = [
      { id: guild.id, deny: ['ViewChannel'] },
      { id: user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'] },
      { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels'] }
    ];
    if (TICKET_STAFF_ROLE_1) permissionOverwrites.push({ id: TICKET_STAFF_ROLE_1, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'] });
    if (TICKET_STAFF_ROLE_2) permissionOverwrites.push({ id: TICKET_STAFF_ROLE_2, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'] });

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites
    });

    const ticketData = { ownerId: user.id, type, createdAt: Date.now() };
    activeTickets.set(ticketChannel.id, ticketData);
    dbSaveTicket(ticketChannel.id, ticketData);

    const embed = buildTicketEmbed();
    const buttons = buildTicketButtons(ticketChannel.id);

    await ticketChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: [buttons] });
    await interaction.reply({ content: `✅ Ticket utworzony: <#${ticketChannel.id}>`, ephemeral: true });
  } catch (err) {
    console.error('Błąd tworzenia ticketu:', err);
    await interaction.reply({ content: '❌ Nie udało się utworzyć ticketu.', ephemeral: true });
  }
}

async function closeTicket(interaction, channelId) {
  const ticket = activeTickets.get(channelId);
  if (!ticket) {
    return interaction.reply({ content: '❌ Ten ticket nie jest już aktywny.', ephemeral: true });
  }

  const member = interaction.member;
  if (!hasStaffRole(member)) {
    return interaction.reply({ content: '❌ Nie masz uprawnień do zamykania ticketów.', ephemeral: true });
  }

  try {
    const guild = interaction.guild;
    const channel = await client.channels.fetch(channelId);
    const owner = await client.users.fetch(ticket.ownerId);

    if (TICKET_LOG_CHANNEL) {
      const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0xdc3545)
          .setTitle('🔒 Ticket Zamknięty')
          .addFields(
            { name: 'Kanał', value: `#${channel.name}`, inline: true },
            { name: 'Typ', value: ticket.type, inline: true },
            { name: 'Właściciel', value: `<@${ticket.ownerId}>`, inline: true },
            { name: 'Zamknięty przez', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Data zamknięcia', value: new Date().toLocaleString('pl-PL'), inline: true }
          )
          .setTimestamp();
        await logChannel.send({ embeds: [logEmbed] });
      }
    }

    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xdc3545)
        .setTitle('🔒 Ticket Zamknięty')
        .setDescription(`Twój ticket **#${channel.name}** został zamknięty przez <@${interaction.user.id}>.`)
        .setFooter({ text: `Zamknięto: ${new Date().toLocaleString('pl-PL')}` })
        .setTimestamp();
      await owner.send({ embeds: [dmEmbed] });
    } catch (e) { console.log('Nie udało się wysłać DM o zamknięciu ticketu do', owner.tag); }

    activeTickets.delete(channelId);
    dbDeleteTicket(channelId);

    await interaction.reply({ content: '🔒 Ticket zostanie zamknięty...', ephemeral: true });
    setTimeout(() => channel.delete().catch(() => {}), 3000);
  } catch (err) {
    console.error('Błąd zamykania ticketu:', err);
    await interaction.reply({ content: '❌ Wystąpił błąd podczas zamykania ticketu.', ephemeral: true });
  }
}

// ==================== INTERACTION HANDLER ====================
client.on('interactionCreate', async (interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'praca') {
      if (!SHIFT_CHANNEL_ID || interaction.channelId !== SHIFT_CHANNEL_ID) {
        return interaction.reply({ content: '❌ Ta komenda działa tylko na wyznaczonym kanale służbowym.', ephemeral: true });
      }
      const payload = buildShiftEmbed(interaction.user.id);
      return interaction.reply({ ...payload, ephemeral: false });
    }

    if (interaction.commandName === 'sprawdz') {
      const target = interaction.options.getUser('osoba') || interaction.user;
      const data = getUserShiftData(target.id);
      const sessionSec = Math.floor(getCurrentSessionMs(data) / 1000);

      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(target.id).catch(() => null);
      const displayName = member ? (member.displayName || member.user.username) : target.username;
      const roles = member ? member.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .first(3)
        .map(r => r.name)
        .join(', ') || 'Brak ról' : 'Brak ról';

      const embed = new EmbedBuilder()
        .setColor(0xf26522)
        .setTitle('📋 Statystyki Pracy')
        .setThumbnail(SHIFT_LOGO_URL || null)
        .addFields(
          { name: 'Użytkownik', value: `${displayName}\nRole: ${roles}`, inline: false },
          { name: '📅 Ten tydzień', value: formatTime(data.weeklySeconds + sessionSec), inline: true },
          { name: '📊 Ogółem', value: formatTime(data.totalSecondsAllTime + sessionSec), inline: true },
          { name: '🔢 Shiftów w tym tygodniu', value: String(data.weeklyShiftCount), inline: true },
          { name: '⭐ Punkty (tydzień)', value: String(data.weeklyPoints || 0), inline: true },
          { name: '⭐ Punkty (ogółem)', value: String(data.totalPoints || 0), inline: true }
        )
        .setFooter({ text: `Sprawdzone: ${new Date().toLocaleString('pl-PL')}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'ticketsetup') {
      if (!interaction.memberPermissions.has('Administrator')) {
        return interaction.reply({ content: '❌ Tylko administrator może użyć tej komendy.', ephemeral: true });
      }
      await sendTicketPanel();
      return interaction.reply({ content: '✅ Panel ticketów został wysłany.', ephemeral: true });
    }

    // ===== NOWA KOMENDA /RAPORT =====
    if (interaction.commandName === 'raport') {
      const description = interaction.options.getString('opis');
      const points = interaction.options.getInteger('punkty') || 1;

      const data = getUserShiftData(interaction.user.id);
      data.weeklyPoints = (data.weeklyPoints || 0) + points;
      data.totalPoints = (data.totalPoints || 0) + points;
      dbSaveShift(interaction.user.id, data);

      db.prepare(`
        INSERT INTO work_reports (userId, description, points, weekKey, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(interaction.user.id, description, points, getWeekKey(), Date.now());

      return interaction.reply({ content: `✅ Raport zapisany! Opis: "${description}" | Punkty: +${points}`, ephemeral: true });
    }

    // ===== NOWA KOMENDA /ZARZĄDZAJ-CZASEM =====
    if (interaction.commandName === 'zarzadzaj-czasem') {
      const requiredRole = RECRUITMENT_ROLE_ID;
      const hasRole = interaction.member.roles.cache.has(requiredRole);
      const isAdmin = interaction.memberPermissions.has('Administrator');
      if (!hasRole && !isAdmin) {
        return interaction.reply({ content: '❌ Nie masz uprawnień do zarządzania czasem pracy.', ephemeral: true });
      }

      const targetUser = interaction.options.getUser('osoba');
      const action = interaction.options.getString('akcja');
      const minutes = interaction.options.getInteger('minuty');
      const reason = interaction.options.getString('powod');

      const data = getUserShiftData(targetUser.id);
      const seconds = minutes * 60;
      const oldWeekly = data.weeklySeconds;
      const oldTotal = data.totalSecondsAllTime;

      if (action === 'dodaj') {
        data.weeklySeconds += seconds;
        data.totalSecondsAllTime += seconds;
      } else {
        data.weeklySeconds = Math.max(0, data.weeklySeconds - seconds);
        data.totalSecondsAllTime = Math.max(0, data.totalSecondsAllTime - seconds);
      }

      dbSaveShift(targetUser.id, data);

      // Wyślij log na kanał
      try {
        const logChannel = await client.channels.fetch(TIME_LOG_CHANNEL_ID);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(action === 'dodaj' ? 0x28a745 : 0xdc3545)
            .setTitle(action === 'dodaj' ? '➕ Dodano czas pracy' : '➖ Odjęto czas pracy')
            .addFields(
              { name: 'Administrator', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Pracownik', value: `<@${targetUser.id}>`, inline: true },
              { name: 'Wartość', value: `${minutes} minut (${formatTime(seconds)})`, inline: true },
              { name: 'Czas tygodniowy (przed)', value: formatTime(oldWeekly), inline: true },
              { name: 'Czas tygodniowy (po)', value: formatTime(data.weeklySeconds), inline: true },
              { name: 'Czas całkowity (przed)', value: formatTime(oldTotal), inline: true },
              { name: 'Czas całkowity (po)', value: formatTime(data.totalSecondsAllTime), inline: true },
              { name: 'Powód', value: reason, inline: false }
            )
            .setTimestamp();

          await logChannel.send({ content: `<@&${TIME_LOG_PING_ROLE_ID}>`, embeds: [logEmbed] });
        }
      } catch (err) {
        console.error('Błąd wysyłania logu zmiany czasu:', err);
      }

      return interaction.reply({
        content: `✅ ${action === 'dodaj' ? 'Dodano' : 'Odjęto'} ${minutes} minut dla <@${targetUser.id}>.\nPowód: ${reason}`,
        ephemeral: true
      });
    }
  }

  // Buttons
  if (!interaction.isButton()) return;

  // Ticket open buttons
  if (interaction.customId.startsWith('ticket_open_')) {
    const type = interaction.customId.replace('ticket_open_', '');
    return createTicket(interaction, type);
  }

  // Ticket close button
  if (interaction.customId.startsWith('ticket_close_')) {
    const channelId = interaction.customId.replace('ticket_close_', '');
    return closeTicket(interaction, channelId);
  }

  // Ticket add user button
  if (interaction.customId.startsWith('ticket_add_')) {
    const channelId = interaction.customId.replace('ticket_add_', '');
    const member = interaction.member;
    if (!hasStaffRole(member)) {
      return interaction.reply({ content: '❌ Nie masz uprawnień do dodawania osób do ticketów.', ephemeral: true });
    }

    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`ticket_select_add_${channelId}`)
        .setPlaceholder('Wybierz użytkownika do dodania')
        .setMinValues(1)
        .setMaxValues(1)
    );

    return interaction.reply({ content: 'Wybierz użytkownika, którego chcesz dodać do ticketu:', components: [row], ephemeral: true });
  }

  // Shift buttons
  if (interaction.customId.startsWith('shift_')) {
    const [, action, userId] = interaction.customId.split('_');
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ Nie możesz zarządzać cudzą pracą.', ephemeral: true });
    }

    const data = getUserShiftData(userId);

    if (action === 'start') {
      if (data.currentShift) return interaction.reply({ content: '❌ Masz już rozpoczętą pracę.', ephemeral: true });
      data.currentShift = { startTime: Date.now(), accumulatedMs: 0, isPaused: false, pauseStart: null };
      dbSaveShift(userId, data);
    } else if (action === 'pause') {
      if (!data.currentShift) return interaction.reply({ content: '❌ Nie masz rozpoczętej pracy.', ephemeral: true });
      if (data.currentShift.isPaused) {
        data.currentShift.startTime = Date.now();
        data.currentShift.isPaused = false;
        data.currentShift.pauseStart = null;
      } else {
        data.currentShift.accumulatedMs += Date.now() - data.currentShift.startTime;
        data.currentShift.isPaused = true;
        data.currentShift.pauseStart = Date.now();
      }
      dbSaveShift(userId, data);
    } else if (action === 'end') {
      if (!data.currentShift) return interaction.reply({ content: '❌ Nie masz rozpoczętej pracy.', ephemeral: true });
      const sessionMs = getCurrentSessionMs(data);
      const sessionSec = Math.floor(sessionMs / 1000);
      data.totalSecondsAllTime += sessionSec;
      data.weeklySeconds += sessionSec;
      data.weeklyShiftCount += 1;
      data.currentShift = null;
      dbSaveShift(userId, data);
    }

    const payload = buildShiftEmbed(userId);
    return interaction.update(payload);
  }

  // Application buttons (accept/reject)
  const customId = interaction.customId;
  const isAccept = customId.startsWith('accept_');
  const isReject = customId.startsWith('reject_');
  if (!isAccept && !isReject) return;

  // ===== SPRAWDZENIE ROLI PRZY PODANIACH =====
  const hasRecruitmentRole = interaction.member.roles.cache.has(RECRUITMENT_ROLE_ID);
  const isAdmin = interaction.memberPermissions.has('Administrator');
  if (!hasRecruitmentRole && !isAdmin) {
    return interaction.reply({ content: '❌ Nie masz uprawnień do obsługi podań.', ephemeral: true });
  }

  try {
    const embed = interaction.message.embeds[0];
    const nickField = embed.fields.find(f => f.name.includes('Nick Discord'));
    const discordNick = nickField ? nickField.value : null;
    if (!discordNick || discordNick === 'Brak') {
      await interaction.reply({ content: '❌ Nie można znaleźć nicku Discord w podaniu.', ephemeral: true });
      return;
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    const member = members.find(m =>
      m.user.username.toLowerCase() === discordNick.toLowerCase() ||
      m.user.tag.toLowerCase() === discordNick.toLowerCase() ||
      m.user.globalName?.toLowerCase() === discordNick.toLowerCase() ||
      m.displayName.toLowerCase() === discordNick.toLowerCase()
    );

    if (!member) {
      await interaction.reply({ content: `❌ Nie znaleziono użytkownika **${discordNick}** na serwerze.`, ephemeral: true });
      return;
    }

    const user = member.user;

    if (isAccept) {
      const role1 = await guild.roles.fetch(ROLE_ID);
      const role2 = await guild.roles.fetch(ROLE_ID2);
      const role3 = await guild.roles.fetch(ROLE_ID3);
      if (!role1 || !role2 || !role3) {
        await interaction.reply({ content: '❌ Nie znaleziono jednej z ról. Sprawdź ROLE_ID, ROLE_ID_2, ROLE_ID_3 w .env', ephemeral: true });
        return;
      }
      await member.roles.add([role1, role2, role3]).catch(err => {
        console.error('Błąd nadawania ról:', err);
        throw new Error('Nie udało się nadać ról. Sprawdź hierarchię ról.');
      });
      try {
        await user.send({
          embeds: [new EmbedBuilder().setColor(0x28a745).setTitle('✅ Podanie zaakceptowane!')
            .setDescription(`Gratulacje! Twoje podanie do **GDDKiA** zostało **zaakceptowane** przez ${interaction.user.tag}.\n\nNadano Ci role: **${role1.name}**, **${role2.name}**, **${role3.name}**.\n\nZapraszamy na serwer!`).setTimestamp()]
        });
      } catch (dmErr) { console.log('Nie udało się wysłać DM do', user.tag); }
      await interaction.reply({ content: `✅ **Zaakceptowano** podanie użytkownika **${user.tag}**. Role **${role1.name}**, **${role2.name}**, **${role3.name}** nadane, DM wysłane.`, ephemeral: true });
      const updatedEmbed = EmbedBuilder.from(embed).setColor(0x28a745).setTitle('🛣️ Podanie do GDDKiA — ZAAKCEPTOWANE')
        .setDescription(`✅ Zaakceptowane przez ${interaction.user.tag}`).setFooter({ text: `Zaakceptowano: ${new Date().toLocaleString('pl-PL')}` });
      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      console.log('✅ Zaakceptowano podanie użytkownika:', user.tag);
    } else {
      try {
        await user.send({
          embeds: [new EmbedBuilder().setColor(0xdc3545).setTitle('❌ Podanie odrzucone')
            .setDescription(`Twoje podanie do **GDDKiA** zostało **odrzucone** przez ${interaction.user.tag}.\n\nMożesz spróbować ponownie w przyszłości.`).setTimestamp()]
        });
      } catch (dmErr) { console.log('Nie udało się wysłać DM do', user.tag); }
      await interaction.reply({ content: `❌ **Odrzucono** podanie użytkownika **${user.tag}**. DM wysłane.`, ephemeral: true });
      const updatedEmbed = EmbedBuilder.from(embed).setColor(0xdc3545).setTitle('🛣️ Podanie do GDDKiA — ODRZUCONE')
        .setDescription(`❌ Odrzucone przez ${interaction.user.tag}`).setFooter({ text: `Odrzucono: ${new Date().toLocaleString('pl-PL')}` });
      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      console.log('❌ Odrzucono podanie użytkownika:', user.tag);
    }
  } catch (err) {
    console.error('❌ Błąd podczas obsługi przycisku:', err);
    await interaction.reply({ content: `❌ Wystąpił błąd: ${err.message}`, ephemeral: true }).catch(() => {});
  }
});

// UserSelectMenu handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isUserSelectMenu()) return;
  if (!interaction.customId.startsWith('ticket_select_add_')) return;

  const channelId = interaction.customId.replace('ticket_select_add_', '');
  const ticket = activeTickets.get(channelId);
  if (!ticket) {
    return interaction.reply({ content: '❌ Ten ticket nie jest już aktywny.', ephemeral: true });
  }

  if (!hasStaffRole(interaction.member)) {
    return interaction.reply({ content: '❌ Nie masz uprawnień.', ephemeral: true });
  }

  const selectedUserId = interaction.values[0];
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.permissionOverwrites.create(selectedUserId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true
    });
    await interaction.reply({ content: `✅ Dodano <@${selectedUserId}> do ticketu.`, ephemeral: true });
  } catch (err) {
    console.error('Błąd dodawania użytkownika do ticketu:', err);
    await interaction.reply({ content: '❌ Nie udało się dodać użytkownika.', ephemeral: true });
  }
});

// ==================== STARTUP ====================
client.once('ready', async () => {
  console.log('🤖 Bot GDDKiA jest online!');
  console.log('   Tag:', client.user.tag);
  console.log('   Serwer:', GUILD_ID);
  console.log('   Kanał podań:', CHANNEL_ID);
  console.log('   Kanał pracy:', SHIFT_CHANNEL_ID || 'NIEUSTAWIONY');
  console.log('   Kanał tabeli:', LEADERBOARD_CHANNEL_ID || 'NIEUSTAWIONY');
  console.log('   Kanał ticketów:', TICKET_CHANNEL_ID || 'NIEUSTAWIONY');
  console.log('   Kanał logów czasu:', TIME_LOG_CHANNEL_ID);
  console.log('   Rola rekrutacyjna:', RECRUITMENT_ROLE_ID);
  console.log('   Baza danych:', DB_PATH);
  console.log('   Webhook:', `http://localhost:${PORT}/api/submit`);
  client.user.setActivity('podania GDDKiA', { type: 3 });

  dbLoadAll();

  // Rejestracja slash commands
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const commands = [
      {
        name: 'praca',
        description: 'Menadżer Pracy - system służbowy GDDKiA',
        dm_permission: false
      },
      {
        name: 'sprawdz',
        description: 'Sprawdź czas pracy użytkownika',
        options: [
          {
            name: 'osoba',
            description: 'Wybierz osobę do sprawdzenia (pozostaw puste, aby sprawdzić siebie)',
            type: 6,
            required: false
          }
        ],
        dm_permission: false
      },
      {
        name: 'ticketsetup',
        description: 'Wyślij panel ticketów na kanał (tylko admin)',
        dm_permission: false
      },
      {
        name: 'raport',
        description: 'Zgłoś wykonaną pracę / czynność (wpływa na leaderboard)',
        options: [
          {
            name: 'opis',
            description: 'Opis wykonanej pracy',
            type: 3,
            required: true
          },
          {
            name: 'punkty',
            description: 'Ilość punktów (domyślnie 1, może być ujemna)',
            type: 4,
            required: false
          }
        ],
        dm_permission: false
      },
      {
        name: 'zarzadzaj-czasem',
        description: 'Dodaj lub odejmij czas pracy użytkownikowi',
        options: [
          {
            name: 'osoba',
            description: 'Wybierz osobę',
            type: 6,
            required: true
          },
          {
            name: 'akcja',
            description: 'Wybierz akcję',
            type: 3,
            required: true,
            choices: [
              { name: 'Dodaj czas', value: 'dodaj' },
              { name: 'Odejmij czas', value: 'odejmij' }
            ]
          },
          {
            name: 'minuty',
            description: 'Ilość minut',
            type: 4,
            required: true,
            min_value: 1
          },
          {
            name: 'powod',
            description: 'Powód zmiany',
            type: 3,
            required: true
          }
        ],
        dm_permission: false
      }
    ];
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅ Zarejestrowano komendy slash: /praca, /sprawdz, /ticketsetup, /raport, /zarzadzaj-czasem');
  } catch (err) {
    console.error('❌ Błąd rejestracji komend:', err);
  }

  if (TICKET_CHANNEL_ID) {
    setTimeout(() => sendTicketPanel(), 3000);
  }

  setTimeout(() => {
    const currentWeek = getWeekKey();
    for (const data of shiftData.values()) {
      if (data.lastWeekKey !== currentWeek) {
        sendWeeklyLeaderboard();
        return;
      }
    }
  }, 5000);

  setInterval(() => {
    const currentWeek = getWeekKey();
    for (const data of shiftData.values()) {
      if (data.lastWeekKey !== currentWeek) {
        sendWeeklyLeaderboard();
        return;
      }
    }
  }, 60 * 60 * 1000);
});

app.listen(PORT, () => {
  console.log(`🌐 Webhook nasłuchuje na porcie ${PORT}`);
});

client.login(TOKEN).catch(err => {
  console.error('❌ Błąd logowania bota:', err.message);
  process.exit(1);
});
