import { traders, type Trader } from "@shared/schema";
import { db } from "./db";
import { eq, sql } from "drizzle-orm";
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import bcrypt from "bcryptjs";

const ENCRYPT_KEY = (process.env.SESSION_SECRET || "kotak-scalper-secret-2025").padEnd(32, "0").slice(0, 32);

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(ENCRYPT_KEY), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(data: string): string {
  const [ivHex, encrypted] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPT_KEY), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createTrader(email: string, password: string): Promise<Trader> {
  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  const [trader] = await db.insert(traders).values({
    id,
    email: email.toLowerCase().trim(),
    passwordHash,
  }).returning();
  return trader;
}

export async function getTraderByEmail(email: string): Promise<Trader | undefined> {
  const [trader] = await db.select().from(traders).where(eq(traders.email, email.toLowerCase().trim()));
  return trader;
}

export async function getTraderById(id: string): Promise<Trader | undefined> {
  const [trader] = await db.select().from(traders).where(eq(traders.id, id));
  return trader;
}

export async function saveKotakCredentials(
  traderId: string,
  creds: { accessToken: string; mobileNumber: string; mpin: string; ucc: string }
): Promise<void> {
  await db.update(traders).set({
    accessToken: encrypt(creds.accessToken),
    mobileNumber: encrypt(creds.mobileNumber),
    mpin: encrypt(creds.mpin),
    ucc: encrypt(creds.ucc),
    hasCredentials: true,
  }).where(eq(traders.id, traderId));
}

export function decryptCredentials(trader: Trader): { accessToken: string; mobileNumber: string; mpin: string; ucc: string } | null {
  if (!trader.accessToken || !trader.mobileNumber || !trader.mpin || !trader.ucc) return null;
  try {
    return {
      accessToken: decrypt(trader.accessToken),
      mobileNumber: decrypt(trader.mobileNumber),
      mpin: decrypt(trader.mpin),
      ucc: decrypt(trader.ucc),
    };
  } catch {
    return null;
  }
}

export async function incrementBrokerageSaved(traderId: string, amount: number = 10): Promise<number> {
  const result = await db.execute(
    sql`UPDATE traders SET brokerage_saved = brokerage_saved + ${amount} WHERE id = ${traderId} RETURNING brokerage_saved`
  );
  return (result.rows[0] as any)?.brokerage_saved || 0;
}

export async function getBrokerageSaved(traderId: string): Promise<number> {
  const [result] = await db.select({ brokerageSaved: traders.brokerageSaved }).from(traders).where(eq(traders.id, traderId));
  return result?.brokerageSaved || 0;
}
