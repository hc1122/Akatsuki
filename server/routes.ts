import type { Express, Request, Response } from "express";
import { type Server, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import session from "express-session";
import * as kotak from "./kotak";
import * as optionsDb from "./optionsDb";
import * as storage from "./storage";
import { log } from "./index";

declare module "express-session" {
  interface SessionData {
    traderId?: string;
    kotakLoggedIn?: boolean;
  }
}

const wsClients = new Map<string, WebSocket[]>();

function broadcastToUser(userId: string, msg: object) {
  const data = JSON.stringify(msg);
  const clients = wsClients.get(userId) || [];
  const dead: WebSocket[] = [];
  for (const ws of clients) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      else dead.push(ws);
    } catch { dead.push(ws); }
  }
  for (const ws of dead) {
    const idx = clients.indexOf(ws);
    if (idx >= 0) clients.splice(idx, 1);
  }
}

function requireAuth(req: Request, res: Response): string | null {
  const traderId = req.session?.traderId;
  if (!traderId) { res.status(401).json({ error: "Not authenticated" }); return null; }
  return traderId;
}

function requireKotak(req: Request, res: Response): kotak.KotakSession | null {
  const traderId = requireAuth(req, res);
  if (!traderId) return null;
  const s = kotak.getSession(traderId);
  if (!s || !s.loggedIn) { res.status(401).json({ error: "Kotak not connected" }); return null; }
  return s;
}

const spotIntervals = new Map<string, ReturnType<typeof setInterval>>();

function startSpotCache(userId: string) {
  if (spotIntervals.has(userId)) clearInterval(spotIntervals.get(userId)!);
  spotIntervals.set(userId, setInterval(async () => {
    const s = kotak.getSession(userId);
    if (!s || !s.loggedIn) { clearInterval(spotIntervals.get(userId)!); spotIntervals.delete(userId); return; }
    for (const idx of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      try {
        const price = await kotak.getSpot(s, idx);
        if (price > 0) optionsDb.setCachedSpot(idx, price);
      } catch { /* skip */ }
    }
  }, 2000));
}

