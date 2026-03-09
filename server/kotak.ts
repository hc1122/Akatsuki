import { log } from "./index";

export const sessionState = {
  accessToken: process.env.ACCESS_TOKEN || "",
  sessionToken: null as string | null,
  sessionSid: null as string | null,
  baseUrl: null as string | null,
  viewToken: null as string | null,
  viewSid: null as string | null,
  loggedIn: false,
  greetingName: "",
  loginTime: null as string | null,
};

function quoteHeaders() {
  return {
    "Authorization": sessionState.accessToken,
    "Content-Type": "application/json",
  };
}

function postHeaders(): Record<string, string> {
  return {
    "accept": "application/json",
    "Auth": sessionState.sessionToken!,
    "Sid": sessionState.sessionSid!,
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function loginWithTotp(totp: string) {
  try {
    const res = await fetch("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin", {
      method: "POST",
      headers: {
        "Authorization": sessionState.accessToken,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mobileNumber: process.env.MOBILE_NUMBER,
        ucc: process.env.UCC,
        totp,
      }),
    });
    const data = await res.json() as any;
    if (data?.data?.status === "success") {
      sessionState.viewToken = data.data.token;
      sessionState.viewSid = data.data.sid;
      return { status: "success" };
    }
    return { status: "error", message: data?.message || JSON.stringify(data) };
  } catch (e: any) {
    log(`Login TOTP error: ${e.message}`, "kotak");
    return { status: "error", message: e.message };
  }
}

export async function validateMpin() {
  try {
    const res = await fetch("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate", {
      method: "POST",
      headers: {
        "Authorization": sessionState.accessToken,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/json",
        "sid": sessionState.viewSid!,
        "Auth": sessionState.viewToken!,
      },
      body: JSON.stringify({ mpin: process.env.MPIN }),
    });
    const data = await res.json() as any;
    if (data?.data?.status === "success") {
      const dd = data.data;
      sessionState.sessionToken = dd.token;
      sessionState.sessionSid = dd.sid;
      sessionState.baseUrl = dd.baseUrl || "";
      sessionState.loggedIn = true;
      sessionState.greetingName = dd.greetingName || "";
      sessionState.loginTime = new Date().toISOString();
      return { status: "success", greeting: sessionState.greetingName };
    }
    return { status: "error", message: data?.message || JSON.stringify(data) };
  } catch (e: any) {
    log(`Validate MPIN error: ${e.message}`, "kotak");
    return { status: "error", message: e.message };
  }
}

export async function fetchQuote(seg: string, sym: string, filter = "ltp") {
  try {
    const url = `${sessionState.baseUrl}/script-details/1.0/quotes/neosymbol/${seg}|${sym}/${filter}`;
    const res = await fetch(url, { headers: quoteHeaders() });
    const data = await res.json() as any;
    return Array.isArray(data) && data.length > 0 ? data[0] : data;
  } catch (e: any) {
    log(`Quote error: ${e.message}`, "kotak");
    return {};
  }
}

export async function getSpot(idx: string): Promise<number> {
  const map: Record<string, [string, string]> = {
    "NIFTY": ["nse_cm", "Nifty 50"],
    "BANKNIFTY": ["nse_cm", "Nifty Bank"],
    "SENSEX": ["bse_cm", "SENSEX"],
    "FINNIFTY": ["nse_cm", "Nifty Fin Service"],
  };
  const [seg, sym] = map[idx.toUpperCase()] || ["nse_cm", "Nifty 50"];
  const q = await fetchQuote(seg, sym, "ltp");
  return parseFloat(q?.ltp || "0");
}

export async function placeOrder(
  es: string, ts: string, tt: string, qty: number,
  pc = "MIS", pt = "MKT", pr = "0", tp = "0"
) {
  if (!sessionState.loggedIn) return { stat: "Not_Ok", emsg: "Not logged in" };
  const jData = JSON.stringify({
    am: "NO", dq: "0", es, mp: "0", pc, pf: "N",
    pr, pt, qt: String(qty), rt: "DAY", tp, ts, tt,
  });
  log(`ORDER: ${jData}`, "kotak");
  try {
    const res = await fetch(`${sessionState.baseUrl}/quick/order/rule/ms/place`, {
      method: "POST",
      headers: postHeaders(),
      body: `jData=${jData}`,
    });
    const result = await res.json() as any;
    log(`RESULT: ${JSON.stringify(result)}`, "kotak");
    return result;
  } catch (e: any) {
    log(`Order error: ${e.message}`, "kotak");
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function cancelOrder(on: string) {
  try {
    const res = await fetch(`${sessionState.baseUrl}/quick/order/cancel`, {
      method: "POST",
      headers: postHeaders(),
      body: `jData=${JSON.stringify({ on, am: "NO" })}`,
    });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getOrderbook() {
  try {
    const h = { ...postHeaders() };
    delete h["Content-Type"];
    const res = await fetch(`${sessionState.baseUrl}/quick/user/orders`, { headers: h });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getPositions() {
  try {
    const h = { ...postHeaders() };
    delete h["Content-Type"];
    const res = await fetch(`${sessionState.baseUrl}/quick/user/positions`, { headers: h });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function getLimits() {
  try {
    const res = await fetch(`${sessionState.baseUrl}/quick/user/limits`, {
      method: "POST",
      headers: postHeaders(),
      body: `jData=${JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" })}`,
    });
    return await res.json();
  } catch (e: any) {
    return { stat: "Not_Ok", emsg: e.message };
  }
}

export async function fetchScripPaths(): Promise<string[]> {
  try {
    const url = `${sessionState.baseUrl}/script-details/1.0/masterscrip/file-paths`;
    const res = await fetch(url, { headers: quoteHeaders() });
    const data = await res.json() as any;
    return data?.data?.filesPaths || [];
  } catch (e: any) {
    log(`Scrip paths error: ${e.message}`, "kotak");
    return [];
  }
}

export function logout() {
  sessionState.sessionToken = null;
  sessionState.sessionSid = null;
  sessionState.baseUrl = null;
  sessionState.viewToken = null;
  sessionState.viewSid = null;
  sessionState.loggedIn = false;
  sessionState.greetingName = "";
  sessionState.loginTime = null;
}
