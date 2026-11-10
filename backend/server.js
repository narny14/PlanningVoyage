require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));

const requiredEnv = ['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME','JWT_SECRET'];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error('Variable .env manquante : ' + key);
}
if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET doit contenir au moins 32 caractères.');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: true
});

let firebaseReady = false;
try {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseReady = true;
  } else {
    console.warn('Firebase non configuré : les notifications seront conservées en base, sans push.');
  }
} catch (error) {
  console.error('Configuration Firebase invalide :', error.message);
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    issuer: 'planningvoyage-api',
    audience: 'planningvoyage-app'
  });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'planningvoyage-api',
      audience: 'planningvoyage-app'
    });
    next();
  } catch {
    return res.status(401).json({ message: 'Session invalide ou expirée.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ message: 'Accès administrateur requis.' });
  next();
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}

async function audit(actorId, action, entityType, entityId, details = {}) {
  await pool.execute(
    'INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)',
    [actorId || null, action, entityType, entityId || null, JSON.stringify(details)]
  );
}

async function pushToUser(userId, title, body, data = {}) {
  if (!firebaseReady) return { sent: false, reason: 'firebase_not_configured' };
  const [rows] = await pool.execute(
    'SELECT id, token FROM device_tokens WHERE user_id=? AND is_active=1',
    [userId]
  );
  if (!rows.length) return { sent: false, reason: 'no_active_device' };
  const result = await admin.messaging().sendEachForMulticast({
    tokens: rows.map(row => row.token),
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
    android: { priority: 'high', notification: { channelId: 'planningvoyage' } }
  });
  const invalidCodes = ['messaging/invalid-registration-token','messaging/registration-token-not-registered'];
  for (let i = 0; i < result.responses.length; i++) {
    if (!result.responses[i].success && invalidCodes.includes(result.responses[i].error?.code)) {
      await pool.execute('UPDATE device_tokens SET is_active=0 WHERE id=?', [rows[i].id]);
    }
  }
  return { sent: result.successCount > 0, successCount: result.successCount, failureCount: result.failureCount };
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'planningvoyage-api', database: 'connected', firebase: firebaseReady ? 'configured' : 'not_configured' });
  } catch {
    res.status(503).json({ ok: false, database: 'disconnected' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ message: 'Email et mot de passe obligatoires.' });
    const [rows] = await pool.execute(
      'SELECT id,full_name,email,password_hash,role,is_active,must_change_password FROM users WHERE email=? LIMIT 1',
      [email]
    );
    const user = rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Identifiants incorrects.' });
    }
    res.json({
      token: signToken(user),
      user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, mustChangePassword: !!user.must_change_password }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Erreur lors de la connexion.' });
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id,full_name,email,role,phone,must_change_password FROM users WHERE id=? AND is_active=1',
    [req.auth.sub]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Compte introuvable.' });
  const u = rows[0];
  res.json({ id: u.id, fullName: u.full_name, email: u.email, role: u.role, phone: u.phone, mustChangePassword: !!u.must_change_password });
});

app.post('/api/me/change-password', authenticate, async (req, res) => {
  const password = String(req.body.newPassword || '');
  if (password.length < 12) return res.status(400).json({ message: 'Le nouveau mot de passe doit contenir au moins 12 caractères.' });
  const hash = await bcrypt.hash(password, 12);
  await pool.execute('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', [hash, req.auth.sub]);
  res.json({ message: 'Mot de passe modifié. Reconnectez-vous.' });
});

// Device tokens are attached to the authenticated account, never to a client-supplied user ID.
app.post('/api/me/device-token', authenticate, async (req, res) => {
  const token = String(req.body.token || '').trim();
  const platform = ['android','ios','web'].includes(req.body.platform) ? req.body.platform : 'android';
  if (!token || token.length > 512) return res.status(400).json({ message: 'Token appareil invalide.' });
  await pool.execute(
    'INSERT INTO device_tokens (user_id,token,platform,is_active,last_seen_at) VALUES (?,?,?,1,NOW()) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),platform=VALUES(platform),is_active=1,last_seen_at=NOW()',
    [req.auth.sub, token, platform]
  );
  res.json({ message: 'Appareil enregistré.' });
});

app.get('/api/me/trips', authenticate, async (req, res) => {
  const [rows] = await pool.execute(
    "SELECT id,departure_date AS departureDate,departure_city AS departureCity,destination,arrival_date AS arrivalDate,arrival_city AS arrivalCity,reference_code AS referenceCode,transport,notes,status FROM trips WHERE user_id=? AND status<>'cancelled' AND (departure_date >= CURDATE() OR departure_date < CURDATE()) ORDER BY departure_date ASC",
    [req.auth.sub]
  );
  const next = rows.find(t => t.departureDate >= new Date().toISOString().slice(0,10)) || null;
  const past = rows.filter(t => t.departureDate < new Date().toISOString().slice(0,10)).sort((a,b) => b.departureDate.localeCompare(a.departureDate));
  res.json({ nextTrip: next, pastTrips: past, trips: rows });
});

