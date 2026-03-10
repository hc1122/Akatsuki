import { Agent } from "undici";
import { log } from "./index";

const keepAliveDispatcher = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connections: 10,
  pipelining: 1,
});

function fa(url: string, opts: any = {}): Promise<Response> {
  return fetch(url, { ...opts, dispatcher: keepAliveDispatcher } as any);
}

export interface KotakSession {
  accessToken: string;
  mobileNumber: string;
  mpin: string;
  ucc: string;
  sessionToken: string | null;
  sessionSid: string | null;
  baseUrl: string | null;
  viewToken: string | null;
  viewSid: string | null;
  loggedIn: boolean;
  greetingName: string;
  loginTime: string | null;
  userId: string;
}

const userSessions = new Map<string, KotakSession>();

export function createSession(userId: string, creds: { accessToken: string; mobileNumber: string; mpin: string; ucc: string }): KotakSession {
  const session: KotakSession = {
    accessToken: creds.accessToken,
    mobileNumber: creds.mobileNumber,
    mpin: creds.mpin,
    ucc: creds.ucc,
    sessionToken: null,
    sessionSid: null,
    baseUrl: null,
    viewToken: null,
    viewSid: null,
    loggedIn: false,
    greetingName: "",
    loginTime: null,
    userId,
  };
  userSessions.set(userId, session);
  return session;
}

export function getSession(userId: string): KotakSession | undefined {
  return userSessions.get(userId);
}

export function removeSession(userId: string) {
  userSessions.delete(userId);
}

function quoteHeaders(s: KotakSession) {
  return {
    "Authorization": s.accessToken,
    "Content-Type": "application/json",
  };
}

function postHeaders(s: KotakSession): Record<string, string> {
  return {
    "accept": "application/json",
    "Auth": s.sessionToken!,
    "Sid": s.sessionSid!,
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function loginWithTotp(s: KotakSession, totp: string) {
  try {
    const res = await fa("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin", {
      method: "POST",
      headers: {
        "Authorization": s.accessToken,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mobileNumber: s.mobileNumber,
        ucc: s.ucc,
        totp,
      }),
    });
    const data = await res.json() as any;
    if (data?.data?.status === "success") {
      s.viewToken = data.data.token;
      s.viewSid = data.data.sid;
      return { status: "success" };
    }
    return { status: "error", message: data?.message || JSON.stringify(data) };
  } catch (e: any) {
    log(`Login TOTP error: ${e.message}`, "kotak");
    return { status: "error", message: e.message };
  }
}

export async function validateMpin(s: KotakSession) {
  try {
    const res = await fa("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate", {
      method: "POST",
      headers: {
        "Authorization": s.accessToken,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/json",
        "sid": s.viewSid!,
        "Auth": s.viewToken!,
      },
      body: JSON.stringify({ mpin: s.mpin }),
    });
    const data = await res.json() as any;
    if (data?.data?.status === "success") {
      const dd = data.data;
      s.sessionToken = dd.token;
      s.sessionSid = dd.sid;
      s.baseUrl = dd.baseUrl || "";
      s.loggedIn = true;
      s.greetingName = dd.greetingName || "";
      s.loginTime = new Date().toISOString();
      return { status: "success", greeting: s.greetingName };
    }
    return { status: "error", message: data?.message || JSON.stringify(data) };
  } catch (e: any) {
    log(`Validate MPIN error: ${e.message}`, "kotak");
    return { status: "error", message: e.message };
  }
}

export async function fetchQuote(s: KotakSession, seg: string, sym: string, filter = "ltp") {
  try {
    const url = `${s.baseUrl}/script-details/1.0/quotes/neosymbol/${seg}|${sym}/${filter}`;
    const res = await fa(url, { headers: quoteHeaders(s) });
    const data = await res.json() as any;
    return Array.isArray(data) && data.length > 0 ? data[0] : data;
  } catch (e: any) {
    log(`Quote error: ${e.message}`, "kotak");
    return {};
  }
}

export async function getSpot(s: KotakSession, idx: string): Promise<number> {
  const map: Record<string, [string, string]> = {
    "NIFTY": ["nse_cm", "Nifty 50"],
    "BANKNIFTY": ["nse_cm", "Nifty Bank"],
    "SENSEX": ["bse_cm", "SENSEX"],
    "FINNIFTY": ["nse_cm", "Nifty Fin Service"],
  };
  const [seg, sym] = map[idx.toUpperCase()] || ["nse_cm", "Nifty 50"];
  const q = await fetchQuote(s, seg, sym, "ltp");
  return parseFloat(q?.ltp || "0");
}

export async function placeOrder(
  s: KotakSession,
  es: string, ts: string, tt: string, qty: number,
  pc = "MIS", pt = "MKT", pr = "0", tp = "0"
) {
  if (!s.loggedIn) return { stat: "Not_Ok", emsg: "Not logged in" };
  const jData = JSON.stringify({
    am: "NO", dq: "0", es, mp: "0", pc, pf: "N",
    pr, pt, qt: String(qty), rt: "DAY", tp, ts, tt,
  });
  log(`ORDER [${s.userId}]: ${jData}`, "kotak");
  try {
    const res = await fa(`${s.baseUrl}/quick/order/rule/ms/place`, {
      method: "POST",
      headers: postHeaders(s),
      body: `jData=${jData}`,
    });
    const result = await res.json() as any;
    log(`RESULT [${s.userId}]: ${JSON.stringify(result)}`, "kotak");
    return result;
  } catch (e: any) {
    log(`Order error: ${e.message}`, "kotak");
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function cancelOrder(s: KotakSession, on: string) {
  try {
    const res = await fa(`${s.baseUrl}/quick/order/cancel`, {
      method: "POST",
      headers: postHeaders(s),
      body: `jData=${JSON.stringify({ on, am: "NO" })}`,
    });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getOrderbook(s: KotakSession) {
  try {
    const h = { ...postHeaders(s) };
    delete h["Content-Type"];
    const res = await fa(`${s.baseUrl}/quick/user/orders`, { headers: h });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getPositions(s: KotakSession) {
  try {
    const h = { ...postHeaders(s) };
    delete h["Content-Type"];
    const res = await fa(`${s.baseUrl}/quick/user/positions`, { headers: h });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getLimits(s: KotakSession) {
  try {
    const res = await fa(`${s.baseUrl}/quick/user/limits`, {
      method: "POST",
      headers: postHeaders(s),
      body: `jData=${JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" })}`,
    });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function fetchScripPaths(s: KotakSession): Promise<string[]> {
  try {
    const url = `${s.baseUrl}/script-details/1.0/masterscrip/file-paths`;
    const res = await fa(url, { headers: quoteHeaders(s) });
    const data = await res.json() as any;
    return data?.data?.filesPaths || [];
  } catch (e: any) {
    log(`Scrip paths error: ${e.message}`, "kotak");
    return [];
  }
}

export function logoutSession(s: KotakSession) {
  s.sessionToken = null;
  s.sessionSid = null;
  s.baseUrl = null;
  s.viewToken = null;
  s.viewSid = null;
  s.loggedIn = false;
  s.greetingName = "";
  s.loginTime = null;
}

export function getAnyLoggedInSession(): KotakSession | undefined {
  for (const s of userSessions.values()) {
    if (s.loggedIn) return s;
  }
  return undefined;
}
