import * as fs from "fs";
import * as path from "path";
import { log } from "./index";
import { fetchScripPaths, type KotakSession } from "./kotak";
import type { OptionEntry } from "@shared/schema";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const optionsDb: Record<string, Record<string, Record<number, Record<string, OptionEntry>>>> = {};
const expiryList: Record<string, Array<{ date: Date; label: string }>> = {};
const spotCache: Record<string, { price: number; updated: number }> = {};
const cacheFiles: Record<string, string> = {};

function parseExpiryFromSymbol(ts: string, prefix: string): Date | null {
  const rest = ts.slice(prefix.length);

  const monthly = rest.match(/^(\d{2})([A-Z]{3})/);
  if (monthly) {
    const day = parseInt(monthly[1]);
    const month = MONTHS[monthly[2]] || 0;
    if (month && day >= 1 && day <= 31) {
      const now = new Date();
      for (const yr of [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() - 1]) {
        try {
          const d = new Date(yr, month - 1, day);
          if (d.getFullYear() >= 2025 && d.getDate() === day && d.getMonth() === month - 1) return d;
        } catch { continue; }
      }
    }
  }

  if (rest.length >= 5) {
    const yr = parseInt(rest.slice(0, 2));
    const year = 2000 + yr;
    if (year < 2025 || year > 2030) return null;
    const remaining = rest.slice(2);

    if (remaining.length >= 4) {
      const m2 = parseInt(remaining.slice(0, 2));
      const d2 = parseInt(remaining.slice(2, 4));
      if (m2 >= 10 && m2 <= 12 && d2 >= 1 && d2 <= 31) {
        try {
          const d = new Date(year, m2 - 1, d2);
          if (d.getDate() === d2 && d.getMonth() === m2 - 1) return d;
        } catch { /* skip */ }
      }
    }

    if (remaining.length >= 3) {
      const m1 = parseInt(remaining.slice(0, 1));
      const d1 = parseInt(remaining.slice(1, 3));
      if (m1 >= 1 && m1 <= 9 && d1 >= 1 && d1 <= 31) {
        try {
          const d = new Date(year, m1 - 1, d1);
          if (d.getDate() === d1 && d.getMonth() === m1 - 1) return d;
        } catch { /* skip */ }
      }
    }
  }

  return null;
}

