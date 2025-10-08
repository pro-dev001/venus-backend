/**
 * server.js - Production Ready
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

// Middleware
app.use(cors());
app.use(express.json());

/* ----------------------------
   PRODUCTION CONFIG - Environment Variables
   ---------------------------- */

const PG_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'nexusdb',
  user: process.env.DB_USER || 'nexususer',
  password: process.env.DB_PASSWORD || 'Developer12',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
};

const JWT_SECRET = process.env.JWT_SECRET || '4578ppoo9098989988925155222';

const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  user: process.env.EMAIL_USER || 'ogbchiemena@gmail.com',
  pass: process.env.EMAIL_PASS || 'yfzg mocj afzl bozh'
};

const OTP_EXP_MINUTES = 5;
const SALT_ROUNDS = 10;

/* ----------------------------
   DB Pool with Error Handling
   ---------------------------- */
const pool = new Pool(PG_CONFIG);

// Test database connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
});

async function dbQuery(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

/* ----------------------------
   Nodemailer with Error Handling
   ---------------------------- */
let transporter;
try {
  transporter = nodemailer.createTransport({
    host: EMAIL_CONFIG.host,
    port: EMAIL_CONFIG.port,
    secure: EMAIL_CONFIG.port === 465,
    auth: {
      user: EMAIL_CONFIG.user,
      pass: EMAIL_CONFIG.pass
    }
  });
} catch (error) {
  console.error('❌ Email transporter setup failed:', error);
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(toEmail, otp) {
  if (!transporter) {
    console.error('Email transporter not available');
    return false;
  }
  
  try {
    const mail = {
      from: EMAIL_CONFIG.user,
      to: toEmail,
      subject: 'Nexus password reset code',
      text: `Your OTP code: ${otp}. It expires in ${OTP_EXP_MINUTES} minutes.`,
      html: `<p>Your OTP code: <strong>${otp}</strong></p><p>It expires in ${OTP_EXP_MINUTES} minutes.</p>`
    };
    await transporter.sendMail(mail);
    return true;
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    return false;
  }
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
   HEALTH CHECK - Important for Render
   ---------------------------- */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

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
      // Check if user already exists
      const existingUser = await dbQuery('SELECT * FROM users1 WHERE email = $1', [email]);
      if (existingUser.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      await dbQuery('INSERT INTO users1 (email, password) VALUES ($1, $2)', [email, hashed]);
      res.json({ message: 'Signup successful' });
    } catch (err) {
      console.error('Signup error:', err);
      res.status(500).json({ error: 'Signup failed' });
    }
  }
);

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await dbQuery('SELECT * FROM users1 WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ 
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// REQUEST RESET
app.post('/api/auth/request-reset', async (req, res) => {
  const { email } = req.body;
  const otp = generateOtp();
  try {
    // Check if user exists
    const userCheck = await dbQuery('SELECT * FROM users1 WHERE email = $1', [email]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await dbQuery(
      'UPDATE users1 SET reset_otp = $1, reset_expires = NOW() + INTERVAL \'5 minutes\' WHERE email = $2',
      [otp, email]
    );
    
    const emailSent = await sendOtpEmail(email, otp);
    if (!emailSent) {
      return res.status(500).json({ error: 'Failed to send OTP email' });
    }
    
    res.json({ message: 'OTP sent to email' });
  } catch (err) {
    console.error('Request reset error:', err);
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
    await dbQuery(
      'UPDATE users1 SET password=$1, reset_otp=NULL, reset_expires=NULL WHERE email=$2',
      [hashed, email]
    );
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error('Verify reset error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// CHANGE PASSWORD
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
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Change password failed' });
  }
});

// GET USER PROFILE
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const result = await dbQuery('SELECT id, email FROM users1 WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

/* ----------------------------
   FRONTEND SERVING
   ---------------------------- */
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

/* ----------------------------
   ERROR HANDLING MIDDLEWARE
   ---------------------------- */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

/* ----------------------------
   START SERVER
   ---------------------------- */
const PORT = process.env.PORT || 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});