app.get('/api/me/history.pdf', authenticate, async (req, res) => {
  const [rows] = await pool.execute(
    "SELECT departure_date,departure_city,destination,arrival_date,arrival_city,reference_code,status FROM trips WHERE user_id=? AND status<>'cancelled' ORDER BY departure_date DESC",
    [req.auth.sub]
  );
  const [users] = await pool.execute('SELECT full_name FROM users WHERE id=?', [req.auth.sub]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="planningvoyage-historique.pdf"');
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  doc.pipe(res);
  doc.fontSize(20).text('HISTORIQUE DES VOYAGES', { align: 'center' });
  doc.moveDown().fontSize(11).text('Voyageur : ' + (users[0]?.full_name || ''));
  doc.moveDown();
  if (!rows.length) doc.text('Aucun voyage enregistré.');
  for (const trip of rows) {
    doc.fontSize(12).text('Départ : ' + trip.departure_date);
    doc.fontSize(10).text('Ville de départ : ' + trip.departure_city);
    doc.text('Destination : ' + trip.destination);
    doc.text('Arrivée : ' + (trip.arrival_date || 'Non renseignée') + (trip.arrival_city ? ' - ' + trip.arrival_city : ''));
    if (trip.reference_code) doc.text('Référence : ' + trip.reference_code);
    doc.text('Statut : ' + trip.status);
    doc.moveDown().moveTo(48, doc.y).lineTo(547, doc.y).stroke().moveDown();
    if (doc.y > 730) doc.addPage();
  }
  doc.end();
});

app.get('/api/me/notifications', authenticate, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id,title,body,sent_at AS sentAt,read_at AS readAt,delivery_status AS deliveryStatus FROM notifications WHERE user_id=? ORDER BY sent_at DESC LIMIT 100',
    [req.auth.sub]
  );
  res.json(rows);
});

app.patch('/api/me/notifications/:id/read', authenticate, async (req, res) => {
  const [result] = await pool.execute(
    'UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=? AND user_id=?',
    [req.params.id, req.auth.sub]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'Notification introuvable.' });
  res.json({ message: 'Notification marquée comme lue.' });
});

// ADMIN: create traveler account and set the initial password.
app.post('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  if (!fullName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
    return res.status(400).json({ message: 'Nom, email valide et mot de passe initial de 12 caractères minimum requis.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      "INSERT INTO users (full_name,email,password_hash,role,phone,must_change_password) VALUES (?,?,?,'traveler',?,1)",
      [fullName,email,hash,phone]
    );
    await audit(req.auth.sub, 'traveler_created', 'user', result.insertId);
    res.status(201).json({ id: result.insertId, fullName, email, role: 'traveler', mustChangePassword: true });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Cet email existe déjà.' });
    console.error(error);
    res.status(500).json({ message: 'Impossible de créer le compte.' });
  }
});

app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  const [rows] = await pool.execute(
    "SELECT id,full_name AS fullName,email,phone,is_active AS isActive,created_at AS createdAt FROM users WHERE role='traveler' ORDER BY full_name"
  );
  res.json(rows);
});

