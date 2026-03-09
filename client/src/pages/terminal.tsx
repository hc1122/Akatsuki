import { useState, useEffect, useCallback, useRef } from "react";

interface ChainRow {
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

interface ToastItem {
  id: number;
  msg: string;
  type: "success" | "error" | "info";
}

let toastId = 0;

export default function Terminal() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [greeting, setGreeting] = useState("");
  const [totp, setTotp] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [currentIndex, setCurrentIndex] = useState("NIFTY");
  const [expiries, setExpiries] = useState<Array<{ label: string; is_nearest: boolean }>>([]);
  const [selectedExpiry, setSelectedExpiry] = useState("");
  const [numStrikes, setNumStrikes] = useState(5);
  const [spotPrice, setSpotPrice] = useState(0);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [chainLoading, setChainLoading] = useState(false);
  const [selectedStrike, setSelectedStrike] = useState<ChainRow | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [lots, setLots] = useState(1);
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [funds, setFunds] = useState({ available: "--", used: "--", collateral: "--" });
  const [wsConnected, setWsConnected] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [clock, setClock] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const spotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chainBodyRef = useRef<HTMLTableSectionElement>(null);

  const addToast = useCallback((msg: string, type: "success" | "error" | "info" = "info") => {
    const id = ++toastId;
    setToasts(prev => [...prev.slice(-4), { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      setClock(
        String(n.getHours()).padStart(2, "0") + ":" +
        String(n.getMinutes()).padStart(2, "0") + ":" +
        String(n.getSeconds()).padStart(2, "0")
      );
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    fetch("/api/session")
      .then(r => r.json())
      .then((d: any) => {
        if (d.logged_in) {
          setLoggedIn(true);
          setGreeting(d.greeting || "");
        }
      })
      .catch(() => {});
  }, []);

  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectWs = useCallback(() => {
    if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
    if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      setWsConnected(true);
      pingRef.current = setInterval(() => {
        if (ws.readyState === 1) ws.send("ping");
      }, 25000);
    };
    ws.onclose = () => {
      setWsConnected(false);
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      reconnectRef.current = setTimeout(connectWs, 3000);
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "order_result") {
          const d = m.data;
          const ms = m.elapsed >= 0 ? ` (${m.elapsed}ms)` : "";
          if (d.stat === "Ok" || d.nOrdNo) {
            addToast(`${m.action || "Order"} #${d.nOrdNo || ""}${ms}`, "success");
          } else {
            addToast(`${m.action || "Order"} failed: ${d.emsg || d.errMsg || ""}${ms}`, "error");
          }
          loadOrders();
          loadPositions();
        } else if (m.type === "order_update" || m.type === "order_cancelled") {
          const d = m.data;
          if (d.stat === "Ok" || d.nOrdNo) {
            addToast(`${m.action || "Order"} #${d.nOrdNo || ""}`, "success");
          } else {
            addToast(d.emsg || d.errMsg || "Order failed", "error");
          }
          loadOrders();
          loadPositions();
        } else if (m.type === "instruments_ready") {
          addToast(`${m.index} instruments loaded`, "info");
        } else if (m.type === "close_all") {
          loadPositions();
          loadOrders();
        }
      } catch {}
    };
  }, [addToast]);

  const refreshSpot = useCallback(async () => {
    try {
      const r = await (await fetch(`/api/spot/${currentIndex}`)).json();
      const p = parseFloat(r.spot);
      if (p > 0) setSpotPrice(p);
    } catch {}
  }, [currentIndex]);

  const loadExpiries = useCallback(async () => {
    try {
      const r = await (await fetch(`/api/expiries/${currentIndex}`)).json();
      const exps = r.expiries || [];
      setExpiries(exps);
      const nearest = exps.find((e: any) => e.is_nearest);
      if (nearest) setSelectedExpiry(nearest.label);
      else if (exps.length > 0) setSelectedExpiry(exps[0].label);
    } catch {}
  }, [currentIndex]);