async function preload(userId: string) {
  const s = kotak.getSession(userId);
  if (!s || !s.loggedIn) return;
  await new Promise(r => setTimeout(r, 500));
  for (const idx of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
    try {
      await optionsDb.downloadCsv(idx, s);
      optionsDb.buildOptionsDb(idx);
      broadcastToUser(userId, { type: "instruments_ready", index: idx });
    } catch (e: any) {
      log(`${idx} preload error: ${e.message}`, "preload");
    }
    await new Promise(r => setTimeout(r, 200));
  }
  log("All instruments loaded into memory", "preload");
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const sessionSecret = process.env.SESSION_SECRET || "kotak-scalper-secret-2025";
  const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    },
  });
  app.use(sessionMiddleware);

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws, req) => {
    let userId = "";

    sessionMiddleware(req as any, {} as any, () => {
      const sess = (req as any).session;
      if (sess?.traderId) {
        userId = sess.traderId;
        const clients = wsClients.get(userId) || [];
        clients.push(ws);
        wsClients.set(userId, clients);
      }
    });

    ws.on("message", () => {});

    ws.on("close", () => {
      if (!userId) return;
      const clients = wsClients.get(userId) || [];
      const idx = clients.indexOf(ws);
      if (idx >= 0) clients.splice(idx, 1);
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ status: "error", message: "Email and password required" });
      if (password.length < 6) return res.status(400).json({ status: "error", message: "Password must be at least 6 characters" });

      const existing = await storage.getTraderByEmail(email);
      if (existing) return res.status(400).json({ status: "error", message: "Email already registered" });

      const trader = await storage.createTrader(email, password);
      req.session.traderId = trader.id;
      res.json({ status: "success", hasCredentials: false, traderId: trader.id });
    } catch (e: any) {
      log(`Register error: ${e.message}`, "auth");
      res.status(500).json({ status: "error", message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ status: "error", message: "Email and password required" });

      const trader = await storage.getTraderByEmail(email);
      if (!trader) return res.status(401).json({ status: "error", message: "Invalid email or password" });

      if (!(await storage.verifyPassword(password, trader.passwordHash))) {
        return res.status(401).json({ status: "error", message: "Invalid email or password" });
      }

      req.session.traderId = trader.id;
      res.json({
        status: "success",
        hasCredentials: !!trader.hasCredentials,
        email: trader.email,
        traderId: trader.id,
      });
    } catch (e: any) {
      log(`Login error: ${e.message}`, "auth");
      res.status(500).json({ status: "error", message: "Login failed" });
    }
  });

  app.post("/api/auth/credentials", async (req, res) => {
    const traderId = requireAuth(req, res);
    if (!traderId) return;

    const { accessToken, mobileNumber, mpin, ucc } = req.body;
    if (!accessToken || !mobileNumber || !mpin || !ucc) {
      return res.status(400).json({ status: "error", message: "All credential fields required" });
    }

    try {
      await storage.saveKotakCredentials(traderId, { accessToken, mobileNumber, mpin, ucc });
      res.json({ status: "success" });
    } catch (e: any) {
      log(`Save credentials error: ${e.message}`, "auth");
      res.status(500).json({ status: "error", message: "Failed to save credentials" });
    }
  });

  app.get("/api/auth/session", async (req, res) => {
    const traderId = req.session?.traderId;
    if (!traderId) return res.json({ authenticated: false });

    const trader = await storage.getTraderById(traderId);
    if (!trader) return res.json({ authenticated: false });

    const kotakSession = kotak.getSession(traderId);
    res.json({
      authenticated: true,
      email: trader.email,
      hasCredentials: !!trader.hasCredentials,
      kotakConnected: kotakSession?.loggedIn || false,
      greeting: kotakSession?.greetingName || "",
      traderId: trader.id,
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    const traderId = req.session?.traderId;
    if (traderId) {
      const s = kotak.getSession(traderId);
      if (s) kotak.logoutSession(s);
      kotak.removeSession(traderId);
      if (spotIntervals.has(traderId)) {
        clearInterval(spotIntervals.get(traderId)!);
        spotIntervals.delete(traderId);
      }
    }
    req.session.destroy(() => {});
    res.json({ status: "success" });
  });

  app.post("/api/kotak/connect", async (req, res) => {
    const traderId = requireAuth(req, res);
    if (!traderId) return;

    const { totp } = req.body;
    if (!totp) return res.status(400).json({ status: "error", message: "TOTP required" });

    try {
      const trader = await storage.getTraderById(traderId);
      if (!trader || !trader.hasCredentials) {
        return res.json({ status: "error", message: "Kotak credentials not configured" });
      }

      const creds = storage.decryptCredentials(trader);
      if (!creds) {
        return res.json({ status: "error", message: "Failed to decrypt credentials" });
      }

      const s = kotak.createSession(traderId, creds);

      const r1 = await kotak.loginWithTotp(s, totp);
      if (r1.status !== "success") {
        kotak.removeSession(traderId);
        return res.json(r1);
      }

      const r2 = await kotak.validateMpin(s);
      if (r2.status === "success") {
        req.session.kotakLoggedIn = true;
        startSpotCache(traderId);
        preload(traderId);
      } else {
        kotak.removeSession(traderId);
      }
      return res.json(r2);
    } catch (e: any) {
      return res.json({ status: "error", message: e.message });
    }
  });

  app.post("/api/kotak/disconnect", (req, res) => {
    const traderId = requireAuth(req, res);
    if (!traderId) return;

    const s = kotak.getSession(traderId);
    if (s) kotak.logoutSession(s);
    kotak.removeSession(traderId);
    req.session.kotakLoggedIn = false;
    if (spotIntervals.has(traderId)) {
      clearInterval(spotIntervals.get(traderId)!);
      spotIntervals.delete(traderId);
    }
    res.json({ status: "success" });
  });

  app.get("/api/spot/:idx", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const idx = req.params.idx.toUpperCase();
    let price = optionsDb.getCachedSpot(idx);
    if (price <= 0) {
      price = await kotak.getSpot(s, idx);
      if (price > 0) optionsDb.setCachedSpot(idx, price);
    }
    res.json({ index: idx, spot: price });
  });

  app.get("/api/expiries/:idx", (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    res.json(optionsDb.getExpiries(req.params.idx));
  });

  app.get("/api/option-chain/:idx", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const idx = req.params.idx.toUpperCase();
    const strikes = parseInt(req.query.strikes as string) || 5;
    const expiry = (req.query.expiry as string) || "";

    let price = optionsDb.getCachedSpot(idx);
    if (price <= 0) price = await kotak.getSpot(s, idx);
    if (price <= 0) return res.json({ error: "No spot price" });

    const result = optionsDb.queryChainFast(idx, price, strikes, expiry);
    res.json(result);
  });

  app.post("/api/order/fast", (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const { jData, action } = req.body;
    if (!jData) return res.status(400).json({ error: "Missing jData" });
    const userId = s.userId;

    res.json({ status: "sent", ts: Date.now() });

    (async () => {
      try {
        const t0 = Date.now();
        const result = await fetch(`${s.baseUrl}/quick/order/rule/ms/place`, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "Auth": s.sessionToken!,
            "Sid": s.sessionSid!,
            "neo-fin-key": "neotradeapi",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `jData=${jData}`,
        });
        const data = await result.json() as any;
        const elapsed = Date.now() - t0;
        log(`FAST ORDER ${elapsed}ms [${userId}]: ${JSON.stringify(data)}`, "order");

        if (data.stat === "Not_Ok" && ((data.errMsg || "") + (data.emsg || "")).includes("LTP")) {
          try {
            const parsed = JSON.parse(jData);
            const q = await kotak.fetchQuote(s, parsed.es, parsed.ts, "ltp");
            const ltp = parseFloat(q?.ltp || "0");
            if (ltp > 0) {
              const pr = (ltp * (parsed.tt === "B" ? 1.002 : 0.998)).toFixed(2);
              const limitData = JSON.stringify({ ...parsed, pt: "L", pr });
              const r2 = await fetch(`${s.baseUrl}/quick/order/rule/ms/place`, {
                method: "POST",
                headers: {
                  "accept": "application/json",
                  "Auth": s.sessionToken!,
                  "Sid": s.sessionSid!,
                  "neo-fin-key": "neotradeapi",
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `jData=${limitData}`,
              });
              const d2 = await r2.json() as any;
              broadcastToUser(userId, { type: "order_result", data: d2, action: action || "", elapsed });
              return;
            }
          } catch {}
        }

        broadcastToUser(userId, { type: "order_result", data, action: action || "", elapsed });
      } catch (e: any) {
        log(`FAST ORDER error: ${e.message}`, "order");
        broadcastToUser(userId, { type: "order_result", data: { stat: "Not_Ok", emsg: e.message }, action: action || "", elapsed: -1 });
      }
    })();
  });

  app.post("/api/order/quick", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const { tt, ts, es, lot, symbol } = req.body;
    if (!tt || !ts || !es) return res.json({ stat: "Not_Ok", emsg: "Missing params" });

    const qty = parseInt(lot) || 1;
    let r = await kotak.placeOrder(s, es, ts, tt, qty);

    if (r.stat === "Not_Ok" && ((r.errMsg || "") + (r.emsg || "")).includes("LTP")) {
      if (symbol && es) {
        const q = await kotak.fetchQuote(s, es, symbol, "ltp");
        const ltp = parseFloat(q?.ltp || "0");
        if (ltp > 0) {
          const pr = (ltp * (tt === "B" ? 1.002 : 0.998)).toFixed(2);
          r = await kotak.placeOrder(s, es, ts, tt, qty, "MIS", "L", pr);
        }
      }
    }

    broadcastToUser(s.userId, { type: "order_update", data: r, action: `${tt === "B" ? "BUY" : "SELL"} ${ts} x${qty}` });
    res.json(r);
  });

  app.post("/api/order/cancel", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const r = await kotak.cancelOrder(s, req.body.on);
    broadcastToUser(s.userId, { type: "order_cancelled", data: r });
    res.json(r);
  });

  app.get("/api/orderbook", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    res.json(await kotak.getOrderbook(s));
  });

  app.get("/api/positions", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const posData: any = await kotak.getPositions(s);
    if (posData?.stat?.toLowerCase() === "ok" && Array.isArray(posData.data)) {
      const enrichPromises = posData.data.map(async (p: any) => {
        const buyQ = parseInt(p.flBuyQty ?? p.cfBuyQty ?? p.buyQty ?? "0");
        const sellQ = parseInt(p.flSellQty ?? p.cfSellQty ?? p.sellQty ?? "0");
        const netQty = p.netQty !== undefined ? parseInt(p.netQty) : (buyQ - sellQ);
        const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? "0");
        const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? "0");
        if (netQty !== 0) {
          try {
            const seg = p.exSeg || p.seg || "nse_fo";
            const sym = p.trdSym || "";
            const tok = p.tok || "";
            log(`OPEN POS: ${sym} tok=${tok} netQty=${netQty} ba=${ba} sa=${sa}`, "debug");
            let ltp = 0;
            if (tok) {
              const q = await kotak.fetchQuoteByToken(s, seg, tok, "ltp");
              ltp = parseFloat(q?.ltp || "0");
            }
            if (ltp <= 0 && sym) {
              const q2 = await kotak.fetchQuote(s, seg, sym, "ltp");
              ltp = parseFloat(q2?.ltp || "0");
            }
            log(`LTP for ${sym}: ${ltp}`, "debug");
            if (ltp > 0) {
              p._ltp = ltp;
              if (netQty > 0) {
                p._pnl = (ltp * netQty) - ba;
              } else {
                p._pnl = sa - (ltp * Math.abs(netQty));
              }
              log(`CALC PNL: ${sym} _pnl=${p._pnl}`, "debug");
            } else {
              p._pnl = sa - ba;
              log(`LTP=0, fallback PNL: ${sym} _pnl=${p._pnl}`, "debug");
            }
          } catch (err: any) {
            log(`LTP fetch error for ${p.trdSym}: ${err.message}`, "debug");
            p._pnl = sa - ba;
          }
        } else {
          p._pnl = sa - ba;
        }
        return p;
      });
      posData.data = await Promise.all(enrichPromises);
    }
    res.json(posData);
  });

  app.post("/api/ltp", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const { tokens } = req.body;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.json({ stat: "ok", data: {} });
    }
    const result: Record<string, number> = {};
    await Promise.all(tokens.map(async (t: { seg: string; sym: string; tok?: string }) => {
      try {
        let ltp = 0;
        if (t.tok) {
          const q = await kotak.fetchQuoteByToken(s, t.seg, t.tok, "ltp");
          ltp = parseFloat(q?.ltp || "0");
        }
        if (ltp <= 0 && t.sym) {
          const q2 = await kotak.fetchQuote(s, t.seg, t.sym, "ltp");
          ltp = parseFloat(q2?.ltp || "0");
        }
        if (ltp > 0) result[t.sym] = ltp;
        else log(`LTP=0 for ${t.sym} tok=${t.tok}`, "debug");
      } catch {}
    }));
    res.json({ stat: "ok", data: result });
  });

  app.get("/api/limits", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    res.json(await kotak.getLimits(s));
  });

  app.post("/api/order/close-all", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    try {
      const posResp: any = await kotak.getPositions(s);
      const pStat = (posResp.stat || "").toLowerCase();
      if (pStat !== "ok" || !posResp.data?.length) {
        return res.json({ status: "error", message: "No positions to close" });
      }
      const results: any[] = [];
      for (const pos of posResp.data) {
        const buyQ = parseInt(pos.flBuyQty ?? pos.cfBuyQty ?? pos.buyQty ?? "0");
        const sellQ = parseInt(pos.flSellQty ?? pos.cfSellQty ?? pos.sellQty ?? "0");
        const netQty = pos.netQty !== undefined ? parseInt(pos.netQty) : (buyQ - sellQ);
        if (netQty === 0) continue;
        const ts = pos.trdSym || "";
        const es = pos.seg || pos.exSeg || "nse_fo";
        const tt = netQty > 0 ? "S" : "B";
        const qty = Math.abs(netQty);
        if (!ts || !es) continue;
        const r = await kotak.placeOrder(s, es, ts, tt, qty);
        results.push({ symbol: ts, qty, side: tt, result: r });
      }
      broadcastToUser(s.userId, { type: "close_all", count: results.length });
      res.json({ status: "ok", closed: results.length, results });
    } catch (e: any) {
      res.json({ status: "error", message: e.message });
    }
  });

  app.post("/api/reload/:idx", async (req, res) => {
    const s = requireKotak(req, res);
    if (!s) return;
    const key = req.params.idx.toUpperCase();
    try {
      await optionsDb.downloadCsv(key, s);
      optionsDb.buildOptionsDb(key);
      broadcastToUser(s.userId, { type: "instruments_ready", index: key });
      res.json({ status: "ok", index: key });
    } catch (e: any) {
      res.json({ status: "error", message: e.message });
    }
  });

  return httpServer;
}
