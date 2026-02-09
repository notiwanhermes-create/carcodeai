import { cookies } from "next/headers";
import pool, { ensureDB } from "./db";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: string): Promise<string> {
  await ensureDB();
  const sid = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    "INSERT INTO sessions (sid, user_id, expires_at) VALUES ($1, $2, $3)",
    [sid, userId, expiresAt]
  );
  return sid;
}

export async function getSessionUser(): Promise<{
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_image: string | null;
} | null> {
  try {
    await ensureDB();
    const cookieStore = await cookies();
    const sid = cookieStore.get("carcode_sid")?.value;
    if (!sid) return null;

    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.profile_image
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.sid = $1 AND s.expires_at > NOW()`,
      [sid]
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

export async function registerUser(email: string, password: string, firstName?: string, lastName?: string): Promise<{ userId: string } | { error: string }> {
  await ensureDB();

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomBytes(16).toString("hex");

  try {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, email.toLowerCase(), passwordHash, firstName || null, lastName || null]
    );
  } catch (e: any) {
    if (e?.code === "23505") {
      return { error: "An account with this email already exists." };
    }
    throw e;
  }

  return { userId };
}

export async function loginUser(email: string, password: string): Promise<{ userId: string } | { error: string }> {
  await ensureDB();

  const result = await pool.query(
    "SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1)",
    [email]
  );

  if (result.rows.length === 0) {
    return { error: "Invalid email or password." };
  }

  const user = result.rows[0];

  if (!user.password_hash) {
    return { error: "This account uses Google sign-in. Please use the Google button." };
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return { error: "Invalid email or password." };
  }

  return { userId: user.id };
}

export async function findOrCreateGoogleUser(googleId: string, email: string, firstName?: string, lastName?: string, profileImage?: string): Promise<string> {
  await ensureDB();

  const existing = await pool.query("SELECT id FROM users WHERE google_id = $1", [googleId]);
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const byEmail = await pool.query("SELECT id, google_id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  if (byEmail.rows.length > 0) {
    await pool.query("UPDATE users SET google_id = $1, profile_image = COALESCE(profile_image, $2) WHERE id = $3", [googleId, profileImage || null, byEmail.rows[0].id]);
    return byEmail.rows[0].id;
  }

  const userId = randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO users (id, email, google_id, first_name, last_name, profile_image)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, email.toLowerCase(), googleId, firstName || null, lastName || null, profileImage || null]
  );
  return userId;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sid = cookieStore.get("carcode_sid")?.value;
  if (sid) {
    await pool.query("DELETE FROM sessions WHERE sid = $1", [sid]);
  }
  cookieStore.delete("carcode_sid");
}
