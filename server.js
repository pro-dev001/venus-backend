/**
 * server.js - Stable Production Version for Render
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

/* ----------------------------
   DATABASE CONFIG (Render Compatible)
   ---------------------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // <-- Render's database URL
  ssl: {
    rejectUnauthorized: false, // Required for Render PostgreSQL
  },
});

// Test DB
pool.on("connect", () => console.log("✅ Connected to Render PostgreSQL"));
pool.on("error", (err) => console.error("❌ DB Error:", err));

async function dbQuery(text, params) {
  const result = await pool.query(text, params);
  return result;
}

/* ----------------------------
   CREATE TABLE IF NOT EXISTS
   ---------------------------- */
(async () => {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS users1 (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        reset_otp VARCHAR(10),
        reset_expires TIMESTAMP
      );
    `);
    console.log("✅ Table users1 ready");
  } catch (err) {
    console.error("❌ Table creation error:", err);
  }
})();

/* ----------------------------
   EMAIL + SECURITY SETTINGS
   ---------------------------- */
const JWT_SECRET =
  process.env.JWT_SECRET || "4578ppoo9098989988925155222";

const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  user: process.env.EMAIL_USER || "ogbchiemena@gmail.com",
  pass: process.env.EMAIL_PASS || "yfzg mocj afzl bozh",
};

const SALT_ROUNDS = 10;
const OTP_EXP_MINUTES = 5;

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: EMAIL_CONFIG.host,
  port: EMAIL_CONFIG.port,
  secure: EMAIL_CONFIG.port === 465,
  auth: {
    user: EMAIL_CONFIG.user,
    pass: EMAIL_CONFIG.pass,
  },
});

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(toEmail, otp) {
  try {
    await transporter.sendMail({
      from: EMAIL_CONFIG.user,
      to: toEmail,
      subject: "Nexus password reset code",
      html: `<p>Your OTP code is <strong>${otp}</strong></p><p>Expires in ${OTP_EXP_MINUTES} minutes.</p>`,
    });
    return true;
  } catch (err) {
    console.error("❌ Email error:", err);
    return false;
  }
}

/* ----------------------------
   AUTH MIDDLEWARE
   ---------------------------- */
function verifyToken(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "No token provided" });

  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token)
    return res.status(401).json({ error: "Malformed token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/* ----------------------------
   ROUTES
   ---------------------------- */

// Health Check (for Render)
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toISOString(),
  });
});

// SIGNUP
app.post(
  "/api/auth/signup",
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const exists = await dbQuery(
        "SELECT * FROM users1 WHERE email=$1",
        [email]
      );
      if (exists.rows.length > 0)
        return res.status(400).json({ error: "User already exists" });

      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      await dbQuery("INSERT INTO users1 (email, password) VALUES ($1, $2)", [
        email,
        hashed,
      ]);
      res.json({ message: "Signup successful" });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Signup failed" });
    }
  }
);

// LOGIN
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await dbQuery("SELECT * FROM users1 WHERE email=$1", [
      email,
    ]);
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// REQUEST RESET
app.post("/api/auth/request-reset", async (req, res) => {
  const { email } = req.body;
  const otp = generateOtp();

  try {
    const user = await dbQuery("SELECT * FROM users1 WHERE email=$1", [email]);
    if (user.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    await dbQuery(
      "UPDATE users1 SET reset_otp=$1, reset_expires=NOW() + INTERVAL '5 minutes' WHERE email=$2",
      [otp, email]
    );

    const sent = await sendOtpEmail(email, otp);
    if (!sent) return res.status(500).json({ error: "Email send failed" });

    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("Request reset error:", err);
    res.status(500).json({ error: "Request failed" });
  }
});

// VERIFY RESET
app.post("/api/auth/verify-reset", async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const check = await dbQuery(
      "SELECT * FROM users1 WHERE email=$1 AND reset_otp=$2 AND reset_expires > NOW()",
      [email, otp]
    );
    if (check.rows.length === 0)
      return res.status(400).json({ error: "Invalid or expired OTP" });

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await dbQuery(
      "UPDATE users1 SET password=$1, reset_otp=NULL, reset_expires=NULL WHERE email=$2",
      [hashed, email]
    );

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Verify reset error:", err);
    res.status(500).json({ error: "Reset failed" });
  }
});

// GET USER PROFILE
app.get("/api/auth/me", verifyToken, async (req, res) => {
  try {
    const user = await dbQuery("SELECT id, email FROM users1 WHERE id=$1", [
      req.user.id,
    ]);
    if (user.rows.length === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ user: user.rows[0] });
  } catch (err) {
    console.error("Get user error:", err);
    res.status(500).json({ error: "Profile fetch failed" });
  }
});

/* ----------------------------
   GLOBAL ERROR HANDLER
   ---------------------------- */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

/* ----------------------------
   START SERVER
   ---------------------------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
});
