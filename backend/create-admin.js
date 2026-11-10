require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

async function main() {
  const rl = readline.createInterface({ input, output });
  let connection;
  try {
    const fullName = (await rl.question('Nom de l’administrateur : ')).trim();
    const email = (await rl.question('Email administrateur : ')).trim().toLowerCase();
    const password = await rl.question('Mot de passe administrateur : ');
    if (!fullName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
      throw new Error('Nom/email invalide. Le mot de passe doit contenir au moins 12 caractères.');
    }
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    const [existing] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) throw new Error('Cet email existe déjà.');
    const hash = await bcrypt.hash(password, 12);
    await connection.execute(
      "INSERT INTO users (full_name,email,password_hash,role,is_active,must_change_password) VALUES (?,?,?,'admin',1,0)",
      [fullName, email, hash]
    );
    console.log('Administrateur créé. Conservez ses identifiants en lieu sûr.');
  } finally {
    if (connection) await connection.end();
    rl.close();
  }
}
main().catch(error => { console.error('Échec :', error.message); process.exitCode = 1; });