app.post('/api/admin/trips', authenticate, requireAdmin, async (req, res) => {
  const userId = Number(req.body.userId);
  const departureDate = req.body.departureDate;
  const departureCity = String(req.body.departureCity || '').trim();
  const destination = String(req.body.destination || '').trim();
  const arrivalDate = req.body.arrivalDate || null;
  if (!Number.isInteger(userId) || userId < 1 || !validDate(departureDate) || !departureCity || !destination ||
      (arrivalDate && (!validDate(arrivalDate) || arrivalDate < departureDate))) {
    return res.status(400).json({ message: 'Informations de voyage invalides.' });
  }
  const [users] = await pool.execute("SELECT id FROM users WHERE id=? AND role='traveler' AND is_active=1", [userId]);
  if (!users.length) return res.status(404).json({ message: 'Voyageur introuvable ou inactif.' });
  const [result] = await pool.execute(
    'INSERT INTO trips (user_id,departure_date,departure_city,destination,arrival_date,arrival_city,reference_code,transport,notes,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [userId,departureDate,departureCity,destination,arrivalDate,req.body.arrivalCity || null,req.body.referenceCode || null,req.body.transport || null,req.body.notes || null,['planned','confirmed','completed'].includes(req.body.status) ? req.body.status : 'planned',req.auth.sub]
  );
  await audit(req.auth.sub, 'trip_created', 'trip', result.insertId, { userId });
  const title = 'Nouveau voyage programmé';
  const body = 'Départ le ' + departureDate + ' de ' + departureCity + ' vers ' + destination + '.';
  const [notice] = await pool.execute(
    'INSERT INTO notifications (user_id,title,body,data_json,sent_by) VALUES (?,?,?,?,?)',
    [userId,title,body,JSON.stringify({ tripId: result.insertId }),req.auth.sub]
  );
  let delivery = { sent: false, reason: 'not_attempted' };
  try {
    delivery = await pushToUser(userId,title,body,{ type: 'trip_created', tripId: result.insertId });
    await pool.execute('UPDATE notifications SET delivery_status=?,fcm_message_id=? WHERE id=?',
      [delivery.sent ? 'sent' : 'queued', delivery.messageId || null, notice.insertId]);
  } catch (error) {
    console.error('FCM error:', error.message);
    await pool.execute("UPDATE notifications SET delivery_status='failed' WHERE id=?", [notice.insertId]);
    delivery = { sent: false, reason: 'fcm_error' };
  }
  res.status(201).json({ id: result.insertId, notificationId: notice.insertId, push: delivery });
});

app.put('/api/admin/trips/:id', authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const departureDate = req.body.departureDate;
  const departureCity = String(req.body.departureCity || '').trim();
  const destination = String(req.body.destination || '').trim();
  const arrivalDate = req.body.arrivalDate || null;
  if (!Number.isInteger(id) || !validDate(departureDate) || !departureCity || !destination ||
      (arrivalDate && (!validDate(arrivalDate) || arrivalDate < departureDate))) {
    return res.status(400).json({ message: 'Informations de voyage invalides.' });
  }
  const [result] = await pool.execute(
    'UPDATE trips SET departure_date=?,departure_city=?,destination=?,arrival_date=?,arrival_city=?,reference_code=?,transport=?,notes=?,status=? WHERE id=?',
    [departureDate,departureCity,destination,arrivalDate,req.body.arrivalCity || null,req.body.referenceCode || null,req.body.transport || null,req.body.notes || null,['planned','confirmed','completed','cancelled'].includes(req.body.status) ? req.body.status : 'planned',id]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'Voyage introuvable.' });
  await audit(req.auth.sub, 'trip_updated', 'trip', id);
  res.json({ message: 'Voyage mis à jour.' });
});

app.get('/api/admin/trips', authenticate, requireAdmin, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT t.id,t.user_id AS userId,u.full_name AS travelerName,u.email,t.departure_date AS departureDate,t.departure_city AS departureCity,t.destination,t.arrival_date AS arrivalDate,t.arrival_city AS arrivalCity,t.status FROM trips t JOIN users u ON u.id=t.user_id ORDER BY t.departure_date DESC LIMIT 1000'
  );
  res.json(rows);
});

app.post('/api/admin/notifications', authenticate, requireAdmin, async (req, res) => {
  const userId = Number(req.body.userId);
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!Number.isInteger(userId) || userId < 1 || !title || title.length > 180 || !body) {
    return res.status(400).json({ message: 'Destinataire, titre et message sont obligatoires.' });
  }
  const [users] = await pool.execute("SELECT id FROM users WHERE id=? AND role='traveler' AND is_active=1", [userId]);
  if (!users.length) return res.status(404).json({ message: 'Voyageur introuvable.' });
  const [result] = await pool.execute(
    'INSERT INTO notifications (user_id,title,body,sent_by) VALUES (?,?,?,?)',
    [userId,title,body,req.auth.sub]
  );
  let delivery;
  try {
    delivery = await pushToUser(userId,title,body,{ type: 'private_message', notificationId: result.insertId });
    await pool.execute('UPDATE notifications SET delivery_status=? WHERE id=?', [delivery.sent ? 'sent' : 'queued', result.insertId]);
  } catch (error) {
    console.error('FCM error:', error.message);
    await pool.execute("UPDATE notifications SET delivery_status='failed' WHERE id=?", [result.insertId]);
    delivery = { sent: false, reason: 'fcm_error' };
  }
  await audit(req.auth.sub, 'private_notification_sent', 'notification', result.insertId, { userId });
  res.status(201).json({ id: result.insertId, push: delivery });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Erreur interne du serveur.' });
});

const port = Number(process.env.PORT || 5000);
app.listen(port, () => console.log('PlanningVoyage API listening on port ' + port));
