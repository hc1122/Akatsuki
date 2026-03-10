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

type AuthStep = "login" | "credentials" | "totp" | "terminal";

export default function Terminal() {
  const [authStep, setAuthStep] = useState<AuthStep>("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [traderId, setTraderId] = useState("");

  const [credAccessToken, setCredAccessToken] = useState("");
  const [credMobile, setCredMobile] = useState("");
  const [credMpin, setCredMpin] = useState("");
  const [credUcc, setCredUcc] = useState("");
  const [credSaving, setCredSaving] = useState(false);

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
  const [showChain, setShowChain] = useState(false);
  const [showPositions, setShowPositions] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
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
    fetch("/api/auth/session", { credentials: "include" })
      .then(r => r.json())
      .then((d: any) => {
        if (d.authenticated) {
          setAuthEmail(d.email || "");
          setTraderId(d.traderId || "");
          if (d.kotakConnected) {
            setGreeting(d.greeting || "");
            setAuthStep("terminal");
          } else if (d.hasCredentials) {
            setAuthStep("totp");
          } else {
            setAuthStep("credentials");
          }
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
  }, [addToast, traderId]);

  const refreshSpot = useCallback(async () => {
    try {
      const r = await (await fetch(`/api/spot/${currentIndex}`, { credentials: "include" })).json();
      const p = parseFloat(r.spot);
      if (p > 0) setSpotPrice(p);
    } catch {}
  }, [currentIndex]);

  const loadExpiries = useCallback(async () => {
    try {
      const r = await (await fetch(`/api/expiries/${currentIndex}`, { credentials: "include" })).json();
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
        `/api/option-chain/${currentIndex}?strikes=${numStrikes}&expiry=${encodeURIComponent(selectedExpiry)}`,
        { credentials: "include" }
      )).json();
      if (r.error) { setChain([]); setChainLoading(false); return; }
      if (r.spot_price) setSpotPrice(parseFloat(r.spot_price));
      const c = r.chain || [];
      setChain(c);
      const atmIdx = c.findIndex((row: any) => row.is_atm);
      if (atmIdx >= 0) { setSelectedStrike(c[atmIdx]); setSelectedIdx(atmIdx); }
    } catch {}
    setChainLoading(false);
  }, [currentIndex, numStrikes, selectedExpiry]);

  const loadPositions = useCallback(async () => {
    try {
      const r = await (await fetch("/api/positions", { credentials: "include" })).json();
      const st = (r.stat || "").toLowerCase();
      if ((st === "ok") && r.data?.length) setPositions(r.data);
      else setPositions([]);
    } catch { setPositions([]); }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const r = await (await fetch("/api/orderbook", { credentials: "include" })).json();
      const st = (r.stat || "").toLowerCase();
      if ((st === "ok") && r.data?.length) {
        const sorted = [...r.data].sort((a: any, b: any) => {
          const ta = parseInt(a.boeSec || "0");
          const tb = parseInt(b.boeSec || "0");
          return tb - ta;
        });
        setOrders(sorted);
      } else setOrders([]);
    } catch { setOrders([]); }
  }, []);

  const loadLimits = useCallback(async () => {
    try {
      const r = await (await fetch("/api/limits", { credentials: "include" })).json();
      if (r.stat === "Ok") {
        const fmt = (v: any) => "\u20B9" + parseFloat(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
        setFunds({ available: fmt(r.Net), used: fmt(r.MarginUsed), collateral: fmt(r.CollateralValue) });
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (authStep !== "terminal") return;
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
  }, [authStep]);

  useEffect(() => {
    if (authStep !== "terminal") return;
    loadExpiries();
    refreshSpot();
    if (spotTimerRef.current) clearInterval(spotTimerRef.current);
    spotTimerRef.current = setInterval(refreshSpot, 3000);
    return () => { if (spotTimerRef.current) clearInterval(spotTimerRef.current); };
  }, [authStep, currentIndex]);

  useEffect(() => {
    if (authStep === "terminal" && selectedExpiry) loadChain();
  }, [authStep, currentIndex, numStrikes, selectedExpiry]);

  const doAuthLogin = async () => {
    if (!authEmail || !authPassword) { addToast("Email and password required", "error"); return; }
    if (isRegister && authPassword.length < 6) { addToast("Password must be at least 6 characters", "error"); return; }
    setAuthLoading(true);
    try {
      const url = isRegister ? "/api/auth/register" : "/api/auth/login";
      const r = await (await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      })).json();
      if (r.status === "success") {
        setTraderId(r.traderId || "");
        addToast(isRegister ? "Account created!" : "Logged in!", "success");
        if (r.hasCredentials) {
          setAuthStep("totp");
        } else {
          setAuthStep("credentials");
        }
      } else {
        addToast(r.message || "Failed", "error");
      }
    } catch { addToast("Connection error", "error"); }
    setAuthLoading(false);
  };

  const doSaveCredentials = async () => {
    if (!credAccessToken || !credMobile || !credMpin || !credUcc) {
      addToast("All fields are required", "error"); return;
    }
    setCredSaving(true);
    try {
      const r = await (await fetch("/api/auth/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ accessToken: credAccessToken, mobileNumber: credMobile, mpin: credMpin, ucc: credUcc }),
      })).json();
      if (r.status === "success") {
        addToast("Credentials saved!", "success");
        setAuthStep("totp");
      } else {
        addToast(r.message || "Failed", "error");
      }
    } catch { addToast("Connection error", "error"); }
    setCredSaving(false);
  };

  const doTotpLogin = async () => {
    if (totp.length !== 6) { addToast("Enter 6-digit TOTP", "error"); return; }
    setLoggingIn(true);
    try {
      const r = await (await fetch("/api/kotak/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ totp }),
      })).json();
      if (r.status === "success") {
        addToast(`Welcome, ${r.greeting || "Trader"}`, "success");
        setGreeting(r.greeting || "");
        setAuthStep("terminal");
      } else {
        addToast(r.message || "Login failed", "error");
      }
    } catch { addToast("Connection error", "error"); }
    setLoggingIn(false);
  };

  const doLogout = async () => {
    if (!confirm("Logout and end trading session?")) return;
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch {}
    setAuthStep("login");
    setIsRegister(false);
    setGreeting("");
    setTotp("");
    setChain([]);
    setPositions([]);
    setOrders([]);
    setSpotPrice(0);
    setSelectedStrike(null);
    setTraderId("");
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (spotTimerRef.current) clearInterval(spotTimerRef.current);
    addToast("Logged out", "info");
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
        builds[`${tt}_${ot}`] = JSON.stringify({
          am: "NO", dq: "0", es, mp: "0", pc: "MIS", pf: "N",
          pr: "0", pt: "MKT", qt: String(qty), rt: "DAY", tp: "0", ts, tt,
        });
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
      credentials: "include",
      body: JSON.stringify({ jData, action }),
    }).catch(() => addToast("Network error", "error"));
  }, [addToast]);

  useEffect(() => {
    if (authStep !== "terminal") return;
    const handler = (e: KeyboardEvent) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === "Numpad1" || (e.key === "1" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("B", "CE"); }
      else if (e.code === "Numpad3" || (e.key === "3" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("S", "CE"); }
      else if (e.code === "Numpad7" || (e.key === "7" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("B", "PE"); }
      else if (e.code === "Numpad9" || (e.key === "9" && !e.ctrlKey && !e.altKey && !e.metaKey)) { e.preventDefault(); fire("S", "PE"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [authStep, fire]);

  const pickStrike = (i: number) => {
    if (!chain[i]) return;
    setSelectedStrike(chain[i]);
    setSelectedIdx(i);
  };

  const closeAllPositions = async () => {
    if (!confirm("Close ALL open positions at market price?")) return;
    try {
      const r = await (await fetch("/api/order/close-all", { method: "POST", credentials: "include" })).json();
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
        credentials: "include",
        body: JSON.stringify({ on: n }),
      })).json();
      if (r.stat === "Ok") addToast("Order cancelled", "success");
      else addToast(r.emsg || "Cancel failed", "error");
      loadOrders();
    } catch { addToast("Network error", "error"); }
  };

  const fmtPrice = (p: number) => p.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtStrike = (s: number) => s.toLocaleString("en-IN");

  const getNetQty = (p: any) => {
    const buyQ = parseInt(p.flBuyQty ?? p.cfBuyQty ?? p.buyQty ?? 0);
    const sellQ = parseInt(p.flSellQty ?? p.cfSellQty ?? p.sellQty ?? 0);
    if (p.netQty !== undefined) return parseInt(p.netQty);
    return buyQ - sellQ;
  };
  const getPnl = (p: any) => {
    if (p._pnl !== undefined) return parseFloat(p._pnl);
    const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? 0);
    const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? 0);
    return sa - ba;
  };

  const openPositions = positions.filter(p => getNetQty(p) !== 0);
  const closedPositions = positions.filter(p => getNetQty(p) === 0);

  const openPnl = openPositions.reduce((sum, p) => sum + getPnl(p), 0);
  const closedPnl = closedPositions.reduce((sum, p) => sum + getPnl(p), 0);
  const totalPnl = openPnl + closedPnl;

  const switchIndex = (idx: string) => {
    setCurrentIndex(idx);
    setSelectedStrike(null);
    setSelectedIdx(-1);
    setChain([]);
  };

  if (authStep === "login") {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "var(--t-bg)" }} data-testid="login-overlay">
        <div className="w-full max-w-[400px] mx-4 p-6 md:p-9 rounded-2xl text-center animate-fade-in" style={{ background: "var(--t-sf)", border: "1px solid var(--t-bd)", boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}>
          <div className="text-5xl mb-2">&#x26A1;</div>
          <div className="mb-1">
            <span className="font-mono text-lg font-bold" style={{ color: "var(--t-bl)", letterSpacing: "-0.5px" }}>AKATSUKI</span>
          </div>
          <h1 className="text-lg font-bold mb-0.5" style={{ color: "var(--t-tx)" }}>{isRegister ? "Create Account" : "Welcome Back"}</h1>
          <p className="text-xs mb-6" style={{ color: "var(--t-tx3)" }}>{isRegister ? "Sign up to start trading" : "Sign in to your trading account"}</p>

          <input
            data-testid="input-email"
            type="email"
            value={authEmail}
            onChange={e => setAuthEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doAuthLogin()}
            placeholder="Email address"
            autoFocus
            className="w-full p-3 rounded-lg text-sm outline-none mb-2.5 transition-all"
            style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
          />
          <input
            data-testid="input-password"
            type="password"
            value={authPassword}
            onChange={e => setAuthPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doAuthLogin()}
            placeholder="Password"
            className="w-full p-3 rounded-lg text-sm outline-none mb-3.5 transition-all"
            style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
          />
          <button
            data-testid="button-login"
            onClick={doAuthLogin}
            disabled={authLoading}
            className="w-full p-3.5 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--t-bl) 0%, var(--t-bl2) 100%)" }}
          >
            {authLoading ? "..." : isRegister ? "Create Account" : "Sign In"}
          </button>
          <button
            data-testid="button-toggle-register"
            onClick={() => setIsRegister(!isRegister)}
            className="mt-3 text-xs font-medium transition-all"
            style={{ color: "var(--t-bl)" }}
          >
            {isRegister ? "Already have an account? Sign In" : "Don't have an account? Create one"}
          </button>
        </div>
        <ToastContainer toasts={toasts} />
      </div>
    );
  }

  if (authStep === "credentials") {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "var(--t-bg)" }} data-testid="credentials-overlay">
        <div className="w-full max-w-[440px] mx-4 p-6 md:p-9 rounded-2xl text-center animate-fade-in" style={{ background: "var(--t-sf)", border: "1px solid var(--t-bd)", boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}>
          <div className="text-5xl mb-4">&#x1F511;</div>
          <h1 className="text-xl font-bold mb-1" style={{ color: "var(--t-tx)" }}>Kotak Credentials</h1>
          <p className="text-xs mb-6" style={{ color: "var(--t-tx3)" }}>Enter your Kotak Securities API credentials. These are saved securely and only need to be entered once.</p>

          <CredInput data-testid="input-access-token" label="Access Token" value={credAccessToken} onChange={setCredAccessToken} />
          <CredInput data-testid="input-mobile" label="Mobile Number" value={credMobile} onChange={setCredMobile} />
          <CredInput data-testid="input-mpin" label="MPIN" value={credMpin} onChange={setCredMpin} type="password" />
          <CredInput data-testid="input-ucc" label="UCC (Client Code)" value={credUcc} onChange={setCredUcc} />

          <button
            data-testid="button-save-credentials"
            onClick={doSaveCredentials}
            disabled={credSaving}
            className="w-full p-3.5 mt-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--t-gn) 0%, var(--t-gn2) 100%)" }}
          >
            {credSaving ? "Saving..." : "Save & Continue"}
          </button>
        </div>
        <ToastContainer toasts={toasts} />
      </div>
    );
  }

  if (authStep === "totp") {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "var(--t-bg)" }} data-testid="totp-overlay">
        <div className="w-full max-w-[380px] mx-4 p-6 md:p-9 rounded-2xl text-center animate-fade-in" style={{ background: "var(--t-sf)", border: "1px solid var(--t-bd)", boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}>
          <div className="text-5xl mb-4">&#x1F510;</div>
          <h1 className="text-xl font-bold mb-1" style={{ color: "var(--t-tx)" }}>Enter TOTP</h1>
          <p className="text-xs mb-1" style={{ color: "var(--t-bl)" }}>{authEmail}</p>
          <p className="text-xs mb-6" style={{ color: "var(--t-tx3)" }}>Enter your 6-digit TOTP to connect to Kotak</p>
          <input
            data-testid="input-totp"
            type="text"
            value={totp}
            onChange={e => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={e => e.key === "Enter" && doTotpLogin()}
            placeholder="000000"
            maxLength={6}
            autoFocus
            className="w-full p-3.5 rounded-lg font-mono text-2xl text-center tracking-[12px] outline-none transition-all"
            style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
          />
          <button
            data-testid="button-connect"
            onClick={doTotpLogin}
            disabled={loggingIn}
            className="w-full p-3.5 mt-3.5 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--t-bl) 0%, var(--t-bl2) 100%)" }}
          >
            {loggingIn ? "Connecting..." : "Connect & Trade"}
          </button>
          <button
            data-testid="button-back-logout"
            onClick={() => {
              fetch("/api/auth/logout", { method: "POST", credentials: "include" });
              setAuthStep("login");
              setTotp("");
              setIsRegister(false);
            }}
            className="mt-3 text-xs font-medium transition-all"
            style={{ color: "var(--t-tx3)" }}
          >
            Sign out
          </button>
        </div>
        <ToastContainer toasts={toasts} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen pb-[180px] md:pb-0" style={{ background: "var(--t-bg)" }}>
      <header
        className="flex items-center justify-between px-3 md:px-5 h-11 md:h-12 sticky top-0 z-50 shrink-0"
        style={{ background: "linear-gradient(180deg, var(--t-sf) 0%, var(--t-bg2) 100%)", borderBottom: "1px solid var(--t-bd)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg md:text-xl">{"\u26A1"}</span>
          <span className="font-mono text-[13px] md:text-[15px] font-bold" style={{ color: "var(--t-bl)", letterSpacing: "-0.5px" }}>AKATSUKI</span>
        </div>
        <div className="flex items-center gap-2 md:gap-3.5">
          <span className="font-mono text-[10px] md:text-[11px] hidden sm:inline" style={{ color: "var(--t-tx3)" }} data-testid="text-clock">{clock}</span>
          <span className="text-[10px] md:text-[11px] font-medium hidden sm:inline" style={{ color: "var(--t-tx2)" }} data-testid="text-username">{greeting || authEmail}</span>
          <div
            className="flex items-center gap-1 px-2 py-0.5 md:px-2.5 md:py-1 rounded-full text-[10px] md:text-[11px] font-medium"
            style={wsConnected ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}
            data-testid="status-pill"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "animate-pulse-dot" : ""}`} style={{ background: wsConnected ? "var(--t-gn)" : "var(--t-rd)" }} />
            <span className="hidden sm:inline">{wsConnected ? "Live" : "Offline"}</span>
          </div>
          <button
            data-testid="button-logout"
            onClick={doLogout}
            className="flex items-center gap-1 px-2 py-1 md:px-3 md:py-1.5 rounded-md text-[10px] md:text-[11px] font-semibold transition-all"
            style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}
          >{"\u23FB"} <span className="hidden sm:inline">Logout</span></button>
        </div>
      </header>

      <div className="flex items-center gap-0.5 px-2 md:px-4 h-7 md:h-8 text-[10px] md:text-[11px] shrink-0 overflow-x-auto" style={{ background: "var(--t-bg2)", borderBottom: "1px solid var(--t-bd)" }}>
        <FundItem label="Avl" value={funds.available} />
        <div className="w-px h-4 mx-1.5 md:mx-3 shrink-0" style={{ background: "var(--t-bd)" }} />
        <FundItem label="Used" value={funds.used} />
        <div className="w-px h-4 mx-1.5 md:mx-3 shrink-0" style={{ background: "var(--t-bd)" }} />
        <FundItem label="Col" value={funds.collateral} />
      </div>

      <div className="flex items-center gap-1.5 md:gap-2 px-2 md:px-4 py-1.5 md:py-2 shrink-0 flex-wrap" style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}>
        <CtrlGroup label="Index">
          <select data-testid="select-index" value={currentIndex} onChange={e => switchIndex(e.target.value)} className="ctrl-select">
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANK NIFTY</option>
            <option value="SENSEX">SENSEX</option>
          </select>
        </CtrlGroup>
        <CtrlGroup label="Expiry">
          <select data-testid="select-expiry" value={selectedExpiry} onChange={e => setSelectedExpiry(e.target.value)} className="ctrl-select">
            {expiries.map(exp => <option key={exp.label} value={exp.label}>{exp.label}</option>)}
          </select>
        </CtrlGroup>
        <CtrlGroup label="Strikes">
          <select data-testid="select-strikes" value={numStrikes} onChange={e => setNumStrikes(parseInt(e.target.value))} className="ctrl-select">
            <option value="3">&plusmn;3</option>
            <option value="5">&plusmn;5</option>
            <option value="10">&plusmn;10</option>
            <option value="15">&plusmn;15</option>
          </select>
        </CtrlGroup>
        <button data-testid="button-toggle-chain" onClick={() => setShowChain(!showChain)} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all" style={showChain ? { background: "rgba(59,130,246,.12)", color: "var(--t-bl)", border: "1px solid rgba(59,130,246,.25)" } : { background: "var(--t-sf2)", color: "var(--t-tx2)", border: "1px solid var(--t-bd)" }}>{showChain ? "\u25BC Hide Chain" : "\u25B6 Option Chain"}</button>
        {showChain && <button data-testid="button-refresh-chain" onClick={loadChain} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all" style={{ background: "var(--t-sf2)", color: "var(--t-tx2)", border: "1px solid var(--t-bd)" }}>{"\u21BB"}</button>}
        <button data-testid="button-toggle-positions" onClick={() => setShowPositions(!showPositions)} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all" style={showPositions ? { background: "rgba(16,185,129,.12)", color: "var(--t-gn)", border: "1px solid rgba(16,185,129,.25)" } : { background: "var(--t-sf2)", color: "var(--t-tx2)", border: "1px solid var(--t-bd)" }}>{showPositions ? "\u25BC Positions" : "\u25B6 Positions"}{positions.length > 0 && <span className="text-[9px] px-1 py-px rounded-lg font-semibold ml-0.5" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }}>{positions.length}</span>}</button>
        <button data-testid="button-toggle-orders" onClick={() => setShowOrders(!showOrders)} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all" style={showOrders ? { background: "rgba(245,158,11,.12)", color: "var(--t-yw)", border: "1px solid rgba(245,158,11,.25)" } : { background: "var(--t-sf2)", color: "var(--t-tx2)", border: "1px solid var(--t-bd)" }}>{showOrders ? "\u25BC Orders" : "\u25B6 Orders"}{orders.length > 0 && <span className="text-[9px] px-1 py-px rounded-lg font-semibold ml-0.5" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }}>{orders.length}</span>}</button>
        <div className="flex-1" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Spot</span>
          <span className="font-mono text-[22px] font-bold" style={{ color: "var(--t-yw)", textShadow: "0 0 20px rgba(245,158,11,.15)" }} data-testid="text-spot-price">{spotPrice > 0 ? fmtPrice(spotPrice) : "--"}</span>
        </div>
      </div>

      <div className="hidden md:flex items-center px-5 gap-0 shrink-0" style={{ background: "linear-gradient(180deg, var(--t-sf) 0%, var(--t-bg2) 100%)", borderBottom: "2px solid var(--t-bd)", minHeight: "70px" }}>
        <div className="flex items-center gap-3 shrink-0 pr-6 mr-5" style={{ borderRight: "1px solid var(--t-bd)" }}>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded" style={{ background: "rgba(16,185,129,.08)", color: "var(--t-gn)", border: "1px solid rgba(16,185,129,.15)" }}>CALL</span>
            <div className="text-[9px] text-center whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>1</kbd> buy<br />
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>3</kbd> sell
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <ActionButton data-testid="button-buy-ce" variant="buy" disabled={!selectedStrike?.ce_ts} onClick={() => fire("B", "CE")}>{"\u25B2"} BUY CE</ActionButton>
            <ActionButton data-testid="button-sell-ce" variant="sell" disabled={!selectedStrike?.ce_ts} onClick={() => fire("S", "CE")}>{"\u25BC"} SELL CE</ActionButton>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-5">
          <div className="flex items-center gap-2.5 font-mono text-[13px] justify-center flex-wrap" data-testid="text-selected-strike">
            {selectedStrike ? (
              <>
                <span className="text-lg font-bold" style={{ color: "var(--t-yw)" }}>{fmtStrike(selectedStrike.strike)}</span>
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ color: "var(--t-tx3)", background: "var(--t-sf2)" }}>CE: {selectedStrike.ce_ts || "N/A"}</span>
                <span className="text-[10px] px-2 py-0.5 rounded" style={{ color: "var(--t-tx3)", background: "var(--t-sf2)" }}>PE: {selectedStrike.pe_ts || "N/A"}</span>
              </>
            ) : (
              <span className="text-xs italic" style={{ color: "var(--t-tx3)" }}>Select a strike from the option chain</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>LOTS</span>
            <button data-testid="button-lot-minus" onClick={() => setLots(Math.max(1, lots - 1))} className="w-6 h-6 flex items-center justify-center rounded font-bold text-[15px] select-none transition-all" style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}>{"\u2212"}</button>
            <input data-testid="input-lots" type="number" value={lots} onChange={e => setLots(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))} className="w-14 py-1 px-1.5 rounded text-center font-mono text-base font-bold outline-none" style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }} />
            <button data-testid="button-lot-plus" onClick={() => setLots(Math.min(50, lots + 1))} className="w-6 h-6 flex items-center justify-center rounded font-bold text-[15px] select-none transition-all" style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}>+</button>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 pl-6 ml-5" style={{ borderLeft: "1px solid var(--t-bd)" }}>
          <div className="flex flex-col gap-1.5">
            <ActionButton data-testid="button-buy-pe" variant="buy" disabled={!selectedStrike?.pe_ts} onClick={() => fire("B", "PE")}>{"\u25B2"} BUY PE</ActionButton>
            <ActionButton data-testid="button-sell-pe" variant="sell" disabled={!selectedStrike?.pe_ts} onClick={() => fire("S", "PE")}>{"\u25BC"} SELL PE</ActionButton>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded" style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}>PUT</span>
            <div className="text-[9px] text-center whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>7</kbd> buy<br />
              <kbd className="inline-block px-1 py-px rounded font-mono text-[9px]" style={{ background: "var(--t-sf3)", border: "1px solid var(--t-bd2)", color: "var(--t-tx2)" }}>9</kbd> sell
            </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom bar - pinned to bottom of screen */}
      <div className="fixed md:hidden bottom-0 left-0 right-0 z-40 flex flex-col" style={{ background: "var(--t-sf)", borderTop: "2px solid var(--t-bd)" }}>
        <div className="flex items-center justify-between px-3 py-1" style={{ borderBottom: "1px solid var(--t-bd)" }}>
          <div className="flex items-center gap-2">
            <div className="font-mono text-xs" data-testid="text-selected-strike-mobile">
              {selectedStrike ? (
                <span style={{ color: "var(--t-yw)" }}>{"\u25C9"} {fmtStrike(selectedStrike.strike)}</span>
              ) : (
                <span className="italic text-[10px]" style={{ color: "var(--t-tx3)" }}>No strike</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-mono font-bold" style={{ color: totalPnl > 0 ? "var(--t-gn)" : totalPnl < 0 ? "var(--t-rd)" : "var(--t-tx3)" }} data-testid="text-mobile-pnl">
                P&L {totalPnl >= 0 ? "+" : ""}{"\u20B9"}{totalPnl.toFixed(0)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-semibold uppercase" style={{ color: "var(--t-tx3)" }}>Lots</span>
            <button onClick={() => setLots(Math.max(1, lots - 1))} className="w-7 h-7 flex items-center justify-center rounded font-bold text-sm" style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}>{"\u2212"}</button>
            <input type="number" value={lots} onChange={e => setLots(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))} className="w-10 py-1 rounded text-center font-mono text-sm font-bold outline-none" style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }} />
            <button onClick={() => setLots(Math.min(50, lots + 1))} className="w-7 h-7 flex items-center justify-center rounded font-bold text-sm" style={{ background: "var(--t-sf2)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}>+</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 p-2.5" style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}>
          <button data-testid="button-buy-ce-mobile" disabled={!selectedStrike?.ce_ts} onClick={() => fire("B", "CE")} className="py-4 rounded-xl font-mono text-[15px] font-bold text-white tracking-wider disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.96] transition-transform" style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", boxShadow: selectedStrike?.ce_ts ? "0 3px 12px rgba(16,185,129,.35)" : "none" }}>BUY CE</button>
          <button data-testid="button-sell-ce-mobile" disabled={!selectedStrike?.ce_ts} onClick={() => fire("S", "CE")} className="py-4 rounded-xl font-mono text-[15px] font-bold text-white tracking-wider disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.96] transition-transform" style={{ background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)", boxShadow: selectedStrike?.ce_ts ? "0 3px 12px rgba(239,68,68,.35)" : "none" }}>SELL CE</button>
          <button data-testid="button-buy-pe-mobile" disabled={!selectedStrike?.pe_ts} onClick={() => fire("B", "PE")} className="py-4 rounded-xl font-mono text-[15px] font-bold text-white tracking-wider disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.96] transition-transform" style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", boxShadow: selectedStrike?.pe_ts ? "0 3px 12px rgba(16,185,129,.35)" : "none" }}>BUY PE</button>
          <button data-testid="button-sell-pe-mobile" disabled={!selectedStrike?.pe_ts} onClick={() => fire("S", "PE")} className="py-4 rounded-xl font-mono text-[15px] font-bold text-white tracking-wider disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.96] transition-transform" style={{ background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)", boxShadow: selectedStrike?.pe_ts ? "0 3px 12px rgba(239,68,68,.35)" : "none" }}>SELL PE</button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {showChain && (
          <div className="overflow-y-auto overflow-x-hidden shrink-0" style={{ maxHeight: "40vh", borderBottom: "1px solid var(--t-bd)" }}>
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
              <tbody>
                {chainLoading ? (
                  <tr><td colSpan={5} className="py-8 text-center"><div className="inline-block w-5 h-5 rounded-full animate-spin-slow" style={{ border: "2px solid var(--t-bd)", borderTopColor: "var(--t-bl)" }} /></td></tr>
                ) : chain.length === 0 ? (
                  <tr><td colSpan={5} className="py-10 text-center text-[11px]" style={{ color: "var(--t-tx3)" }}>{expiries.length === 0 ? "Loading instruments..." : "No data available"}</td></tr>
                ) : chain.map((row, i) => (
                  <tr
                    key={row.strike}
                    data-testid={`row-strike-${row.strike}`}
                    onClick={() => pickStrike(i)}
                    className="cursor-pointer transition-colors"
                    style={{
                      background: selectedIdx === i ? "rgba(245,158,11,.12)" : row.is_atm ? "rgba(59,130,246,.08)" : "transparent",
                      borderBottom: "1px solid rgba(36,48,73,.5)",
                      ...(selectedIdx === i ? { boxShadow: "inset 3px 0 0 var(--t-yw)" } : {}),
                      ...(row.is_atm ? { borderTop: "1px solid rgba(59,130,246,.2)", borderBottom: "1px solid rgba(59,130,246,.2)" } : {}),
                    }}
                  >
                    <td className="py-1.5 px-1.5 text-center font-mono text-[10px] max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>{row.ce_ts || "\u2014"}</td>
                    <td className="py-1.5 px-1.5 text-center text-[10px]" style={{ color: "var(--t-tx3)" }}>{row.ce_ts ? row.ce_lot : "\u2014"}</td>
                    <td className="py-1.5 px-1.5 text-center font-mono font-bold text-sm" style={{ color: "var(--t-yw)" }}>
                      {fmtStrike(row.strike)}
                      {row.is_atm && <span className="inline-block text-[8px] px-1.5 py-px ml-1 rounded font-bold align-middle tracking-wider" style={{ background: "rgba(59,130,246,.2)", color: "var(--t-bl)" }}>ATM</span>}
                    </td>
                    <td className="py-1.5 px-1.5 text-center text-[10px]" style={{ color: "var(--t-tx3)" }}>{row.pe_ts ? row.pe_lot : "\u2014"}</td>
                    <td className="py-1.5 px-1.5 text-center font-mono text-[10px] max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: "var(--t-tx3)" }}>{row.pe_ts || "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={`flex-1 min-h-0 ${showPositions || showOrders ? "" : "hidden"}`} style={{ borderTop: showChain ? "none" : "1px solid var(--t-bd)" }}>
          <div className={`h-full grid ${showPositions && showOrders ? "md:grid-cols-2 grid-cols-1" : "grid-cols-1"}`}>
          {showPositions && (
          <div className="flex flex-col overflow-hidden" style={{ borderRight: showOrders ? "1px solid var(--t-bd)" : "none" }}>
            <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--t-tx2)" }}>
                {"\uD83D\uDCCA"} Positions
                <span className="text-[9px] px-1.5 py-px rounded-lg font-semibold" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }} data-testid="text-pos-count">{positions.length}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button data-testid="button-close-all" onClick={closeAllPositions} className="px-2.5 py-0.5 rounded text-[10px] font-bold transition-all" style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }}>{"\u2715"} Close All</button>
                <button data-testid="button-refresh-positions" onClick={loadPositions} className="px-2 py-0.5 rounded text-[10px]" style={{ border: "1px solid var(--t-bd)", color: "var(--t-tx3)" }}>{"\u21BB"}</button>
              </div>
            </div>
            {positions.length > 0 && (
              <div className="flex items-center gap-4 px-3 py-1 shrink-0 text-[11px]" style={{ background: "var(--t-bg2)", borderBottom: "1px solid var(--t-bd)" }}>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Total</span>
                  <span className="font-mono font-bold text-[13px]" style={{ color: totalPnl > 0 ? "var(--t-gn)" : totalPnl < 0 ? "var(--t-rd)" : "var(--t-tx3)" }} data-testid="text-total-pnl">
                    {totalPnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(totalPnl).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Open</span>
                  <span className="font-mono font-semibold text-[11px]" style={{ color: openPnl > 0 ? "var(--t-gn)" : openPnl < 0 ? "var(--t-rd)" : "var(--t-tx3)" }}>
                    {openPnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(openPnl).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--t-tx3)" }}>Closed</span>
                  <span className="font-mono font-semibold text-[11px]" style={{ color: closedPnl > 0 ? "var(--t-gn)" : closedPnl < 0 ? "var(--t-rd)" : "var(--t-tx3)" }}>
                    {closedPnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(closedPnl).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto py-0.5">
              {positions.length === 0 ? (
                <div className="py-5 text-center text-[11px]" style={{ color: "var(--t-tx3)" }}>No positions today</div>
              ) : (
                <>
                  {openPositions.length > 0 && (
                    <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--t-gn)", background: "rgba(16,185,129,.04)", borderBottom: "1px solid rgba(16,185,129,.1)" }} data-testid="section-open-positions">
                      &#x25CF; Open Positions ({openPositions.length})
                    </div>
                  )}
                  {openPositions.map((p, i) => {
                    const nq = getNetQty(p);
                    const pnl = getPnl(p);
                    const buyQ = parseInt(p.flBuyQty ?? p.cfBuyQty ?? p.buyQty ?? 0);
                    const sellQ = parseInt(p.flSellQty ?? p.cfSellQty ?? p.sellQty ?? 0);
                    const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? 0);
                    const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? 0);
                    const avgPx = nq > 0 ? (buyQ > 0 ? (ba / buyQ).toFixed(2) : "--") : (sellQ > 0 ? (sa / sellQ).toFixed(2) : "--");
                    const sym = p.trdSym ?? p.sym ?? p.tsym ?? "--";
                    const isLong = nq > 0;
                    return (
                      <div key={`open-${i}`} data-testid={`row-open-position-${i}`} className="grid items-center gap-2 px-3 py-1.5 text-[11px]" style={{ gridTemplateColumns: "1fr auto auto auto", borderBottom: "1px solid rgba(36,48,73,.4)" }}>
                        <span className="font-mono font-semibold text-[10px] flex items-center gap-1.5">
                          {sym}
                          <span className="text-[8px] px-1.5 py-px rounded font-semibold" style={isLong ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}>{isLong ? "LONG" : "SHORT"}</span>
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: "var(--t-tx2)" }}>Qty: {Math.abs(nq)}</span>
                        <span className="font-mono text-[10px]" style={{ color: "var(--t-tx3)" }}>@{"\u20B9"}{avgPx}{p._ltp ? ` → ${p._ltp.toFixed(2)}` : ""}</span>
                        <span className="font-mono font-semibold text-[11px]" style={{ color: pnl >= 0 ? "var(--t-gn)" : "var(--t-rd)" }}>{pnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(pnl).toFixed(2)}</span>
                      </div>
                    );
                  })}
                  {closedPositions.length > 0 && (
                    <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--t-tx3)", background: "rgba(100,116,139,.04)", borderBottom: "1px solid rgba(100,116,139,.1)", borderTop: openPositions.length > 0 ? "1px solid var(--t-bd)" : "none" }} data-testid="section-closed-positions">
                      &#x25CB; Closed Positions ({closedPositions.length})
                    </div>
                  )}
                  {closedPositions.map((p, i) => {
                    const pnl = getPnl(p);
                    const buyQ = parseInt(p.flBuyQty ?? p.cfBuyQty ?? p.buyQty ?? 0);
                    const sellQ = parseInt(p.flSellQty ?? p.cfSellQty ?? p.sellQty ?? 0);
                    const ba = parseFloat(p.buyAmt ?? p.cfBuyAmt ?? 0);
                    const sa = parseFloat(p.sellAmt ?? p.cfSellAmt ?? 0);
                    const avgBuy = buyQ > 0 ? (ba / buyQ).toFixed(2) : "--";
                    const avgSell = sellQ > 0 ? (sa / sellQ).toFixed(2) : "--";
                    const sym = p.trdSym ?? p.sym ?? p.tsym ?? "--";
                    const totalQty = Math.max(buyQ, sellQ);
                    return (
                      <div key={`closed-${i}`} data-testid={`row-closed-position-${i}`} className="grid items-center gap-2 px-3 py-1.5 text-[11px]" style={{ gridTemplateColumns: "1fr auto auto auto", borderBottom: "1px solid rgba(36,48,73,.4)", opacity: 0.7 }}>
                        <span className="font-mono font-semibold text-[10px] flex items-center gap-1.5">
                          {sym}
                          <span className="text-[8px] px-1.5 py-px rounded font-semibold" style={{ background: "rgba(100,116,139,.08)", color: "var(--t-tx3)" }}>CLOSED</span>
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: "var(--t-tx2)" }}>Qty: {totalQty}</span>
                        <span className="font-mono text-[10px]" style={{ color: "var(--t-tx3)" }}>{"\u20B9"}{avgBuy}/{avgSell}</span>
                        <span className="font-mono font-semibold text-[11px]" style={{ color: pnl >= 0 ? "var(--t-gn)" : "var(--t-rd)" }}>{pnl >= 0 ? "+" : "-"}{"\u20B9"}{Math.abs(pnl).toFixed(2)}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
          )}

          {showOrders && (
          <div className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ background: "var(--t-sf)", borderBottom: "1px solid var(--t-bd)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--t-tx2)" }}>
                {"\uD83D\uDCCB"} Orders <span className="text-[9px] px-1.5 py-px rounded-lg font-semibold" style={{ background: "rgba(59,130,246,.1)", color: "var(--t-bl)" }} data-testid="text-ord-count">{orders.length}</span>
              </div>
              <button data-testid="button-refresh-orders" onClick={loadOrders} className="px-2 py-0.5 rounded text-[10px]" style={{ border: "1px solid var(--t-bd)", color: "var(--t-tx3)" }}>{"\u21BB"}</button>
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
                  <div key={i} data-testid={`row-order-${i}`} className="grid items-center gap-2 px-3 py-1.5 text-[11px]" style={{ gridTemplateColumns: "18px 1fr auto auto auto auto", borderBottom: "1px solid rgba(36,48,73,.4)" }}>
                    <div className="w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold shrink-0" style={isBuy ? { background: "rgba(16,185,129,.08)", color: "var(--t-gn)" } : { background: "rgba(239,68,68,.08)", color: "var(--t-rd)" }}>{isBuy ? "B" : "S"}</div>
                    <span className="font-mono font-medium text-[10px] overflow-hidden text-ellipsis whitespace-nowrap">{o.trdSym}</span>
                    <span className="font-mono font-semibold text-[10px]" style={{ color: "var(--t-yw)" }}>{dispPx}</span>
                    <span className="font-mono text-[10px]" style={{ color: "var(--t-tx2)" }}>{o.qty}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider whitespace-nowrap" style={{ background: sc.bg, color: sc.color }}>{o.ordSt}</span>
                    {stCls === "open" ? (
                      <button onClick={(e) => { e.stopPropagation(); cancelOrd(o.nOrdNo); }} className="px-2 py-0.5 rounded text-[9px] font-semibold" style={{ background: "rgba(239,68,68,.08)", color: "var(--t-rd)", border: "1px solid rgba(239,68,68,.15)" }} data-testid={`button-cancel-order-${i}`}>{"\u2715"}</button>
                    ) : timeStr ? <span className="font-mono text-[9px]" style={{ color: "var(--t-tx3)" }}>{timeStr}</span> : <span />}
                  </div>
                );
              })}
            </div>
          </div>
          )}
          </div>
        </div>
      </div>

      <footer className="hidden md:flex items-center justify-center flex-wrap gap-x-4 gap-y-0.5 px-4 py-1.5 shrink-0" style={{ background: "var(--t-bg2)", borderTop: "1px solid var(--t-bd)" }}>
        <span className="text-[10px] font-medium" style={{ color: "var(--t-tx3)" }}>Copyright &copy; Akatsuki</span>
        <span className="w-px h-3" style={{ background: "var(--t-bd)" }} />
        <span className="text-[10px]" style={{ color: "var(--t-tx3)" }}>Crafted by <span className="font-semibold" style={{ color: "var(--t-tx2)" }}>Dr. Arvind Dahiya</span> &amp; <span className="font-semibold" style={{ color: "var(--t-tx2)" }}>HC</span></span>
      </footer>

      <ToastContainer toasts={toasts} />
    </div>
  );
}

function CredInput({ label, value, onChange, type = "text", ...props }: { label: string; value: string; onChange: (v: string) => void; type?: string; [key: string]: any }) {
  return (
    <div className="mb-2.5 text-left">
      <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--t-tx3)" }}>{label}</label>
      <input
        {...props}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full p-2.5 rounded-lg text-sm outline-none transition-all font-mono"
        style={{ background: "var(--t-bg)", border: "1px solid var(--t-bd)", color: "var(--t-tx)" }}
      />
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

function ActionButton({ variant, disabled, onClick, children, ...props }: { variant: "buy" | "sell"; disabled?: boolean; onClick: () => void; children: React.ReactNode; [key: string]: any }) {
  const bg = variant === "buy" ? "linear-gradient(135deg, #10b981 0%, #059669 100%)" : "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)";
  return (
    <button
      {...props}
      onClick={onClick}
      disabled={disabled}
      className="py-2 px-5 rounded-md font-mono text-[11px] font-bold text-white tracking-wider flex items-center justify-center gap-1.5 transition-all whitespace-nowrap min-w-[112px] disabled:opacity-25 disabled:cursor-not-allowed"
      style={{ background: bg, boxShadow: disabled ? "none" : "0 1px 3px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.2)" }}
    >{children}</button>
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
          <div key={t.id} className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium max-w-[360px] animate-toast-in backdrop-blur-sm" style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}`, boxShadow: "0 4px 12px rgba(0,0,0,.4)" }} data-testid={`toast-${t.type}`}>
            <span className="text-sm shrink-0">{icons[t.type]}</span>
            <span className="flex-1">{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
