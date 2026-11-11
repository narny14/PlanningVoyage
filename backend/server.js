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

const { Buffer } = require('node:buffer');

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

    android: { priority: 'high' }

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
  try {
    const [rows] = await pool.execute(
      `SELECT
         t.id,
         t.departure_date AS departureDate,
         t.departure_city AS departureCity,
         t.destination,
         t.arrival_date AS arrivalDate,
         t.arrival_city AS arrivalCity,
         t.reference_code AS referenceCode,
         t.transport,
         t.notes,
         t.status,
         COALESCE(v.boarding_status, 'pending') AS boardingStatus,
         v.verified_at AS verifiedAt,
         v.actual_departure_date AS actualDepartureDate,
         v.actual_arrival_date AS actualArrivalDate
       FROM trips t
       LEFT JOIN trip_verifications v ON v.trip_id = t.id
       WHERE t.user_id = ?
         AND t.status <> 'cancelled'
       ORDER BY t.departure_date ASC, t.id ASC`,
      [req.auth.sub]
    );

    const [todayRows] = await pool.query('SELECT CURDATE() AS today');
    const today = String(todayRows[0].today).slice(0, 10);

    const upcomingTrips = rows.filter(trip => String(trip.departureDate).slice(0, 10) >= today);
    const pastTrips = rows.filter(trip => String(trip.departureDate).slice(0, 10) < today);

    const historyTrips = pastTrips
      .filter(trip => trip.boardingStatus === 'boarded')
      .sort((a, b) => String(b.departureDate).localeCompare(String(a.departureDate)));

    const pendingVerificationTrips = pastTrips
      .filter(trip => trip.boardingStatus === 'pending')
      .sort((a, b) => String(b.departureDate).localeCompare(String(a.departureDate)));

    const notBoardedTrips = pastTrips
      .filter(trip => trip.boardingStatus === 'not_boarded')
      .sort((a, b) => String(b.departureDate).localeCompare(String(a.departureDate)));

    const nextTrip = upcomingTrips.length ? upcomingTrips[0] : null;

    return res.json({
      nextTrip,
      upcomingTrips,
      pendingVerificationTrips,
      historyTrips,
      notBoardedTrips,
      // Compatibilité : pastTrips ne contient que les embarquements confirmés.
      pastTrips: historyTrips,
      // Compatibilité : renvoie tous les voyages à venir, pas uniquement le prochain.
      trips: [...historyTrips, ...upcomingTrips]
    });
  } catch (error) {
    console.error('GET /api/me/trips error:', error);
    return res.status(500).json({ message: 'Impossible de récupérer vos voyages.' });
  }
});

