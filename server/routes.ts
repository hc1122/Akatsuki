import type { Express } from "express";
import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as kotak from "./kotak";
import * as optionsDb from "./optionsDb";
import { log } from "./index";

const wsClients: WebSocket[] = [];

function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  const dead: WebSocket[] = [];
  for (const ws of wsClients) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      else dead.push(ws);
    } catch { dead.push(ws); }
  }
  for (const ws of dead) {
    const idx = wsClients.indexOf(ws);
    if (idx >= 0) wsClients.splice(idx, 1);
  }
}

let spotInterval: ReturnType<typeof setInterval> | null = null;

function startSpotCache() {
  if (spotInterval) clearInterval(spotInterval);
  spotInterval = setInterval(async () => {
    if (!kotak.sessionState.loggedIn) return;
    for (const idx of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      try {
        const price = await kotak.getSpot(idx);
        if (price > 0) optionsDb.setCachedSpot(idx, price);
      } catch { /* skip */ }
    }
  }, 2000);
}

async function preload() {
  await new Promise(r => setTimeout(r, 500));
  for (const idx of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
    try {
      await optionsDb.downloadCsv(idx);
      optionsDb.buildOptionsDb(idx);
      broadcast({ type: "instruments_ready", index: idx });
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
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws) => {
    wsClients.push(ws);
    ws.on("close", () => {
      const idx = wsClients.indexOf(ws);
      if (idx >= 0) wsClients.splice(idx, 1);
    });
    ws.on("message", () => {});
  });

  app.post("/api/login", async (req, res) => {
    try {
      const { totp } = req.body;
      if (!totp) return res.status(400).json({ status: "error", message: "TOTP required" });

      const r1 = await kotak.loginWithTotp(totp);
      if (r1.status !== "success") return res.json(r1);

      const r2 = await kotak.validateMpin();
      if (r2.status === "success") {
        startSpotCache();
        preload();
      }
      return res.json(r2);
    } catch (e: any) {
      return res.json({ status: "error", message: e.message });
    }
  });

  app.get("/api/session", (_req, res) => {
    res.json({ logged_in: kotak.sessionState.loggedIn, greeting: kotak.sessionState.greetingName });
  });

  app.get("/api/spot/:idx", async (req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    const idx = req.params.idx.toUpperCase();
    let price = optionsDb.getCachedSpot(idx);
    if (price <= 0) {
      price = await kotak.getSpot(idx);
      if (price > 0) optionsDb.setCachedSpot(idx, price);
    }
    res.json({ index: idx, spot: price });
  });

  app.get("/api/expiries/:idx", (_req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    res.json(optionsDb.getExpiries(_req.params.idx));
  });

  app.get("/api/option-chain/:idx", async (req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    const idx = req.params.idx.toUpperCase();
    const strikes = parseInt(req.query.strikes as string) || 5;
    const expiry = (req.query.expiry as string) || "";

    let price = optionsDb.getCachedSpot(idx);
    if (price <= 0) price = await kotak.getSpot(idx);
    if (price <= 0) return res.json({ error: "No spot price" });

    const t0 = Date.now();
    const result = optionsDb.queryChainFast(idx, price, strikes, expiry);
    log(`Chain query: ${Date.now() - t0}ms`, "chain");
    res.json(result);
  });

  app.post("/api/order/quick", async (req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    const { tt, ts, es, lot, symbol } = req.body;
    if (!tt || !ts || !es) return res.json({ stat: "Not_Ok", emsg: "Missing params" });

    const qty = parseInt(lot) || 1;
    let r = await kotak.placeOrder(es, ts, tt, qty);

    if (r.stat === "Not_Ok" && ((r.errMsg || "") + (r.emsg || "")).includes("LTP")) {
      log(`MKT rejected, trying limit for ${ts}...`, "order");
      if (symbol && es) {
        const q = await kotak.fetchQuote(es, symbol, "ltp");
        const ltp = parseFloat(q?.ltp || "0");
        if (ltp > 0) {
          const pr = (ltp * (tt === "B" ? 1.002 : 0.998)).toFixed(2);
          r = await kotak.placeOrder(es, ts, tt, qty, "MIS", "L", pr);
        }
      }
    }

    broadcast({ type: "order_update", data: r, action: `${tt === "B" ? "BUY" : "SELL"} ${ts} x${qty}` });
    res.json(r);
  });

  app.post("/api/order/cancel", async (req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    const r = await kotak.cancelOrder(req.body.on);
    broadcast({ type: "order_cancelled", data: r });
    res.json(r);
  });

  app.get("/api/orderbook", async (_req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    res.json(await kotak.getOrderbook());
  });

  app.get("/api/positions", async (_req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    res.json(await kotak.getPositions());
  });

  app.get("/api/limits", async (_req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    res.json(await kotak.getLimits());
  });

  app.post("/api/order/close-all", async (_req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    try {
      const posResp: any = await kotak.getPositions();
      if (posResp.stat !== "Ok" || !posResp.data?.length) {
        return res.json({ status: "error", message: "No positions to close" });
      }
      const results: any[] = [];
      for (const pos of posResp.data) {
        const netQty = parseInt(pos.netQty ?? pos.qty ?? "0");
        if (netQty === 0) continue;
        const ts = pos.trdSym || "";
        const es = pos.seg || pos.exSeg || "nse_fo";
        const tt = netQty > 0 ? "S" : "B";
        const qty = Math.abs(netQty);
        if (!ts || !es) continue;
        const r = await kotak.placeOrder(es, ts, tt, qty);
        results.push({ symbol: ts, qty, side: tt, result: r });
      }
      broadcast({ type: "close_all", count: results.length });
      res.json({ status: "ok", closed: results.length, results });
    } catch (e: any) {
      res.json({ status: "error", message: e.message });
    }
  });

  app.post("/api/reload/:idx", async (req, res) => {
    if (!kotak.sessionState.loggedIn) return res.status(401).json({ error: "Not logged in" });
    const key = req.params.idx.toUpperCase();
    try {
      await optionsDb.downloadCsv(key);
      optionsDb.buildOptionsDb(key);
      broadcast({ type: "instruments_ready", index: key });
      res.json({ status: "ok", index: key });
    } catch (e: any) {
      res.json({ status: "error", message: e.message });
    }
  });

  app.post("/api/logout", (_req, res) => {
    kotak.logout();
    optionsDb.clearAll();
    if (spotInterval) { clearInterval(spotInterval); spotInterval = null; }
    res.json({ status: "success" });
  });

  return httpServer;
}
