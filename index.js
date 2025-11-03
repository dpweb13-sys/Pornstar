/**
 * index.js
 * Single-file Telegram SMM Bot (Telegraf + MongoDB)
 *
 * All features preserved. Only syntax fixes applied.
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(x=>Number(x));
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID ? Number(process.env.GROUP_CHAT_ID) : null;
const VIRALSMM_API_URL = process.env.VIRALSMM_API_URL || 'https://viralsmm.in/api/v2';
const VIRALSMM_API_KEY = process.env.VIRALSMM_API_KEY || '';
const STATUS_CHECK_INTERVAL_MIN = Number(process.env.STATUS_CHECK_INTERVAL_MIN || 5);
const BACKUP_PATH = process.env.BACKUP_PATH || './backups';
const QR_IMAGE_PATH = process.env.QR_IMAGE_PATH || './qr.png';
const BOT_USERNAME = process.env.BOT_USERNAME || '@YourBotUsername';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '@AdminUsername';
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN || !MONGO_URI) {
  console.error('Missing BOT_TOKEN or MONGO_URI in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- MongoDB ----------
const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
let db, Users, Orders, Settings, BroadcastLogs;

async function initDb() {
  await client.connect();
  db = client.db(process.env.DB_NAME || 'smm_bot_db');
  Users = db.collection('users');
  Orders = db.collection('orders');
  Settings = db.collection('settings');
  BroadcastLogs = db.collection('broadcast_logs');

  // default settings if not exist
  const defaults = [
    { key: 'price_like_per_1k', value: 1.2 },   // default ₹1.2 per 1k likes
    { key: 'price_view_per_1k', value: 0.9 },   // default ₹0.9 per 1k views
    { key: 'service_likes', value: 11505 },     // default service id
    { key: 'service_views', value: 10695 },
    { key: 'group_chat_id', value: GROUP_CHAT_ID || null }
  ];
  for (const d of defaults) {
    const ex = await Settings.findOne({ key: d.key });
    if (!ex) await Settings.insertOne(d);
  }
}

// helper get/set setting
async function getSetting(key) {
  const doc = await Settings.findOne({ key });
  return doc ? doc.value : null;
}
async function setSetting(key, value) {
  await Settings.updateOne({ key }, { $set: { value } }, { upsert: true });
}

// ---------- Utilities ----------
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}
function nowStr() { return new Date().toLocaleString(); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------- Provider API wrapper (simple POST form) ----------
async function providerOrder(service, link, quantity) {
  try {
    const body = new URLSearchParams();
    body.append('key', VIRALSMM_API_KEY);
    body.append('action', 'add');
    body.append('service', String(service));
    body.append('link', link);
    body.append('quantity', String(quantity));
    const res = await fetch(VIRALSMM_API_URL, { method: 'POST', body });
    const json = await res.json();
    return json;
  } catch (e) {
    console.error('providerOrder error:', e);
    return null;
  }
}
async function providerStatus(orderId) {
  try {
    const body = new URLSearchParams();
    body.append('key', VIRALSMM_API_KEY);
    body.append('action', 'status');
    body.append('order', String(orderId));
    const res = await fetch(VIRALSMM_API_URL, { method: 'POST', body });
    const json = await res.json();
    return json;
  } catch (e) {
    console.error('providerStatus error:', e);
    return null;
  }
}

// ---------- Bot keyboards ----------
const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('💰 Add Fund', 'ADD_FUND'), Markup.button.callback('💞 Likes', 'SERVICE_LIKES')],
  [Markup.button.callback('👀 Views', 'SERVICE_VIEWS'), Markup.button.callback('📦 My Orders', 'MY_ORDERS')],
  [Markup.button.callback('👤 Profile', 'MY_PROFILE'), Markup.button.callback('💬 Support', 'SUPPORT')]
]);

// ---------- Command: /start ----------
bot.start(async (ctx) => {
  await Users.updateOne({ user_id: ctx.from.id }, { $setOnInsert: {
    user_id: ctx.from.id,
    username: ctx.from.username || null,
    balance: 0,
    total_spent: 0,
    joined_at: new Date(),
    banned: false
  }}, { upsert: true });
  await ctx.replyWithMarkdown(`👋 *Welcome!* \nUse buttons below to operate the bot.`, mainKeyboard);
});

// ---------- Add Fund flow ----------
bot.action('ADD_FUND', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Please enter the *amount* you want to add (minimum ₹10).', { parse_mode: 'Markdown' });
  await Users.updateOne({ user_id: ctx.from.id }, { $set: { expecting_amount: true } });
});

bot.on('text', async (ctx, next) => {
  const user = await Users.findOne({ user_id: ctx.from.id });
  if (user && user.expecting_amount) {
    const text = ctx.message.text.trim();
    const amount = Number(text);
    if (!amount || amount < 10) {
      await ctx.reply('❌ Invalid amount. Enter a number (minimum ₹10).');
      return;
    }
    await Users.updateOne({ user_id: ctx.from.id }, { $set: { pending_payment: { amount, ts: new Date() }, expecting_amount: false }});
    const caption = `📲 Pay ₹${amount} using PhonePe / Paytm / UPI.\n\n✅ Scan the QR below to pay.\n\nAfter payment, send the screenshot here.\n\n⚡ To add balance quickly, forward the bot's generated payment message to the admin: ${ADMIN_USERNAME}`;
    try {
      if (fs.existsSync(QR_IMAGE_PATH)) {
        await ctx.replyWithPhoto({ source: QR_IMAGE_PATH }, { caption });
      } else {
        await ctx.reply(caption);
      }
    } catch (e) {
      console.error('send qr error', e);
      await ctx.reply(caption);
    }
    return;
  }
  return next();
});

bot.on('photo', async (ctx) => {
  const user = await Users.findOne({ user_id: ctx.from.id });
  if (!user || !user.pending_payment) {
    await ctx.reply('Please first select *Add Fund* and enter an amount. Then send screenshot.', { parse_mode: 'Markdown' });
    return;
  }
  const photos = ctx.message.photo;
  const fileId = photos[photos.length-1].file_id;
  const amount = user.pending_payment.amount || 0;
  const msg = `📤 Payment Request Received!\n\n👤 User: @${ctx.from.username || 'NoUsername'}\n🆔 User ID: ${ctx.from.id}\n💰 Amount (User Wrote): ₹${amount}\n📅 Time: ${nowStr()}\n\n🖼 Screenshot below 👇\n➡️ Admin, please verify and add balance if payment is confirmed.\n\n⚡ To add balance quickly, just forward this message to the admin.\n\n📞 Admin Contact: ${ADMIN_USERNAME}`;
  try {
    await ctx.reply(msg);
    await ctx.replyWithPhoto(fileId, { caption: 'Payment screenshot (forward to admin)' });
  } catch (e) {
    console.error('reply screenshot error', e);
    await ctx.reply(msg);
  }
  await Users.updateOne({ user_id: ctx.from.id }, { $set: { 'pending_payment.screenshot_file_id': fileId }});
});

// ---------- Services: Likes / Views flow ----------
async function getPrices() {
  const pLike = await getSetting('price_like_per_1k') || 1.2;
  const pView = await getSetting('price_view_per_1k') || 0.9;
  return { like: Number(pLike), view: Number(pView) };
}
async function getServiceIds() {
  const sLikes = await getSetting('service_likes') || 11505;
  const sViews = await getSetting('service_views') || 10695;
  return { likes: Number(sLikes), views: Number(sViews) };
}

bot.action('SERVICE_LIKES', async (ctx) => {
  await ctx.answerCbQuery();
  const prices = await getPrices();
  const text = `💞 *Instagram Likes*\n\n💰 Price: ₹${prices.like} per 1K Likes\n📉 Minimum: 500\n📈 Maximum: 50000\n\nClick below to order.`;
  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('📦 Order Likes', 'ORDER_LIKES')],[Markup.button.callback('🏠 Home','HOME')]]));
});

bot.action('SERVICE_VIEWS', async (ctx) => {
  await ctx.answerCbQuery();
  const prices = await getPrices();
  const text = `👀 *Instagram Views*\n\n💰 Price: ₹${prices.view} per 1K Views\n📉 Minimum: 1000\n📈 Maximum: 1000000\n\nClick below to order.`;
  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('📦 Order Views', 'ORDER_VIEWS')],[Markup.button.callback('🏠 Home','HOME')]]));
});

async function startOrderFlow(ctx, type) {
  await Users.updateOne({ user_id: ctx.from.id }, { $set: { expecting_order: { type, step: 'link' } }});
  await ctx.reply('Please send the Instagram post link (must contain instagram.com/p/...).');
}

bot.action('ORDER_LIKES', async (ctx) => { await ctx.answerCbQuery(); await startOrderFlow(ctx, 'likes'); });
bot.action('ORDER_VIEWS', async (ctx) => { await ctx.answerCbQuery(); await startOrderFlow(ctx, 'views'); });

bot.on('message', async (ctx, next) => {
  if (!ctx.message.text) return next();
  const user = await Users.findOne({ user_id: ctx.from.id });
  if (!user || !user.expecting_order) return next();
  const eo = user.expecting_order;
  if (eo.step === 'link') {
    const link = ctx.message.text.trim();
    if (!link.includes('instagram.com/p/')) {
      await ctx.reply('❌ Invalid link. Please send an Instagram post link (contains instagram.com/p/...).');
      return;
    }
    await Users.updateOne({ user_id: ctx.from.id }, { $set: { 'expecting_order.link': link, 'expecting_order.step': 'qty' }});
    const min = eo.type === 'likes' ? 500 : 1000;
    await ctx.reply(`Enter quantity (minimum ${min}):`);
    return;
  }
  if (eo.step === 'qty') {
    const qty = Number(ctx.message.text.trim());
    if (!qty || qty <= 0) { await ctx.reply('❌ Invalid quantity. Enter a number.'); return; }
    const type = eo.type;
    const min = type === 'likes' ? 500 : 1000;
    const max = type === 'likes' ? 50000 : 1000000;
    if (qty < min) { await ctx.reply(`❌ Minimum order is ${min}. Please enter a valid quantity.`); return; }
    if (qty > max) { await ctx.reply(`❌ Maximum order is ${max}. Please enter a valid quantity.`); return; }

    const link = eo.link;
    const dupe = await Orders.findOne({ user_id: ctx.from.id, link, service: type, status: { $in: ['pending','processing'] } });
    if (dupe) {
      await ctx.reply('⚠️ Your previous order for this same link is not completed yet! Please wait until it completes before placing a new one.');
      await Users.updateOne({ user_id: ctx.from.id }, { $unset: { expecting_order: "" }});
      return;
    }

    const prices = await getPrices();
    const pricePer1k = (type === 'likes') ? prices.like : prices.view;
    const cost = ((pricePer1k/1000) * qty);
    const costRounded = Math.round(cost * 100) / 100;

    const summary = `✅ Order Summary\n\n📸 Service: Instagram ${type === 'likes' ? 'Likes' : 'Views'}\n🔗 Link: ${link}\n📦 Quantity: ${qty}\n💰 Total Cost: ₹${costRounded}\n\nConfirm order?`;
    await ctx.reply(summary, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', `CONFIRM_ORDER:${type}:${qty}`), Markup.button.callback('❌ Cancel', 'CANCEL_ORDER')],
    ]));
    await Users.updateOne({ user_id: ctx.from.id }, { $set: { 'expecting_order.qty': qty, 'expecting_order.cost': costRounded }});
    return;
  }
  return next();
});

bot.action('CANCEL_ORDER', async (ctx) => {
  await ctx.answerCbQuery();
  await Users.updateOne({ user_id: ctx.from.id }, { $unset: { expecting_order: "" }});
  await ctx.reply('Order cancelled.');
});

bot.action(/CONFIRM_ORDER:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  const parts = data.split(':');
  const type = parts[1];
  const qty = Number(parts[2]);
  const user = await Users.findOne({ user_id: ctx.from.id });
  if (!user || !user.expecting_order) { await ctx.reply('No order data found.'); return; }
  const link = user.expecting_order.link;
  const cost = user.expecting_order.cost;

  if ((user.balance || 0) < cost) {
    await ctx.reply(`❌ Insufficient balance.\n💰 Your Balance: ₹${(user.balance||0)}\n🛒 Order Cost: ₹${cost}`);
    await Users.updateOne({ user_id: ctx.from.id }, { $unset: { expecting_order: "" }});
    return;
  }

  const sids = await getServiceIds();
  const serviceId = type === 'likes' ? sids.likes : sids.views;

  await ctx.reply('Placing your order... 🔄');

  const prov = await providerOrder(serviceId, link, qty);
  if (!prov || (!prov.order && !prov.id)) {
    await ctx.reply('❌ Failed to place order with provider. Please try again later.');
    await Users.updateOne({ user_id: ctx.from.id }, { $unset: { expecting_order: "" }});
    return;
  }
  const providerOrderId = prov.order || prov.id || Math.floor(Date.now()/1000);
  const orderDoc = {
    order_id: providerOrderId,
    user_id: ctx.from.id,
    username: ctx.from.username || null,
    service: type,
    link,
    qty,
    cost,
    status: 'pending',
    provider_status: prov.status || null,
    created_at: new Date(),
    updated_at: new Date()
  };
  await Orders.insertOne(orderDoc);

  await Users.updateOne({ user_id: ctx.from.id }, { $inc: { balance: -cost, total_spent: cost }, $set: { last_order_at: new Date() }});

  const reply = `✅ Order Placed Successfully!\n\n📦 Order ID: ${providerOrderId}\n📊 Service: Instagram ${type === 'likes' ? 'Likes' : 'Views'}\n🔗 Link: ${link}\n📈 Quantity: ${qty}\n💰 Cost: ₹${cost}`;
  await ctx.reply(reply);

  const groupId = await getSetting('group_chat_id') || GROUP_CHAT_ID;
  if (groupId) {
    const gmsg = `📢 New Order Received!\n\n🆔 User ID: ${ctx.from.id}\n🛍️ Service: Instagram ${type === 'likes' ? 'Likes' : 'Views'}\n📦 Quantity: ${qty}\n\n👉 You can also place your order now — ${BOT_USERNAME}`;
    try { await bot.telegram.sendMessage(Number(groupId), gmsg); } catch(e){ console.error('group notify error', e); }
  }

  await Users.updateOne({ user_id: ctx.from.id }, { $unset: { expecting_order: "" }});
});

// ---------- My Orders ----------
bot.action('MY_ORDERS', async (ctx) => {
  await ctx.answerCbQuery();
  const orders = await Orders.find({ user_id: ctx.from.id }).sort({ created_at: -1 }).limit(10).toArray();
  if (!orders || !orders.length) return ctx.reply('You have no orders yet.');
  let text = '📦 Your recent orders:\n\n';
  for (const o of orders) {
    text += `#${o.order_id} | ${o.service} | ${o.qty} | ${o.status}\n`;
  }
  await ctx.reply(text);
});

bot.command('myorders', async (ctx) => {
  const orders = await Orders.find({ user_id: ctx.from.id }).sort({ created_at: -1 }).limit(10).toArray();
  if (!orders || !orders.length) return ctx.reply('You have no orders yet.');
  let text = '📦 Your recent orders:\n\n';
  for (const o of orders) {
    text += `#${o.order_id} | ${o.service} | ${o.qty} | ${o.status}\n`;
  }
  await ctx.reply(text);
});

// ---------- Profile ----------
bot.action('MY_PROFILE', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await Users.findOne({ user_id: ctx.from.id }) || {};
  const completed = await Orders.countDocuments({ user_id: ctx.from.id, status: 'completed' });
  const pending = await Orders.countDocuments({ user_id: ctx.from.id, status: { $in: ['pending','processing'] } });
  const text = `👤 Username: @${ctx.from.username || 'NoUsername'}\n💰 Balance: ₹${(user.balance||0).toFixed(2)}\n📦 Total Orders: ${completed + pending}\n✅ Completed: ${completed}\n⏳ Pending: ${pending}`;
  await ctx.reply(text);
});
bot.command('profile', async (ctx) => {
  const user = await Users.findOne({ user_id: ctx.from.id }) || {};
  const completed = await Orders.countDocuments({ user_id: ctx.from.id, status: 'completed' });
  const pending = await Orders.countDocuments({ user_id: ctx.from.id, status: { $in: ['pending','processing'] } });
  const text = `👤 Username: @${ctx.from.username || 'NoUsername'}\n💰 Balance: ₹${(user.balance||0).toFixed(2)}\n📦 Total Orders: ${completed + pending}\n✅ Completed: ${completed}\n⏳ Pending: ${pending}`;
  await ctx.reply(text);
});

// ---------- Admin Commands ----------
bot.command('setprice', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Usage: /setprice <likes|view> <pricePer1K>');
  const type = parts[1];
  const val = Number(parts[2]);
  if (isNaN(val)) return ctx.reply('Invalid price.');
  if (type === 'likes') await setSetting('price_like_per_1k', val);
  else if (type === 'view' || type === 'views') await setSetting('price_view_per_1k', val);
  else return ctx.reply('Unknown type. Use likes or view');
  ctx.reply(`✅ Price updated: ${type} = ${val} per 1K`);
});

bot.command('setservice', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Usage: /setservice <likes|views> <serviceId>');
  const type = parts[1]; const id = Number(parts[2]);
  if (isNaN(id)) return ctx.reply('Invalid service id.');
  if (type === 'likes') await setSetting('service_likes', id);
  else if (type === 'views') await setSetting('service_views', id);
  else return ctx.reply('Unknown type. Use likes or views');
  ctx.reply(`✅ Service ID updated: ${type} = ${id}`);
});

bot.command('addbalance', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 3) return ctx.reply('Usage: /addbalance <userid> <amount>');
  const uid = Number(parts[1]); const amt = Number(parts[2]);
  if (isNaN(uid) || isNaN(amt)) return ctx.reply('Invalid args');
  await Users.updateOne({ user_id: uid }, { $inc: { balance: amt }});
  ctx.reply(`✅ Added ₹${amt} to ${uid}`);
  try { await bot.telegram.sendMessage(uid, `✅ ₹${amt} has been added to your balance by admin.`); } catch(e){}
});

bot.command('panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized');
  const usersCount = await Users.countDocuments();
  const ordersToday = await Orders.countDocuments({ created_at: { $gte: new Date(new Date().setHours(0,0,0,0)) }});
  const running = await Orders.countDocuments({ status: { $in: ['pending','processing'] }});
  const text = `📊 Panel\nUsers: ${usersCount}\nOrders Today: ${ordersToday}\nRunning Orders: ${running}`;
  ctx.reply(text);
});

// broadcast
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized');
  const message = ctx.message.text.replace('/broadcast','').trim();
  if (!message) return ctx.reply('Usage: /broadcast Your message here');
  const users = await Users.find({}).project({ user_id: 1 }).toArray();
  let sent = 0;
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.user_id, message);
      sent++;
      await sleep(100);
    } catch(e){}
  }
  await BroadcastLogs.insertOne({ message, sent_by: ctx.from.id, created_at: new Date(), recipients_count: sent});
  ctx.reply(`Broadcast completed. Sent to ${sent} users.`);
});

// ---------- Auto Status Checker ----------
// ---------- Auto Status Checker ----------
async function runStatusChecker() {
  console.log('Status checker running every', STATUS_CHECK_INTERVAL_MIN, 'min');
  setInterval(async () => {
    try {
      const pending = await Orders.find({ status: { $in: ['pending','processing'] } }).limit(200).toArray();
      for (const o of pending) {
        const res = await providerStatus(o.order_id);
        if (!res) continue;
        const providerStatus = (res.status || res.result || '').toString().toLowerCase();
        let status = o.status;
        if (providerStatus.includes('completed') || providerStatus === 'completed') status = 'completed';
        else if (providerStatus.includes('partial')) status = 'partial';
        else if (providerStatus.includes('processing') || providerStatus.includes('in progress')) status = 'processing';
        else if (providerStatus.includes('cancel') || providerStatus.includes('refunded')) status = 'cancelled';
        if (status !== o.status) {
          await Orders.updateOne({ _id: o._id }, { $set: { status, provider_status: providerStatus, updated_at: new Date() }});
          if (status === 'completed') {
            try { await bot.telegram.sendMessage(o.user_id, `🎉 Your Order #${o.order_id} has been completed!`); } catch(e){}
          }
          if (status === 'cancelled' || status === 'refunded') {
            try {
              await Users.updateOne({ user_id: o.user_id }, { $inc: { balance: o.cost }});
              await bot.telegram.sendMessage(o.user_id, `💸 Your Order #${o.order_id} was cancelled/refunded. ₹${o.cost} has been returned to your balance.`);
            } catch(e){ console.error('refund notify err', e); }
          }
        } else {
          await Orders.updateOne({ _id: o._id }, { $set: { provider_status, updated_at: new Date() }});
        }
      }
    } catch (e) {
      console.error('Status checker loop error', e);
    }
  }, Math.max(1, STATUS_CHECK_INTERVAL_MIN) * 60 * 1000);
}

// ---------- Backup helper (simple JSON export) ----------
async function backupDbOnce() {
  try {
    if (!fs.existsSync(BACKUP_PATH)) fs.mkdirSync(BACKUP_PATH, { recursive: true });
    const usersArr = await Users.find({}).toArray();
    const ordersArr = await Orders.find({}).toArray();
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_PATH, `users_${now}.json`), JSON.stringify(usersArr));
    fs.writeFileSync(path.join(BACKUP_PATH, `orders_${now}.json`), JSON.stringify(ordersArr));
    console.log('Backup saved at', BACKUP_PATH);
  } catch(e) { console.error('Backup error', e); }
}

// ---------- Health endpoint (for UptimeRobot) ----------
const app = express();
app.get('/', (req, res) => res.send('OK - bot is alive'));
app.get('/health', (req,res)=>res.send({ ok: true, time: new Date() }));
app.listen(PORT, () => console.log('Health server running on port', PORT));

// ---------- Start ----------
(async () => {
  try {
    await initDb();
    await bot.launch();
    console.log('Bot started');
    runStatusChecker();
    setInterval(async () => { await backupDbOnce(); }, 24*60*60*1000);
    await backupDbOnce();
  } catch (e) {
    console.error('Startup error', e);
  }
})();

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

