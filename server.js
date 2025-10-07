/**
 * server.js
 * Node/Express + Postgres auth server
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

/* ----------------------------
   CONFIG
   ---------------------------- */
const PORT = 4000;

const PG_CONFIG = {
  host: 'localhost',
  port: 5432,
  database: 'nexusdb',
  user: 'nexususer',
  password: 'Developer12'
};

const JWT_SECRET = '4578ppoo9098989988925155222';

const EMAIL_CONFIG = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  user: 'ogbchiemena@gmail.com',
  pass: 'yfzg mocj afzl bozh'
};

const OTP_EXP_MINUTES = 5;
const SALT_ROUNDS = 10;

/* ----------------------------
   DB Pool
   ---------------------------- */
const pool = new Pool(PG_CONFIG);

async function dbQuery(text, params) {
  return pool.query(text, params);
}

/* ----------------------------
   Nodemailer
   ---------------------------- */
const transporter = nodemailer.createTransport({
  host: EMAIL_CONFIG.host,
  port: EMAIL_CONFIG.port,
  secure: EMAIL_CONFIG.port === 465,
  auth: {
    user: EMAIL_CONFIG.user,
    pass: EMAIL_CONFIG.pass
  }
});

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sendOtpEmail(toEmail, otp) {
  const mail = {
    from: EMAIL_CONFIG.user,
    to: toEmail,
    subject: 'Nexus password reset code',
    text: `Your OTP code: ${otp}. It expires in ${OTP_EXP_MINUTES} minutes.`,
    html: `<p>Your OTP code: <strong>${otp}</strong></p><p>It expires in ${OTP_EXP_MINUTES} minutes.</p>`
  };
  return transporter.sendMail(mail);
}

/* ----------------------------
   Auth Middleware
   ---------------------------- */
function verifyToken(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No token provided' });

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Malformed token' });
  }

  try {
    const payload = jwt.verify(parts[1], JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ----------------------------
   ROUTES
   ---------------------------- */

// SIGNUP
app.post('/api/auth/signup',
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      await dbQuery('INSERT INTO users1 (email, password) VALUES ($1, $2)', [email, hashed]);
      res.json({ message: 'Signup successful' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Signup failed' });
    }
  }
);

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await dbQuery('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// REQUEST RESET
app.post('/api/auth/request-reset', async (req, res) => {
  const { email } = req.body;
  const otp = generateOtp();
  try {
    await dbQuery('UPDATE users1 SET reset_otp = $1, reset_expires = NOW() + INTERVAL \'5 minutes\' WHERE email = $2',
      [otp, email]);
    await sendOtpEmail(email, otp);
    res.json({ message: 'OTP sent to email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send OTP' });
  }
});

// VERIFY RESET
app.post('/api/auth/verify-reset', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const result = await dbQuery(
      'SELECT * FROM users1 WHERE email=$1 AND reset_otp=$2 AND reset_expires > NOW()',
      [email, otp]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await dbQuery('UPDATE users1 SET password=$1, reset_otp=NULL, reset_expires=NULL WHERE email=$2',
      [hashed, email]);
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// CHANGE PASSWORD (requires token)
app.post('/api/auth/change-password', verifyToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const result = await dbQuery('SELECT * FROM users1 WHERE id=$1', [req.user.id]);
    const user = result.rows[0];
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Old password incorrect' });

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await dbQuery('UPDATE users1 SET password=$1 WHERE id=$2', [hashed, req.user.id]);
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Change password failed' });
  }
});

/* ----------------------------
   FRONTEND SERVE
   ---------------------------- */
import path from "path";

const __dirname = path.resolve();

// Serve static frontend files
// Serve frontend correctly from the root-level "frontend" folder
app.use(express.static(path.join(__dirname, '../../frontend')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});


/* ----------------------------
   START
   ---------------------------- */
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
