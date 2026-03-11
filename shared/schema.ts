import { pgTable, text, varchar, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const traders = pgTable("traders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  accessToken: text("access_token"),
  mobileNumber: text("mobile_number"),
  mpin: text("mpin"),
  ucc: text("ucc"),
  hasCredentials: boolean("has_credentials").default(false),
  brokerageSaved: integer("brokerage_saved").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTraderSchema = createInsertSchema(traders).pick({
  email: true,
}).extend({
  password: z.string().min(6),
});

export type InsertTrader = z.infer<typeof insertTraderSchema>;
export type Trader = typeof traders.$inferSelect;

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