app.get('/api/me/history.pdf', authenticate, async (req, res) => {

  const [rows] = await pool.execute(

    `SELECT

       t.departure_date,

       t.departure_city,

       t.destination,

       t.arrival_date,

       t.arrival_city,

       t.reference_code,

       v.airline,

       v.flight_number,

       v.flight_report_reference,

       v.actual_departure_date,

       v.actual_arrival_date,

       v.verified_at

     FROM trips t

     INNER JOIN trip_verifications v ON v.trip_id = t.id

     WHERE t.user_id = ?

       AND v.boarding_status = 'boarded'

     ORDER BY t.departure_date DESC`,

    [req.auth.sub]

  );



  const [users] = await pool.execute(

    'SELECT full_name FROM users WHERE id=?',

    [req.auth.sub]

  );



  res.setHeader('Content-Type', 'application/pdf');

  res.setHeader(

    'Content-Disposition',

    'attachment; filename="planningvoyage-historique.pdf"'

  );



  const doc = new PDFDocument({ margin: 48, size: 'A4' });

  doc.pipe(res);



  doc.fontSize(20).text('HISTORIQUE DES VOYAGES', { align: 'center' });

  doc.moveDown().fontSize(11).text(

    'Voyageur : ' + (users[0]?.full_name || '')

  );

  doc.moveDown();



  if (!rows.length) {

    doc.text('Aucun embarquement confirmé.');

  }



  for (const trip of rows) {

    doc.fontSize(12).text('Départ prévu : ' + trip.departure_date);

    doc.fontSize(10).text('Ville de départ : ' + trip.departure_city);

    doc.text('Destination : ' + trip.destination);



    doc.text(

      'Arrivée prévue : ' +

      (trip.arrival_date || 'Non renseignée') +

      (trip.arrival_city ? ' - ' + trip.arrival_city : '')

    );



    if (trip.airline) doc.text('Compagnie : ' + trip.airline);

    if (trip.flight_number) doc.text('Vol : ' + trip.flight_number);



    if (trip.actual_departure_date) {

      doc.text('Départ réel : ' + trip.actual_departure_date);

    }



    if (trip.actual_arrival_date) {

      doc.text('Arrivée réelle : ' + trip.actual_arrival_date);

    }



    if (trip.reference_code) {

      doc.text('Référence voyage : ' + trip.reference_code);

    }



    if (trip.flight_report_reference) {

      doc.text('Référence rapport : ' + trip.flight_report_reference);

    }



    doc.text('Résultat : EMBARQUEMENT CONFIRMÉ');

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
  const tripStatus = ['planned', 'confirmed'].includes(req.body.status)
    ? req.body.status
    : 'planned';

  if (
    !Number.isSafeInteger(userId) || userId < 1 ||
    !validDate(departureDate) || !departureCity || !destination ||
    (arrivalDate && (!validDate(arrivalDate) || arrivalDate < departureDate))
  ) {
    return res.status(400).json({ message: 'Informations de voyage invalides.' });
  }

  const connection = await pool.getConnection();
  let tripId;

  try {
    await connection.beginTransaction();

    const [users] = await connection.execute(
      "SELECT id FROM users WHERE id=? AND role='traveler' AND is_active=1 FOR UPDATE",
      [userId]
    );

    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Voyageur introuvable ou inactif.' });
    }

    const [result] = await connection.execute(
      `INSERT INTO trips
       (user_id, departure_date, departure_city, destination, arrival_date,
        arrival_city, reference_code, transport, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, departureDate, departureCity, destination, arrivalDate,
        req.body.arrivalCity || null,
        req.body.referenceCode || null,
        req.body.transport || null,
        req.body.notes || null,
        tripStatus,
        req.auth.sub
      ]
    );

    tripId = result.insertId;

    // La fiche pending est créée dans la même transaction que le voyage.
    await connection.execute(
      `INSERT INTO trip_verifications (trip_id, boarding_status)
       VALUES (?, 'pending')`,
      [tripId]
    );

    await connection.execute(
      `INSERT INTO audit_logs
       (actor_id, action, entity_type, entity_id, details_json)
       VALUES (?, 'trip_created', 'trip', ?, ?)`,
      [req.auth.sub, tripId, JSON.stringify({ userId, status: tripStatus })]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('POST /api/admin/trips transaction error:', error);
    return res.status(500).json({ message: 'Impossible de créer le voyage.' });
  } finally {
    connection.release();
  }

  const title = 'Nouveau voyage programmé';
  const body = 'Départ le ' + departureDate + ' de ' + departureCity + ' vers ' + destination + '.';
  let notificationId = null;
  let delivery = { sent: false, reason: 'not_attempted' };

  // La notification est secondaire : une panne FCM ne doit pas annuler le voyage.
  try {
    const [notice] = await pool.execute(
      'INSERT INTO notifications (user_id, title, body, data_json, sent_by) VALUES (?, ?, ?, ?, ?)',
      [userId, title, body, JSON.stringify({ tripId }), req.auth.sub]
    );
    notificationId = notice.insertId;

    try {
      delivery = await pushToUser(userId, title, body, { type: 'trip_created', tripId });
      await pool.execute(
        'UPDATE notifications SET delivery_status=? WHERE id=?',
        [delivery.sent ? 'sent' : 'queued', notificationId]
      );
    } catch (pushError) {
      console.error('FCM trip-created error:', pushError.message);
      await pool.execute(
        "UPDATE notifications SET delivery_status='failed' WHERE id=?",
        [notificationId]
      );
      delivery = { sent: false, reason: 'fcm_error' };
    }
  } catch (notificationError) {
    console.error('Trip notification creation error:', notificationError);
    delivery = { sent: false, reason: 'notification_error' };
  }

  return res.status(201).json({ id: tripId, notificationId, status: tripStatus, boardingStatus: 'pending', push: delivery });
});

app.get(

  '/api/admin/trips/pending-verification',

  authenticate,

  requireAdmin,

  async (req, res) => {

    const [rows] = await pool.execute(

      `SELECT

         t.id,

         t.user_id AS userId,

         u.full_name AS travelerName,

         u.email,

         t.departure_date AS departureDate,

         t.departure_city AS departureCity,

         t.destination,

         t.arrival_date AS arrivalDate,

         t.arrival_city AS arrivalCity,

         t.reference_code AS referenceCode,

         t.transport,

         t.status,

         v.boarding_status AS boardingStatus

       FROM trips t

       INNER JOIN users u ON u.id = t.user_id

       INNER JOIN trip_verifications v ON v.trip_id = t.id

       WHERE t.departure_date < CURDATE()

         AND t.status <> 'cancelled'

         AND v.boarding_status = 'pending'

       ORDER BY t.departure_date DESC`

    );



    res.json(rows);

  }

);

app.post(

  '/api/admin/trips/:id/verify',

  authenticate,

  requireAdmin,

  async (req, res) => {

    const id = Number(req.params.id);

    const boardingStatus = req.body.boardingStatus;



    const airline = String(req.body.airline || '').trim();

    const flightNumber = String(req.body.flightNumber || '').trim();

    const flightReportReference =

      String(req.body.flightReportReference || '').trim();

    const observation = String(req.body.observation || '').trim();



    const actualDepartureDate = req.body.actualDepartureDate || null;

    const actualArrivalDate = req.body.actualArrivalDate || null;



    if (!Number.isSafeInteger(id) || id < 1) {

      return res.status(400).json({ message: 'Identifiant de voyage invalide.' });

    }



    if (!['boarded', 'not_boarded'].includes(boardingStatus)) {

      return res.status(400).json({

        message: 'Résultat d’embarquement invalide.'

      });

    }



    if (

      airline.length > 150 ||

      flightNumber.length > 80 ||

      flightReportReference.length > 120 ||

      observation.length > 5000

    ) {

      return res.status(400).json({

        message: 'Un des champs dépasse la longueur autorisée.'

      });

    }



    if (

      (actualDepartureDate && !validDate(actualDepartureDate)) ||

      (actualArrivalDate && !validDate(actualArrivalDate)) ||

      (

        actualDepartureDate &&

        actualArrivalDate &&

        actualArrivalDate < actualDepartureDate

      )

    ) {

      return res.status(400).json({

        message: 'Les dates réelles du vol sont invalides.'

      });

    }



    const connection = await pool.getConnection();



    let userId;

    let notificationId;



    try {

      await connection.beginTransaction();



      const [trips] = await connection.execute(

        `SELECT id, user_id, departure_date, status

         FROM trips

         WHERE id = ?

         FOR UPDATE`,

        [id]

      );



      if (!trips.length) {

        await connection.rollback();

        return res.status(404).json({

          message: 'Voyage introuvable.'

        });

      }



      const trip = trips[0];

      userId = trip.user_id;



      if (trip.status === 'cancelled') {

        await connection.rollback();

        return res.status(409).json({

          message: 'Impossible de vérifier un voyage annulé.'

        });

      }



      const [verification] = await connection.execute(

        `SELECT boarding_status

         FROM trip_verifications

         WHERE trip_id = ?

         FOR UPDATE`,

        [id]

      );



      if (!verification.length) {

        await connection.rollback();

        return res.status(409).json({

          message: 'Fiche de vérification introuvable pour ce voyage.'

        });

      }



      if (verification[0].boarding_status !== 'pending') {

        await connection.rollback();

        return res.status(409).json({

          message: 'Ce voyage a déjà été vérifié.'

        });

      }



      const [todayRows] = await connection.query(

        'SELECT CURDATE() AS today'

      );



      if (String(trip.departure_date) >= String(todayRows[0].today)) {

        await connection.rollback();

        return res.status(409).json({

          message: 'La date de départ n’est pas encore passée.'

        });

      }



      await connection.execute(

        `UPDATE trip_verifications

         SET boarding_status = ?,

             airline = ?,

             flight_number = ?,

             flight_report_reference = ?,

             actual_departure_date = ?,

             actual_arrival_date = ?,

             observation = ?,

             verified_by = ?,

             verified_at = NOW()

         WHERE trip_id = ?`,

        [

          boardingStatus,

          airline || null,

          flightNumber || null,

          flightReportReference || null,

          actualDepartureDate,

          actualArrivalDate,

          observation || null,

          req.auth.sub,

          id

        ]

      );



      await connection.execute(

        `INSERT INTO audit_logs

         (actor_id, action, entity_type, entity_id, details_json)

         VALUES (?, ?, 'trip', ?, ?)`,

        [

          req.auth.sub,

          'trip_boarding_verified',

          id,

          JSON.stringify({

            userId,

            boardingStatus,

            airline: airline || null,

            flightNumber: flightNumber || null,

            flightReportReference: flightReportReference || null

          })

        ]

      );



      const title = boardingStatus === 'boarded'

        ? 'Embarquement confirmé'

        : 'Résultat de votre voyage';



      const body = boardingStatus === 'boarded'

        ? 'Votre embarquement pour le voyage du ' +

          trip.departure_date + ' a été confirmé.'

        : 'Selon la vérification administrative, votre embarquement pour le voyage du ' +

          trip.departure_date + ' n’a pas été confirmé.';



      const [notice] = await connection.execute(

        `INSERT INTO notifications

         (user_id, title, body, data_json, sent_by)

         VALUES (?, ?, ?, ?, ?)`,

        [

          userId,

          title,

          body,

          JSON.stringify({

            type: 'boarding_verification',

            tripId: id,

            boardingStatus

          }),

          req.auth.sub

        ]

      );



      notificationId = notice.insertId;



      await connection.commit();



    } catch (error) {

      await connection.rollback();

      console.error('Boarding verification error:', error);



      return res.status(500).json({

        message: 'Erreur pendant la vérification de l’embarquement.'

      });



    } finally {

      connection.release();

    }



    let delivery = {

      sent: false,

      reason: 'not_attempted'

    };



    try {

      delivery = await pushToUser(

        userId,

        boardingStatus === 'boarded'

          ? 'Embarquement confirmé'

          : 'Résultat de votre voyage',

        boardingStatus === 'boarded'

          ? 'Votre embarquement a été confirmé par l’administration.'

          : 'Votre embarquement n’a pas été confirmé.',

        {

          type: 'boarding_verification',

          tripId: id,

          boardingStatus

        }

      );



      await pool.execute(

        'UPDATE notifications SET delivery_status=? WHERE id=?',

        [delivery.sent ? 'sent' : 'queued', notificationId]

      );



    } catch (error) {

      console.error('Boarding verification push error:', error.message);



      await pool.execute(

        "UPDATE notifications SET delivery_status='failed' WHERE id=?",

        [notificationId]

      );



      delivery = {

        sent: false,

        reason: 'fcm_error'

      };

    }



    res.json({

      message: boardingStatus === 'boarded'

        ? 'Embarquement confirmé avec succès.'

        : 'Voyageur déclaré non embarqué.',

      tripId: id,

      boardingStatus,

      verifiedBy: req.auth.sub,

      notificationId,

      push: delivery

    });

  }

);



app.put('/api/admin/trips/:id', authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const departureDate = req.body.departureDate;
  const departureCity = String(req.body.departureCity || '').trim();
  const destination = String(req.body.destination || '').trim();
  const arrivalDate = req.body.arrivalDate || null;

  if (
    !Number.isSafeInteger(id) || id < 1 ||
    !validDate(departureDate) || !departureCity || !destination ||
    (arrivalDate && (!validDate(arrivalDate) || arrivalDate < departureDate))
  ) {
    return res.status(400).json({ message: 'Informations de voyage invalides.' });
  }

  const connection = await pool.getConnection();
  let userId;
  let tripStatus;

  try {
    await connection.beginTransaction();

    // Même ordre de verrouillage que la route de vérification pour éviter les courses concurrentes.
    const [existing] = await connection.execute(
      'SELECT id, user_id, status FROM trips WHERE id=? FOR UPDATE',
      [id]
    );

    if (!existing.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Voyage introuvable.' });
    }

    userId = existing[0].user_id;

    const [verificationRows] = await connection.execute(
      'SELECT boarding_status FROM trip_verifications WHERE trip_id=? FOR UPDATE',
      [id]
    );

    if (!verificationRows.length) {
      await connection.rollback();
      return res.status(409).json({ message: 'Fiche de vérification introuvable pour ce voyage.' });
    }

    if (verificationRows[0].boarding_status !== 'pending') {
      await connection.rollback();
      return res.status(409).json({
        message: 'Ce voyage a déjà été vérifié. Sa modification est bloquée afin de préserver l’historique.'
      });
    }

    // Si le client omet status, conserver le statut existant.
    tripStatus = ['planned', 'confirmed', 'cancelled'].includes(req.body.status)
      ? req.body.status
      : existing[0].status;

    await connection.execute(
      `UPDATE trips
       SET departure_date=?, departure_city=?, destination=?, arrival_date=?,
           arrival_city=?, reference_code=?, transport=?, notes=?, status=?
       WHERE id=?`,
      [
        departureDate,
        departureCity,
        destination,
        arrivalDate,
        req.body.arrivalCity || null,
        req.body.referenceCode || null,
        req.body.transport || null,
        req.body.notes || null,
        tripStatus,
        id
      ]
    );

    await connection.execute(
      `INSERT INTO audit_logs
       (actor_id, action, entity_type, entity_id, details_json)
       VALUES (?, 'trip_updated', 'trip', ?, ?)`,
      [req.auth.sub, id, JSON.stringify({ userId, status: tripStatus })]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('PUT /api/admin/trips/:id transaction error:', error);
    return res.status(500).json({ message: 'Impossible de mettre à jour le voyage.' });
  } finally {
    connection.release();
  }

  const title = 'Mise à jour de votre voyage';
  const body = 'Votre voyage du ' + departureDate + ' de ' + departureCity + ' vers ' + destination + ' a été mis à jour.';
  let notificationId = null;
  let delivery = { sent: false, reason: 'not_attempted' };

  try {
    const [notice] = await pool.execute(
      'INSERT INTO notifications (user_id, title, body, data_json, sent_by) VALUES (?, ?, ?, ?, ?)',
      [userId, title, body, JSON.stringify({ tripId: id }), req.auth.sub]
    );
    notificationId = notice.insertId;

    try {
      delivery = await pushToUser(userId, title, body, { type: 'trip_updated', tripId: id });
      await pool.execute(
        'UPDATE notifications SET delivery_status=? WHERE id=?',
        [delivery.sent ? 'sent' : 'queued', notificationId]
      );
    } catch (pushError) {
      console.error('FCM trip-updated error:', pushError.message);
      await pool.execute(
        "UPDATE notifications SET delivery_status='failed' WHERE id=?",
        [notificationId]
      );
      delivery = { sent: false, reason: 'fcm_error' };
    }
  } catch (notificationError) {
    console.error('Trip update notification error:', notificationError);
    delivery = { sent: false, reason: 'notification_error' };
  }

  return res.json({
    message: 'Voyage mis à jour.',
    id,
    status: tripStatus,
    notificationId,
    push: delivery
  });
});

app.get('/api/admin/trips', authenticate, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         t.id,
         t.user_id AS userId,
         u.full_name AS travelerName,
         u.email,
         t.departure_date AS departureDate,
         t.departure_city AS departureCity,
         t.destination,
         t.arrival_date AS arrivalDate,
         t.arrival_city AS arrivalCity,
         t.reference_code AS referenceCode,
         t.transport,
         t.notes,
         t.status,
         COALESCE(v.boarding_status, 'pending') AS boardingStatus,
         v.airline,
         v.flight_number AS flightNumber,
         v.flight_report_reference AS flightReportReference,
         v.actual_departure_date AS actualDepartureDate,
         v.actual_arrival_date AS actualArrivalDate,
         v.observation,
         v.verified_by AS verifiedBy,
         verifier.full_name AS verifiedByName,
         v.verified_at AS verifiedAt
       FROM trips t
       INNER JOIN users u ON u.id = t.user_id
       LEFT JOIN trip_verifications v ON v.trip_id = t.id
       LEFT JOIN users verifier ON verifier.id = v.verified_by
       ORDER BY t.departure_date DESC, t.id DESC
       LIMIT 1000`
    );
    return res.json(rows);
  } catch (error) {
    console.error('GET /api/admin/trips error:', error);
    return res.status(500).json({ message: 'Impossible de récupérer les voyages.' });
  }
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
