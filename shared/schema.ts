import { sql } from "drizzle-orm";
import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export interface OptionEntry {
  ts: string;
  symbol: string;
  seg: string;
  lot: number;
}

export interface ChainRow {
  strike: number;
  is_atm: boolean;
  ce_ts: string;
  ce_symbol: string;
  ce_seg: string;
  ce_lot: number;
  pe_ts: string;
  pe_symbol: string;
  pe_seg: string;
  pe_lot: number;
}

export interface ChainResult {
  atm_strike: number;
  spot_price: number;
  chain: ChainRow[];
  index: string;
  expiry: string;
  total_strikes: number;
  step: number;
  lot_size: number;
  error?: string;
}

export interface ExpiryInfo {
  label: string;
  is_nearest: boolean;
}