  const loadChain = useCallback(async () => {
    setChainLoading(true);
    setSelectedStrike(null);
    setSelectedIdx(-1);
    try {
      const r = await (await fetch(
        `/api/option-chain/${currentIndex}?strikes=${numStrikes}&expiry=${encodeURIComponent(selectedExpiry)}`
      )).json();
      if (r.error) {
        setChain([]);
        setChainLoading(false);
        return;
      }
      if (r.spot_price) setSpotPrice(parseFloat(r.spot_price));
      const c = r.chain || [];
      setChain(c);
      const atmIdx = c.findIndex((row: any) => row.is_atm);
      if (atmIdx >= 0) {
        setSelectedStrike(c[atmIdx]);
        setSelectedIdx(atmIdx);
      }
    } catch {}
    setChainLoading(false);
  }, [currentIndex, numStrikes, selectedExpiry]);

  const loadPositions = useCallback(async () => {
    try {
      const r = await (await fetch("/api/positions")).json();
      if (r.stat === "Ok" && r.data?.length) {
        setPositions(r.data);
      } else {
        setPositions([]);
      }
    } catch { setPositions([]); }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const r = await (await fetch("/api/orderbook")).json();
      if (r.stat === "Ok" && r.data?.length) {
        setOrders([...r.data].reverse());
      } else {
        setOrders([]);
      }
    } catch { setOrders([]); }
  }, []);

  const loadLimits = useCallback(async () => {
    try {
      const r = await (await fetch("/api/limits")).json();
      if (r.stat === "Ok") {
        const fmt = (v: any) => "\u20B9" + parseFloat(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
        setFunds({
          available: fmt(r.Net),
          used: fmt(r.MarginUsed),
          collateral: fmt(r.CollateralValue),
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    connectWs();
    loadLimits();
    loadPositions();
    loadOrders();
    const limitsIv = setInterval(loadLimits, 30000);
    return () => {
      clearInterval(limitsIv);
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    loadExpiries();
    refreshSpot();
    if (spotTimerRef.current) clearInterval(spotTimerRef.current);
    spotTimerRef.current = setInterval(refreshSpot, 3000);
    return () => {
      if (spotTimerRef.current) clearInterval(spotTimerRef.current);
    };
  }, [loggedIn, currentIndex]);

  useEffect(() => {
    if (loggedIn && selectedExpiry) loadChain();
  }, [loggedIn, currentIndex, numStrikes, selectedExpiry]);

  const doLogin = async () => {
    if (totp.length !== 6) { addToast("Enter 6-digit TOTP", "error"); return; }
    setLoggingIn(true);
    try {
      const r = await (await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totp }),
      })).json();
      if (r.status === "success") {
        addToast(`Welcome, ${r.greeting || "Trader"}`, "success");
        setLoggedIn(true);
        setGreeting(r.greeting || "");
      } else {
        addToast(r.message || "Login failed", "error");
      }
    } catch { addToast("Connection error", "error"); }
    setLoggingIn(false);
  };

  const doLogout = async () => {
    if (!confirm("Logout and end trading session?")) return;
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    setLoggedIn(false);
    setGreeting("");
    setTotp("");
    setChain([]);
    setPositions([]);
    setOrders([]);
    setSpotPrice(0);
    setSelectedStrike(null);
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (spotTimerRef.current) clearInterval(spotTimerRef.current);
    addToast("Logged out successfully", "info");
  };

  const precomputedRef = useRef<Record<string, string>>({});
  const strikeRef = useRef<ChainRow | null>(null);
  const lotsRef = useRef(1);

  useEffect(() => { strikeRef.current = selectedStrike; }, [selectedStrike]);
  useEffect(() => { lotsRef.current = lots; }, [lots]);

  useEffect(() => {
    if (!selectedStrike) { precomputedRef.current = {}; return; }
    const builds: Record<string, string> = {};
    for (const ot of ["CE", "PE"]) {
      const p = ot.toLowerCase();
      const ts = (selectedStrike as any)[`${p}_ts`];
      const es = (selectedStrike as any)[`${p}_seg`];
      const lotSize = (selectedStrike as any)[`${p}_lot`] || 1;
      if (!ts) continue;
      for (const tt of ["B", "S"]) {
        const qty = lotSize * lots;
        const jData = JSON.stringify({
          am: "NO", dq: "0", es, mp: "0", pc: "MIS", pf: "N",
          pr: "0", pt: "MKT", qt: String(qty), rt: "DAY", tp: "0", ts, tt,
        });
        builds[`${tt}_${ot}`] = jData;
      }
    }
    precomputedRef.current = builds;
  }, [selectedStrike, lots]);

  const fire = useCallback((tt: string, ot: string) => {
    const strike = strikeRef.current;
    if (!strike) { addToast("Select a strike first", "error"); return; }

    const key = `${tt}_${ot}`;
    const jData = precomputedRef.current[key];
    if (!jData) { addToast("No symbol available", "error"); return; }

    const action = `${tt === "B" ? "BUY" : "SELL"} ${ot} ${strike.strike}`;
    addToast(`${action} x${lotsRef.current} sent`, "info");

    fetch("/api/order/fast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jData, action }),
    }).catch(() => addToast("Network error", "error"));
  }, [addToast]);

  useEffect(() => {
    if (!loggedIn) return;
    const handler = (e: KeyboardEvent) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === "Numpad1" || (e.key === "1" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("B", "CE"); }
      else if (e.code === "Numpad3" || (e.key === "3" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("S", "CE"); }
      else if (e.code === "Numpad7" || (e.key === "7" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("B", "PE"); }
      else if (e.code === "Numpad9" || (e.key === "9" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("S", "PE"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loggedIn, fire]);

  const pickStrike = (i: number) => {
    if (!chain[i]) return;
    setSelectedStrike(chain[i]);
    setSelectedIdx(i);
  };

  const closeAllPositions = async () => {
    if (!confirm("Close ALL open positions at market price?")) return;
    try {
      const r = await (await fetch("/api/order/close-all", { method: "POST" })).json();
      if (r.status === "ok") {
        addToast(`Closing ${r.closed} position(s) at market...`, "info");
        setTimeout(() => { loadPositions(); loadOrders(); }, 1500);
      } else { addToast(r.message || "Close all failed", "error"); }
    } catch { addToast("Network error", "error"); }
  };

  const cancelOrd = async (n: string) => {
    try {
      const r = await (await fetch("/api/order/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: n }),
      })).json();
      if (r.stat === "Ok") addToast("Order cancelled", "success");
      else addToast(r.emsg || "Cancel failed", "error");
      loadOrders();
    } catch { addToast("Network error", "error"); }
  };

  const fmtPrice = (p: number) => p.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtStrike = (s: number) => s.toLocaleString("en-IN");

  const totalPnl = positions.reduce((sum, p) => {
    const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? 0);
    const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? 0);
    return sum + parseFloat(p.unrealizedMTOM ?? p.realizedMTOM ?? (sa - ba));
  }, 0);

  const switchIndex = (idx: string) => {
    setCurrentIndex(idx);
    setSelectedStrike(null);
    setSelectedIdx(-1);
    setChain([]);
  };

  if (!loggedIn) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "var(--t-bg)" }} data-testid="login-overlay">
        <div
          className="w-[380px] p-9 rounded-2xl text-center animate-fade-in"
          style={{ background: "var(--t-sf)", border: "1px solid var(--t-bd)", boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}
        >
          <div className="text-5xl mb-4">&#x1F510;</div>
          <h1 className="text-xl font-bold mb-1" style={{ color: "var(--t-tx)" }}>Welcome Back</h1>
          <p className="text-xs mb-6" style={{ color: "var(--t-tx3)" }}>Enter your 6-digit TOTP to start trading</p>
          <input
            data-testid="input-totp"
            type="text"
            value={totp}
            onChange={e => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={e => e.key === "Enter" && doLogin()}
            placeholder="000000"
            maxLength={6}
            autoFocus
            className="w-full p-3.5 rounded-lg font-mono text-2xl text-center tracking-[12px] outline-none transition-all"
            style={{
              background: "var(--t-bg)",
              border: "1px solid var(--t-bd)",
              color: "var(--t-tx)",
            }}
          />
          <button
            data-testid="button-login"
            onClick={doLogin}
            disabled={loggingIn}
            className="w-full p-3.5 mt-3.5 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, var(--t-bl) 0%, var(--t-bl2) 100%)" }}
          >
            {loggingIn ? "Connecting..." : "Connect & Login"}
          </button>
        </div>
        <ToastContainer toasts={toasts} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen" style={{ background: "var(--t-bg)" }}>
      {/* HEADER */}
      <header
        className="flex items-center justify-between px-5 h-12 sticky top-0 z-50 shrink-0"
        style={{ background: "linear-gradient(180deg, var(--t-sf) 0%, var(--t-bg2) 100%)", borderBottom: "1px solid var(--t-bd)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="text-xl">&#x26A1;</span>
          <span className="font-mono text-[15px] font-bold" style={{ color: "var(--t-bl)", letterSpacing: "-0.5px" }}>SCALPER</span>
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-xl font-semibold"
            style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)", border: "1px solid rgba(59,130,246,.2)" }}
          >v2</span>
        </div>
        <div className="flex items-center gap-3.5">
          <span className="font-mono text-[11px]" style={{ color: "var(--t-tx3)" }} data-testid="text-clock">{clock}</span>
          <span className="text-[11px] font-medium" style={{ color: "var(--t-tx2)" }} data-testid="text-username">{greeting}</span>
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
            style={wsConnected ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}
            data-testid="status-pill"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "animate-pulse-dot" : ""}`}
              style={{ background: wsConnected ? "var(--t-gn)" : "var(--t-rd)" }}
            />
            <span>{wsConnected ? "Live" : "Offline"}</span>
          </div>
          <button
            data-testid="button-logout"
            onClick={doLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all"
            style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}
          >
            &#x23FB; Logout
          </button>
        </div>
      </header>

      {/* FUNDS BAR */}
      <div
        className="flex items-center gap-0.5 px-4 h-8 text-[11px] shrink-0"
        style={{ background: "var(--t-bg2)", borderBottom: "1px solid var(--t-bd)" }}
      >
        <FundItem label="Available" value={funds.available} />
        <div className="w-px h-4 mx-3" style={{ background: "var(--t-bd)" }} />
        <FundItem label="Used" value={funds.used} />
        <div className="w-px h-4 mx-3" style={{ background: "var(--t-bd)" }} />
        <FundItem label="Collateral" value={funds.collateral} />
      </div>

      {/* CONTROLS */}
      <div
        className="flex items-center gap-2 px-4 py-2 shrink-0 flex-wrap"
        style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}
      >
        <CtrlGroup label="Index">
          <select
            data-testid="select-index"
            value={currentIndex}
            onChange={e => switchIndex(e.target.value)}
            className="ctrl-select"
          >
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANK NIFTY</option>
            <option value="SENSEX">SENSEX</option>
          </select>
        </CtrlGroup>
        <CtrlGroup label="Expiry">
          <select
            data-testid="select-expiry"
            value={selectedExpiry}
            onChange={e => setSelectedExpiry(e.target.value)}
            className="ctrl-select"
          >
            {expiries.map(exp => (
              <option key={exp.label} value={exp.label}>{exp.label}</option>
            ))}
          </select>
        </CtrlGroup>
        <CtrlGroup label="Strikes">
          <select
            data-testid="select-strikes"
            value={numStrikes}
            onChange={e => setNumStrikes(parseInt(e.target.value))}
            className="ctrl-select"
          >
            <option value="3">&plusmn;3</option>
            <option value="5">&plusmn;5</option>
            <option value="10">&plusmn;10</option>
            <option value="15">&plusmn;15</option>
          </select>
        </CtrlGroup>
        <button
          data-testid="button-refresh-chain"
          onClick={loadChain}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all"
          style={{ background: "var(--t-sf2)", color: "var(--t-tx2)", border: "1px solid var(--t-bd)" }}
        >
          &#x21BB; Refresh
        </button>
        <div className="flex-1" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Spot</span>
          <span
            className="font-mono text-[22px] font-bold"
            style={{ color: "var(--t-yw)", textShadow: "0 0 20px rgba(245,158,11,.15)" }}
            data-testid="text-spot-price"
          >
            {spotPrice > 0 ? fmtPrice(spotPrice) : "--"}
          </span>
        </div>
      </div>

      {/* ACTION BAR */}
      <div
        className="flex items-center px-5 gap-0 shrink-0"
        style={{
          background: "linear-gradient(180deg, var(--t-sf) 0%, var(--t-bg2) 100%)",
          borderBottom: "2px solid var(--t-bd)",
          minHeight: "70px",
        }}
      >
        {/* CE Side */}
        <div className="flex items-center gap-3 shrink-0 pr-6 mr-5" style={{ borderRight: "1px solid var(--t-bd)" }}>
          <div className="flex flex-col items-center gap-1.5">
            <span
              className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded"
              style={{ background: "rgba(16,185,129,.08)", color: "var(--t-gn)", border: "1px solid rgba(16,185,129,.15)" }}
            >CALL</span>
            <div className="text-[9px] text-center whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>1</kbd> buy
              <br />
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>3</kbd> sell
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <ActionButton data-testid="button-buy-ce" variant="buy" disabled={!selectedStrike?.ce_ts} onClick={() => fire("B", "CE")}>
              &#x25B2; BUY CE
            </ActionButton>
            <ActionButton data-testid="button-sell-ce" variant="sell" disabled={!selectedStrike?.ce_ts} onClick={() => fire("S", "CE")}>
              &#x25BC; SELL CE
            </ActionButton>
          </div>
        </div>

        {/* Center */}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-5">
          <div className="flex items-center gap-2.5 font-mono text-[13px] justify-center flex-wrap" data-testid="text-selected-strike">
            {selectedStrike ? (
              <>
                <span className="text-lg font-bold" style={{ color: "var(--t-yw)" }}>{fmtStrike(selectedStrike.strike)}</span>
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ color: "var(--t-tx3)", background: "var(--t-sf2)" }}>
                  CE: {selectedStrike.ce_ts || "N/A"}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ color: "var(--t-tx3)", background: "var(--t-sf2)" }}>
                  PE: {selectedStrike.pe_ts || "N/A"}
                </span>
              </>
            ) : (
              <span className="text-xs italic" style={{ color: "var(--t-tx3)" }}>Select a strike from the option chain below</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>LOTS</span>
            <button
              data-testid="button-lot-minus"
              onClick={() => setLots(Math.max(1, lots - 1))}
              className="w-6 h-6 flex items-center justify-center rounded font-bold text-[15px] select-none transition-all"
              style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
            >&minus;</button>
            <input
              data-testid="input-lots"
              type="number"
              value={lots}
              onChange={e => setLots(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              className="w-14 py-1 px-1.5 rounded text-center font-mono text-base font-bold outline-none transition-all"
              style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
            />
            <button
              data-testid="button-lot-plus"
              onClick={() => setLots(Math.min(50, lots + 1))}
              className="w-6 h-6 flex items-center justify-center rounded font-bold text-[15px] select-none transition-all"
              style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
            >+</button>
          </div>
        </div>

        {/* PE Side */}
        <div className="flex items-center gap-3 shrink-0 pl-6 ml-5" style={{ borderLeft: "1px solid var(--t-bd)" }}>
          <div className="flex flex-col gap-1.5">
            <ActionButton data-testid="button-buy-pe" variant="buy" disabled={!selectedStrike?.pe_ts} onClick={() => fire("B", "PE")}>
              &#x25B2; BUY PE
            </ActionButton>
            <ActionButton data-testid="button-sell-pe" variant="sell" disabled={!selectedStrike?.pe_ts} onClick={() => fire("S", "PE")}>
              &#x25BC; SELL PE
            </ActionButton>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span
              className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded"
              style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}
            >PUT</span>
            <div className="text-[9px] text-center whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>7</kbd> buy
              <br />
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>9</kbd> sell
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* OPTION CHAIN TABLE */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="py-2 px-1.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: "var(--t-sf)", borderBottom: "2px solid var(--t-bd)", color: "var(--t-gn)" }}>CE Symbol</th>
                <th className="py-2 px-1.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: "var(--t-sf)", borderBottom: "2px solid var(--t-bd)", color: "var(--t-gn)" }}>CE Lot</th>
                <th className="py-2 px-1.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: "var(--t-sf)", borderBottom: "2px solid var(--t-bd)", color: "var(--t-yw)" }}>Strike</th>
                <th className="py-2 px-1.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: "var(--t-sf)", borderBottom: "2px solid var(--t-bd)", color: "var(--t-rd)" }}>PE Lot</th>
                <th className="py-2 px-1.5 text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: "var(--t-sf)", borderBottom: "2px solid var(--t-bd)", color: "var(--t-rd)" }}>PE Symbol</th>
              </tr>
            </thead>
            <tbody ref={chainBodyRef}>
              {chainLoading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center">
                    <div className="inline-block w-5 h-5 rounded-full animate-spin-slow" style={{ border: "2px solid var(--t-bd)", borderTopColor: "var(--t-bl)" }} />
                  </td>
                </tr>
              ) : chain.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-[11px]" style={{ color: "var(--t-tx3)" }}>
                    {expiries.length === 0 ? "Loading instruments..." : "No data available"}
                  </td>
                </tr>
              ) : chain.map((row, i) => (
                <tr
                  key={row.strike}
                  data-testid={`row-strike-${row.strike}`}
                  onClick={() => pickStrike(i)}
                  className="cursor-pointer transition-colors"
                  style={{
                    background: selectedIdx === i
                      ? "rgba(245,158,11,.12)"
                      : row.is_atm
                        ? "rgba(59,130,246,.08)"
                        : "transparent",
                    borderBottom: "1px solid rgba(36,48,73,.5)",
                    ...(selectedIdx === i ? { boxShadow: "inset 3px 0 0 var(--t-yw)" } : {}),
                    ...(row.is_atm ? { borderTop: "1px solid rgba(59,130,246,.2)", borderBottom: "1px solid rgba(59,130,246,.2)" } : {}),
                  }}
                >
                  <td className="py-1.5 px-1.5 text-center font-mono text-[10px] max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
                    {row.ce_ts || "\u2014"}
                  </td>
                  <td className="py-1.5 px-1.5 text-center text-[10px]" style={{ color: "var(--t-tx3)" }}>
                    {row.ce_ts ? row.ce_lot : "\u2014"}
                  </td>
                  <td className="py-1.5 px-1.5 text-center font-mono font-bold text-sm" style={{ color: "var(--t-yw)" }}>
                    {fmtStrike(row.strike)}
                    {row.is_atm && (
                      <span
                        className="inline-block text-[8px] px-1.5 py-px ml-1 rounded font-bold align-middle tracking-wider"
                        style={{ background: "rgba(59,130,246,.2)", color: "var(--t-bl)" }}
                      >ATM</span>
                    )}
                  </td>
                  <td className="py-1.5 px-1.5 text-center text-[10px]" style={{ color: "var(--t-tx3)" }}>
                    {row.pe_ts ? row.pe_lot : "\u2014"}
                  </td>
                  <td className="py-1.5 px-1.5 text-center font-mono text-[10px] max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
                    {row.pe_ts || "\u2014"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* BOTTOM PANELS */}
        <div className="grid grid-cols-2 shrink-0" style={{ borderTop: "1px solid var(--t-bd)", maxHeight: "260px" }}>
          {/* Positions */}
          <div className="flex flex-col overflow-hidden" style={{ borderRight: "1px solid var(--t-bd)" }}>
            <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--t-tx2)" }}>
                &#x1F4CA; Positions
                <span className="text-[9px] px-1.5 py-px rounded-lg font-semibold" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }} data-testid="text-pos-count">
                  {positions.length}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  data-testid="button-close-all"
                  onClick={closeAllPositions}
                  className="px-2.5 py-0.5 rounded text-[10px] font-bold transition-all"
                  style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}
                >&#x2715; Close All</button>
                <button
                  data-testid="button-refresh-positions"
                  onClick={loadPositions}
                  className="px-2 py-0.5 rounded text-[10px] transition-all"
                  style={{ background: "transparent", border: "1px solid var(--t-bd)", color: "var(--t-tx3)" }}
                >&#x21BB;</button>
              </div>
            </div>
            {positions.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1 shrink-0 text-[11px]" style={{ background: "var(--t-bg2)", borderBottom: "1px solid var(--t-bd)" }}>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Net P&L</span>
                <span className={`font-mono font-bold text-[13px] ${totalPnl >= 0 ? "" : ""}`} style={{ color: totalPnl > 0 ? "var(--t-gn)" : totalPnl < 0 ? "var(--t-rd)" : "var(--t-tx3)" }} data-testid="text-total-pnl">
                  {totalPnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(totalPnl).toFixed(2)}
                </span>
              </div>
            )}
            <div className="flex-1 overflow-y-auto py-0.5">
              {positions.length === 0 ? (
                <div className="py-5 text-center text-[11px]" style={{ color: "var(--t-tx3)" }}>No open positions</div>
              ) : positions.map((p, i) => {
                const qty = parseInt(p.netQty ?? p.cfNetQty ?? p.qty ?? 0);
                const buyQty = parseInt(p.buyQty ?? p.cfBuyQty ?? 0);
                const sellQty = parseInt(p.sellQty ?? p.cfSellQty ?? 0);
                const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? 0);
                const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? 0);
                const pnl = parseFloat(p.unrealizedMTOM ?? p.realizedMTOM ?? (sa - ba));
                const avgPx = buyQty > 0 ? (ba / buyQty).toFixed(2) : sellQty > 0 ? (sa / sellQty).toFixed(2) : "--";
                const sym = p.trdSym ?? p.sym ?? p.tsym ?? "--";
                const isLong = qty >= 0;
                const displayQty = buyQty || sellQty || Math.abs(qty);
                return (
                  <div key={i} data-testid={`row-position-${i}`} className="grid items-center gap-2 px-3 py-1.5 text-[11px] transition-colors" style={{ gridTemplateColumns: "1fr auto auto auto", borderBottom: "1px solid rgba(36,48,73,.4)" }}>
                    <span className="font-mono font-semibold text-[10px] flex items-center gap-1.5">
                      {sym}
                      <span className="text-[8px] px-1.5 py-px rounded font-semibold" style={isLong ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}>
                        {isLong ? "LONG" : "SHORT"}
                      </span>
                    </span>
                    <span className="font-mono text-[10px]" style={{ color: "var(--t-tx2)" }}>Qty: {displayQty}</span>
                    <span className="font-mono text-[10px]" style={{ color: "var(--t-tx3)" }}>@{"\u20B9"}{avgPx}</span>
                    <span className="font-mono font-semibold text-[11px]" style={{ color: pnl >= 0 ? "var(--t-gn)" : "var(--t-rd)" }}>
                      {pnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(pnl).toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Orders */}
          <div className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--t-tx2)" }}>
                &#x1F4CB; Orders
                <span className="text-[9px] px-1.5 py-px rounded-lg font-semibold" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }} data-testid="text-ord-count">
                  {orders.length}
                </span>
              </div>
              <button
                data-testid="button-refresh-orders"
                onClick={loadOrders}
                className="px-2 py-0.5 rounded text-[10px] transition-all"
                style={{ background: "transparent", border: "1px solid var(--t-bd)", color: "var(--t-tx3)" }}
              >&#x21BB;</button>
            </div>
            <div className="flex-1 overflow-y-auto py-0.5">
              {orders.length === 0 ? (
                <div className="py-5 text-center text-[11px]" style={{ color: "var(--t-tx3)" }}>No orders today</div>
              ) : orders.slice(0, 50).map((o, i) => {
                const isBuy = o.trnsTp === "B";
                const st = (o.ordSt || "").toLowerCase();
                let stCls = "pending";
                if (st.includes("reject")) stCls = "rejected";
                else if (st.includes("complete") || st.includes("traded")) stCls = "complete";
                else if (st.includes("open") || st.includes("trigger")) stCls = "open";

                const fillPx = o.flPrc || o.avgPrc;
                const ordPx = o.prc;
                let dispPx = "--";
                if (fillPx && parseFloat(fillPx) > 0) dispPx = parseFloat(fillPx).toFixed(2);
                else if (ordPx && parseFloat(ordPx) > 0) dispPx = parseFloat(ordPx).toFixed(2);
                else dispPx = "MKT";

                const rawT = o.ordTm || o.exTm || o.ordGenTm || "";
                const tm = rawT.match(/(\d{2}:\d{2}:\d{2})/);
                const timeStr = tm ? tm[1] : "";

                const statusColors: Record<string, { bg: string; color: string }> = {
                  complete: { bg: "rgba(16,185,129,.08)", color: "var(--t-gn)" },
                  rejected: { bg: "rgba(239,68,68,.08)", color: "var(--t-rd)" },
                  open: { bg: "rgba(245,158,11,.12)", color: "var(--t-yw)" },
                  pending: { bg: "rgba(59,130,246,.1)", color: "var(--t-bl)" },
                };
                const sc = statusColors[stCls] || statusColors.pending;

                return (
                  <div key={i} data-testid={`row-order-${i}`} className="grid items-center gap-2 px-3 py-1.5 text-[11px] transition-colors" style={{ gridTemplateColumns: "18px 1fr auto auto auto auto", borderBottom: "1px solid rgba(36,48,73,.4)" }}>
                    <div
                      className="w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={isBuy ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}
                    >{isBuy ? "B" : "S"}</div>
                    <span className="font-mono font-medium text-[10px] overflow-hidden text-ellipsis whitespace-nowrap">{o.trdSym}</span>
                    <span className="font-mono font-semibold text-[10px]" style={{ color: "var(--t-yw)" }}>{dispPx}</span>
                    <span className="font-mono text-[10px]" style={{ color: "var(--t-tx2)" }}>{o.qty}</span>
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider whitespace-nowrap"
                      style={{ background: sc.bg, color: sc.color }}
                    >{o.ordSt}</span>
                    {stCls === "open" ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); cancelOrd(o.nOrdNo); }}
                        className="px-2 py-0.5 rounded text-[9px] font-semibold transition-all"
                        style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}
                        data-testid={`button-cancel-order-${i}`}
                      >&#x2715;</button>
                    ) : timeStr ? (
                      <span className="font-mono text-[9px]" style={{ color: "var(--t-tx3)" }}>{timeStr}</span>
                    ) : <span />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <ToastContainer toasts={toasts} />
    </div>
  );
}

function FundItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1 px-3">
      <span style={{ color: "var(--t-tx3)" }}>{label}</span>
      <span className="font-mono font-semibold" style={{ color: "var(--t-tx)" }} data-testid={`text-fund-${label.toLowerCase()}`}>{value}</span>
    </div>
  );
}

function CtrlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider font-semibold mr-0.5" style={{ color: "var(--t-tx3)" }}>{label}</span>
      {children}
    </div>
  );
}

function ActionButton({ variant, disabled, onClick, children, ...props }: {
  variant: "buy" | "sell";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  [key: string]: any;
}) {
  const bg = variant === "buy"
    ? "linear-gradient(135deg, #10b981 0%, #059669 100%)"
    : "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)";

  return (
    <button
      {...props}
      onClick={onClick}
      disabled={disabled}
      className="py-2 px-5 rounded-md font-mono text-[11px] font-bold text-white tracking-wider flex items-center justify-center gap-1.5 transition-all whitespace-nowrap min-w-[112px] disabled:opacity-25 disabled:cursor-not-allowed"
      style={{
        background: bg,
        boxShadow: disabled ? "none" : "0 1px 3px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.2)",
      }}
    >
      {children}
    </button>
  );
}

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  const icons: Record<string, string> = { success: "\u2705", error: "\u274C", info: "\u2139\uFE0F" };
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    success: { bg: "rgba(16,185,129,.15)", color: "var(--t-gn)", border: "rgba(16,185,129,.15)" },
    error: { bg: "rgba(239,68,68,.15)", color: "var(--t-rd)", border: "rgba(239,68,68,.15)" },
    info: { bg: "rgba(59,130,246,.15)", color: "var(--t-bl)", border: "rgba(59,130,246,.2)" },
  };

  return (
    <div className="fixed bottom-4 right-4 z-[999] flex flex-col-reverse gap-1.5">
      {toasts.map(t => {
        const s = styles[t.type] || styles.info;
        return (
          <div
            key={t.id}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium max-w-[360px] animate-toast-in backdrop-blur-sm"
            style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`, boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}
            data-testid={`toast-${t.type}`}
          >
            <span className="text-sm shrink-0">{icons[t.type]}</span>
            <span className="flex-1">{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
