const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials } = require('discord.js');
const express = require('express');
const cors = require('cors');
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

if (!TOKEN || !GUILD_ID || !CHANNEL_ID || !ROLE_ID || !ROLE_ID2 || !ROLE_ID3 || !WEBHOOK_SECRET) {
  console.error('❌ BŁĄD: Brakuje zmiennych środowiskowych! Sprawdź .env');
  process.exit(1);
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

// Health check (Railway sprawdza czy bot żyje)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user ? client.user.tag : 'łączenie...',
    uptime: process.uptime()
  });
});

// Główny endpoint - odbiera podania ze strony
app.post('/api/submit', async (req, res) => {
  try {
    // Weryfikacja secret
    const authHeader = req.headers['x-webhook-secret'];
    if (authHeader !== WEBHOOK_SECRET) {
      console.log('🚫 Odrzucono request - zły secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = req.body;
    if (!data || !data.answers) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    const answers = data.answers;
    const timestamp = data.timestamp || new Date().toISOString();

    // Pobierz kanał
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      return res.status(500).json({ error: 'Channel not found' });
    }

    // Stwórz embed z podaniem
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

    // Przyciski
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('accept_' + Date.now())
        .setLabel('✅ Zaakceptuj')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('reject_' + Date.now())
        .setLabel('❌ Odrzuć')
        .setStyle(ButtonStyle.Danger)
    );

    const applicationId = Date.now().toString();
    client.applications = client.applications || new Map();
    client.applications.set(applicationId, {
      discordNick: answers.q3,
      timestamp: timestamp
    });

    await channel.send({
      embeds: [embed],
      components: [row]
    });

    console.log('✅ Podanie wysłane na kanał:', CHANNEL_ID);
    res.json({ success: true, applicationId });

  } catch (err) {
    console.error('❌ Błąd podczas przetwarzania podania:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== INTERACTION HANDLER ====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const isAccept = customId.startsWith('accept_');
  const isReject = customId.startsWith('reject_');

  if (!isAccept && !isReject) return;

  try {
    const embed = interaction.message.embeds[0];
    const nickField = embed.fields.find(f => f.name.includes('Nick Discord'));
    const discordNick = nickField ? nickField.value : null;

    if (!discordNick || discordNick === 'Brak') {
      await interaction.reply({
        content: '❌ Nie można znaleźć nicku Discord w podaniu.',
        ephemeral: true
      });
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
      await interaction.reply({
        content: `❌ Nie znaleziono użytkownika **${discordNick}** na serwerze.`,
        ephemeral: true
      });
      return;
    }

    const user = member.user;

    if (isAccept) {
      const role1 = await guild.roles.fetch(ROLE_ID);
      const role2 = await guild.roles.fetch(ROLE_ID2);
      const role3 = await guild.roles.fetch(ROLE_ID3);

      if (!role1 || !role2 || !role3) {
        await interaction.reply({
          content: '❌ Nie znaleziono jednej z ról. Sprawdź ROLE_ID, ROLE_ID_2, ROLE_ID_3 w .env',
          ephemeral: true
        });
        return;
      }

      await member.roles.add([role1, role2, role3]).catch(err => {
        console.error('Błąd nadawania ról:', err);
        throw new Error('Nie udało się nadać ról. Sprawdź hierarchię ról.');
      });

      try {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x28a745)
              .setTitle('✅ Podanie zaakceptowane!')
              .setDescription(`Gratulacje! Twoje podanie do **GDDKiA** zostało **zaakceptowane** przez ${interaction.user.tag}.\n\nNadano Ci role: **${role1.name}**, **${role2.name}**, **${role3.name}**.\n\nZapraszamy na serwer!`)
              .setTimestamp()
          ]
        });
      } catch (dmErr) {
        console.log('Nie udało się wysłać DM do', user.tag);
      }

      await interaction.reply({
        content: `✅ **Zaakceptowano** podanie użytkownika **${user.tag}**. Role **${role1.name}**, **${role2.name}**, **${role3.name}** nadane, DM wysłane.`,
        ephemeral: true
      });

      const updatedEmbed = EmbedBuilder.from(embed)
        .setColor(0x28a745)
        .setTitle('🛣️ Podanie do GDDKiA — ZAAKCEPTOWANE')
        .setDescription(`✅ Zaakceptowane przez ${interaction.user.tag}`)
        .setFooter({ text: `Zaakceptowano: ${new Date().toLocaleString('pl-PL')}` });

      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: []
      });

      console.log('✅ Zaakceptowano podanie użytkownika:', user.tag);

    } else {
      try {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xdc3545)
              .setTitle('❌ Podanie odrzucone')
              .setDescription(`Twoje podanie do **GDDKiA** zostało **odrzucone** przez ${interaction.user.tag}.\n\nMożesz spróbować ponownie w przyszłości.`)
              .setTimestamp()
          ]
        });
      } catch (dmErr) {
        console.log('Nie udało się wysłać DM do', user.tag);
      }

      await interaction.reply({
        content: `❌ **Odrzucono** podanie użytkownika **${user.tag}**. DM wysłane.`,
        ephemeral: true
      });

      const updatedEmbed = EmbedBuilder.from(embed)
        .setColor(0xdc3545)
        .setTitle('🛣️ Podanie do GDDKiA — ODRZUCONE')
        .setDescription(`❌ Odrzucone przez ${interaction.user.tag}`)
        .setFooter({ text: `Odrzucono: ${new Date().toLocaleString('pl-PL')}` });

      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: []
      });

      console.log('❌ Odrzucono podanie użytkownika:', user.tag);
    }

  } catch (err) {
    console.error('❌ Błąd podczas obsługi przycisku:', err);
    await interaction.reply({
      content: `❌ Wystąpił błąd: ${err.message}`,
      ephemeral: true
    }).catch(() => {});
  }
});

// ==================== STARTUP ====================
client.once('clientReady', () => {
  console.log('🤖 Bot GDDKiA jest online!');
  console.log('   Tag:', client.user.tag);
  console.log('   Serwer:', GUILD_ID);
  console.log('   Kanał:', CHANNEL_ID);
  console.log('   Rola:', ROLE_ID);
  console.log('   Webhook:', `http://localhost:${PORT}/api/submit`);
  client.user.setActivity('podania GDDKiA', { type: 3 });
});

app.listen(PORT, () => {
  console.log(`🌐 Webhook nasłuchuje na porcie ${PORT}`);
});

client.login(TOKEN).catch(err => {
  console.error('❌ Błąd logowania bota:', err.message);
  process.exit(1);
});
