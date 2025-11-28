import 'dotenv/config';   // ← this replaces the require line

import express from 'express';
// ... rest of your imports (also use import, not require)


const express = require('express');
const cors = require('cors');
const { Low, JSONFile } = require('lowdb');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const adapter = new JSONFile('db.json');
const db = new Low(adapter);
await db.read();
db.data ||= { entries: [], tenMinDraws: {}, lastDrawCheck: null };
await db.write();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = [123456789]; // ⚠️ PUT YOUR TELEGRAM USER ID HERE
const START_DATE = new Date('2025-11-28T00:00:00'); // Launch date

// Telegram WebApp data validation
function validateTelegramInitData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calculatedHash !== hash) return null;
  return JSON.parse(urlParams.get('user'));
}

// Current 10-min draw info
function getCurrent10MinDraw(now = new Date()) {
  const diffMs = now - START_DATE;
  if (diffMs < 0) return null;
  const intervals = Math.floor(diffMs / (10 * 60 * 1000));
  const drawNumber = String(intervals + 1).padStart(4, '0');
  const slotStart = new Date(START_DATE.getTime() + intervals * 600000);
  const minuteInSlot = Math.floor((now - slotStart) / 60000);

  let state = 'entry';
  if (minuteInSlot >= 8) state = 'announcing';
  else if (minuteInSlot >= 7) state = 'closed';

  const isPickTime = minuteInSlot === 8 && now.getSeconds() < 30;

  return { drawNumber, state, isPickTime, slotStart };
}

// Auto pick winner every 10 seconds (will catch :08 exactly)
setInterval(async () => {
  try {
    await db.read();
    const info = getCurrent10MinDraw();
    if (!info || !info.isPickTime) return;

    const drawRecord = db.data.tenMinDraws[info.drawNumber] || {};
    if (drawRecord.pickedAt) return;

    const entriesThisDraw = db.data.entries.filter(e => e.drawNumber === info.drawNumber);
    if (entriesThisDraw.length === 0) {
      drawRecord.message = "No Winner Selected Due To Non-Participation";
    } else {
      const winner = entriesThisDraw[Math.floor(Math.random() * entriesThisDraw.length)];
      drawRecord.winnerTicket = winner.ticketNumber;
      drawRecord.winnerDetails = {
        username: winner.username,
        phone: winner.phone,
        question: winner.secretQuestion,
        answer: winner.secretAnswer
      };
    }
    drawRecord.pickedAt = new Date().toISOString();
    db.data.tenMinDraws[info.drawNumber] = drawRecord;
    await db.write();
  } catch (e) { console.error(e); }
}, 10000);

// ============ API ENDPOINTS ============

app.post('/submit-entry', async (req, res) => {
  const { initData, giveawayType, username, phone, secretQuestion, secretAnswer } = req.body;
  const tgUser = validateTelegramInitData(initData);
  if (!tgUser) return res.status(403).json({ success: false, error: 'Invalid Telegram data' });

  if (giveawayType !== '10min') return res.json({ success: false, error: 'Giveaway not active' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  const now = new Date();
  const draw = getCurrent10MinDraw(now);
  if (!draw || draw.state !== 'entry') return res.json({ success: false, error: 'Entry closed for current draw' });

  const ipEntries = db.data.entries.filter(e => e.ip === ip && e.drawNumber === draw.drawNumber);
  if (ipEntries.length >= 10) return res.json({ success: false, error: 'Max 10 tickets per IP per draw' });

  // Generate unique 15-digit ticket
  let ticketNumber;
  do {
    ticketNumber = Math.floor(Math.random() * 1e15).toString().padStart(15, '0');
  } while (db.data.entries.some(e => e.ticketNumber === ticketNumber && e.drawNumber === draw.drawNumber));

  db.data.entries.push({
    drawType: '10min',
    drawNumber: draw.drawNumber,
    ticketNumber,
    username, phone, secretQuestion, secretAnswer,
    ip, userId: tgUser.id,
    timestamp: now.toISOString()
  });
  await db.write();

  res.json({ success: true, ticketNumber, drawNumber: draw.drawNumber });
});

app.get('/winners', async (req, res) => {
  await db.read();
  let page = parseInt(req.query.page) || 1;
  const pageSize = 20;
  const keys = Object.keys(db.data.tenMinDraws).sort((a, b) => parseInt(b) - parseInt(a));
  const start = (page - 1) * pageSize;
  const selected = keys.slice(start, start + pageSize);

  const winners = selected.map(key => {
    const num = parseInt(key);
    const time = new Date(START_DATE.getTime() + (num - 1) * 600000).toLocaleString('en-GB');
    const rec = db.data.tenMinDraws[key];
    return {
      drawNumber: key,
      time,
      winnerTicket: rec.winnerTicket || null,
      message: rec.message || (rec.winnerTicket ? null : 'No Winner')
    };
  });

  res.json({ winners, hasMore: start + pageSize < keys.length });
});

app.get('/winner-detail', async (req, res) => {
  await db.read();
  const draw = req.query.draw;
  const rec = db.data.tenMinDraws[draw];
  if (!rec) return res.json({ message: 'Draw not found' });
  res.json(rec);
});

// Admin-only endpoint example (you can add more)
app.post('/admin/auth', (req, res) => {
  const tgUser = validateTelegramInitData(req.body.initData);
  if (tgUser && ADMIN_IDS.includes(tgUser.id)) {
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