function formatExpiryLabel(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${day}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function parseCSV(content: string, neededCols: string[]): Array<Record<string, string>> {
  const lines = content.split("\n");
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim().replace(/;/g, "").replace(/"/g, ""));
  const colIndices: Record<string, number> = {};
  for (const col of neededCols) {
    const idx = header.indexOf(col);
    if (idx >= 0) colIndices[col] = idx;
  }

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    const row: Record<string, string> = {};
    for (const [col, idx] of Object.entries(colIndices)) {
      row[col] = (parts[idx] || "").trim().replace(/"/g, "");
    }
    rows.push(row);
  }

  return rows;
}

export function buildOptionsDb(indexName: string) {
  const key = indexName.toUpperCase();
  const csvKey = ["NIFTY", "BANKNIFTY", "FINNIFTY"].includes(key) ? "nse_fo" : "bse_fo";
  const csvPath = cacheFiles[csvKey];
  if (!csvPath || !fs.existsSync(csvPath)) {
    log(`No CSV for ${key}`, "optionsDb");
    return;
  }

  const t0 = Date.now();
  const content = fs.readFileSync(csvPath, "utf-8");

  const needed = ["pSymbol", "pExchSeg", "pTrdSymbol", "pOptionType", "lLotSize", "pSymbolName", "pInstType", "dStrikePrice"];
  const rows = parseCSV(content, needed);

  const filtered = rows.filter(row => {
    const symName = (row.pSymbolName || "").toUpperCase();
    const optType = row.pOptionType || "";
    if (symName !== key) return false;
    if (!["CE", "PE"].includes(optType)) return false;
    if (["NIFTY", "BANKNIFTY", "FINNIFTY"].includes(key)) {
      if ((row.pInstType || "").toUpperCase() !== "OPTIDX") return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    log(`No options found for ${key}`, "optionsDb");
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const db: Record<string, Record<number, Record<string, OptionEntry>>> = {};
  const expiriesSet = new Map<string, Date>();

  for (const row of filtered) {
    const strikeNum = parseFloat(row.dStrikePrice || "0") / 100.0;
    if (isNaN(strikeNum) || strikeNum <= 0) continue;

    const ts = (row.pTrdSymbol || "").toUpperCase();
    const d = parseExpiryFromSymbol(ts, key);
    if (!d || d.getFullYear() > 2030) continue;

    const label = formatExpiryLabel(d);
    const strike = strikeNum;
    const opt = row.pOptionType || "";

    if (!db[label]) db[label] = {};
    if (!db[label][strike]) db[label][strike] = {};

    const lot = parseInt(row.lLotSize || "1") || 1;

    db[label][strike][opt] = {
      ts,
      symbol: row.pSymbol || "",
      seg: row.pExchSeg || "",
      lot,
    };

    if (d >= today) {
      expiriesSet.set(label, d);
    }
  }

  optionsDb[key] = db;

  const sortedExpiries = Array.from(expiriesSet.entries())
    .map(([label, date]) => ({ date, label }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  expiryList[key] = sortedExpiries;

  const elapsed = Date.now() - t0;
  const totalStrikes = Object.values(db).reduce((sum, exp) => sum + Object.keys(exp).length, 0);

  for (const e of sortedExpiries.slice(0, 8)) {
    const strikeCount = Object.keys(db[e.label] || {}).length;
    log(`  ${e.label}: ${strikeCount} strikes`, "optionsDb");
  }

  log(`${key} DB built: ${sortedExpiries.length} expiries, ${totalStrikes} strike-entries, ${elapsed}ms`, "optionsDb");
}

export function queryChainFast(indexName: string, spot: number, numStrikes = 5, expiryLabel = "") {
  const key = indexName.toUpperCase();
  const db = optionsDb[key];
  if (!db) return { error: `No data for ${key}. Loading...` };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expList = expiryList[key] || [];

  let targetLabel = "";
  if (expiryLabel) {
    targetLabel = expiryLabel;
  } else {
    for (const e of expList) {
      if (e.date >= today) { targetLabel = e.label; break; }
    }
  }

  if (!targetLabel && expList.length > 0) targetLabel = expList[0].label;
  if (!targetLabel) return { error: `No expiries for ${key}` };

  const strikesData = db[targetLabel];
  if (!strikesData) return { error: `No data for ${key} ${targetLabel}` };

  const allStrikes = Object.keys(strikesData).map(Number).sort((a, b) => a - b);
  if (allStrikes.length === 0) return { error: "No strikes" };

  const stepMap: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, FINNIFTY: 50 };
  const step = stepMap[key] || 50;

  let atm = allStrikes[0];
  let minDiff = Math.abs(atm - spot);
  for (const s of allStrikes) {
    const diff = Math.abs(s - spot);
    if (diff < minDiff) { atm = s; minDiff = diff; }
  }

  const atmIdx = allStrikes.indexOf(atm);
  const start = Math.max(0, atmIdx - numStrikes);
  const end = Math.min(allStrikes.length, atmIdx + numStrikes + 1);
  const selected = allStrikes.slice(start, end);

  let lotSize = 1;
  const chain = selected.map(strike => {
    const row: any = { strike, is_atm: Math.abs(strike - atm) < step / 2 };
    const sdata = strikesData[strike] || {};

    for (const ot of ["CE", "PE"]) {
      const info = sdata[ot];
      const prefix = ot.toLowerCase();
      if (info) {
        row[`${prefix}_ts`] = info.ts;
        row[`${prefix}_symbol`] = info.symbol;
        row[`${prefix}_seg`] = info.seg;
        row[`${prefix}_lot`] = info.lot;
        if (lotSize === 1) lotSize = info.lot;
      } else {
        row[`${prefix}_ts`] = "";
        row[`${prefix}_symbol`] = "";
        row[`${prefix}_seg`] = "";
        row[`${prefix}_lot`] = 1;
      }
    }
    return row;
  });

  return {
    atm_strike: atm,
    spot_price: spot,
    chain,
    index: key,
    expiry: targetLabel,
    total_strikes: allStrikes.length,
    step,
    lot_size: lotSize,
  };
}

export function getExpiries(indexName: string) {
  const key = indexName.toUpperCase();
  const lst = expiryList[key] || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let nearest = "";
  for (const e of lst) {
    if (e.date >= today) { nearest = e.label; break; }
  }

  return {
    expiries: lst.map(e => ({ label: e.label, is_nearest: e.label === nearest })),
    index: key,
  };
}

export async function downloadCsv(indexName: string, session?: KotakSession) {
  const key = indexName.toUpperCase();
  const csvKey = ["NIFTY", "BANKNIFTY", "FINNIFTY"].includes(key) ? "nse_fo" : "bse_fo";
  const todayStr = new Date().toISOString().split("T")[0];
  const filePath = path.join(DATA_DIR, `${csvKey}_${todayStr}.csv`);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
    cacheFiles[csvKey] = filePath;
    return filePath;
  }

  if (!session) return "";
  const paths = await fetchScripPaths(session);
  const target = paths.filter((p: string) => p.includes(csvKey));
  if (target.length === 0) return "";

  log(`Downloading ${csvKey}...`, "optionsDb");
  const res = await fetch(target[0]);
  const text = await res.text();

  const firstNewline = text.indexOf("\n");
  let content = text;
  if (firstNewline > 0) {
    const headerLine = text.slice(0, firstNewline);
    const restOfFile = text.slice(firstNewline + 1);
    const cleanHeader = headerLine.split(",").map(c => c.trim().replace(/;/g, "")).join(",");
    content = cleanHeader + "\n" + restOfFile;
  }

  fs.writeFileSync(filePath, content);
  const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
  log(`Saved ${csvKey}: ${sizeMB.toFixed(1)}MB`, "optionsDb");
  cacheFiles[csvKey] = filePath;

  for (const fn of fs.readdirSync(DATA_DIR)) {
    if (fn.startsWith(csvKey) && !fn.includes(todayStr)) {
      fs.unlinkSync(path.join(DATA_DIR, fn));
    }
  }

  return filePath;
}

export function getCachedSpot(idx: string): number {
  const key = idx.toUpperCase();
  const cached = spotCache[key];
  if (cached && (Date.now() - cached.updated) < 10000) return cached.price;
  return 0;
}

export function setCachedSpot(idx: string, price: number) {
  spotCache[idx.toUpperCase()] = { price, updated: Date.now() };
}

export function clearAll() {
  for (const key in optionsDb) delete optionsDb[key];
  for (const key in expiryList) delete expiryList[key];
  for (const key in spotCache) delete spotCache[key];
}
