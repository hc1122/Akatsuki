import os
import json
import re
import time
import requests
import pandas as pd
from datetime import datetime, date
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from contextlib import asynccontextmanager
import asyncio
import httpx
import logging

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scalper")

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

MONTHS = {"JAN":1,"FEB":2,"MAR":3,"APR":4,"MAY":5,"JUN":6,
          "JUL":7,"AUG":8,"SEP":9,"OCT":10,"NOV":11,"DEC":12}

session_state = {
    "access_token": os.getenv("ACCESS_TOKEN", ""),
    "session_token": None, "session_sid": None, "base_url": None,
    "view_token": None, "view_sid": None,
    "logged_in": False, "greeting_name": "", "login_time": None,
}

# ─── IN-MEMORY OPTIONS DATABASE ───────────────────────────────────────
# Structure:
# options_db["NIFTY"]["05-MAR-2026"][24850.0]["CE"] = {ts, symbol, seg, lot}
# expiry_list["NIFTY"] = [{"date": date(...), "label": "05-MAR-2026"}, ...]
# spot_cache["NIFTY"] = {"price": 24865.7, "updated": timestamp}
options_db: dict = {}
expiry_list: dict = {}
spot_cache: dict = {}

# Async HTTP client (replaces blocking requests for post-login calls)
http_client: httpx.AsyncClient | None = None

ws_clients: list[WebSocket] = []

async def broadcast(msg: dict):
    dead = []
    for ws in ws_clients:
        try: await ws.send_json(msg)
        except: dead.append(ws)
    for ws in dead: ws_clients.remove(ws)


# ─── Parse expiry from pTrdSymbol ──────────────────────────────────────
def parse_expiry_from_symbol(ts: str, prefix: str) -> date | None:
    rest = ts[len(prefix):]

    # Monthly: DDMON... (26MAR..., 28DEC...)
    m = re.match(r"(\d{2})([A-Z]{3})", rest)
    if m:
        day, mon_str = int(m.group(1)), m.group(2)
        month = MONTHS.get(mon_str, 0)
        if month and 1 <= day <= 31:
            for yr in [datetime.now().year, datetime.now().year + 1, datetime.now().year - 1]:
                try:
                    d = date(yr, month, day)
                    if d.year >= 2025: return d
                except ValueError: continue
            return None

    # Weekly: YY + M(1-2 digit) + DD(2 digit)
    if len(rest) >= 5:
        yr = int(rest[0:2]); year = 2000 + yr
        if year < 2025 or year > 2030: return None
        remaining = rest[2:]

        # Try 2-digit month (10,11,12)
        if len(remaining) >= 4:
            m2, d2 = int(remaining[0:2]), int(remaining[2:4])
            if 10 <= m2 <= 12 and 1 <= d2 <= 31:
                try: return date(year, m2, d2)
                except ValueError: pass

        # Try 1-digit month (1-9)
        if len(remaining) >= 3:
            m1, d1 = int(remaining[0:1]), int(remaining[1:3])
            if 1 <= m1 <= 9 and 1 <= d1 <= 31:
                try: return date(year, m1, d1)
                except ValueError: pass
    return None


# ─── BUILD IN-MEMORY DB (called once after CSV download) ──────────────
def build_options_db(index_name: str):
    """Parse CSV once, build in-memory dict for instant lookups."""
    key = index_name.upper()
    csv_key = "nse_fo" if key in ("NIFTY","BANKNIFTY","FINNIFTY") else "bse_fo"
    csv_path = cache_files.get(csv_key, "")
    if not csv_path or not os.path.exists(csv_path):
        logger.error(f"No CSV for {key}"); return

    t0 = time.time()

    needed = ["pSymbol","pExchSeg","pTrdSymbol","pOptionType","lLotSize",
              "pSymbolName","pInstType","dStrikePrice"]
    try:
        sample = pd.read_csv(csv_path, nrows=1)
        needed = [c for c in needed if c in sample.columns]; del sample
        df = pd.read_csv(csv_path, usecols=needed, low_memory=False)
    except Exception as e:
        logger.error(f"CSV error: {e}"); return

    # Filter index options
    if key in ("NIFTY","BANKNIFTY","FINNIFTY"):
        mask = ((df["pSymbolName"].astype(str).str.upper()==key) &
                (df["pInstType"].astype(str).str.upper()=="OPTIDX") &
                (df["pOptionType"].isin(["CE","PE"])))
    else:
        mask = ((df["pSymbolName"].astype(str).str.upper()==key) &
                (df["pOptionType"].isin(["CE","PE"])))

    df = df[mask].copy()
    if df.empty:
        logger.error(f"No options for {key}"); del df; return

    df["strike_num"] = pd.to_numeric(df["dStrikePrice"], errors="coerce") / 100.0
    df = df.dropna(subset=["strike_num"])

    prefix = key
    today_d = date.today()

    # Build: db[expiry_label][strike][CE/PE] = {ts, symbol, seg, lot}
    db = {}
    expiries_set = set()

    for _, row in df.iterrows():
        ts = str(row.get("pTrdSymbol", "")).upper()
        d = parse_expiry_from_symbol(ts, prefix)
        if not d or d.year > 2030:
            continue

        label = d.strftime("%d-%b-%Y").upper()
        strike = float(row["strike_num"])
        opt = str(row.get("pOptionType", ""))

        if label not in db:
            db[label] = {}
        if strike not in db[label]:
            db[label][strike] = {}

        try: lot = int(row.get("lLotSize", 1))
        except: lot = 1

        db[label][strike][opt] = {
            "ts": ts,
            "symbol": str(row.get("pSymbol", "")),
            "seg": str(row.get("pExchSeg", "")),
            "lot": lot,
        }

        if d >= today_d:
            expiries_set.add((d, label))

    options_db[key] = db

    # Build sorted expiry list (future only)
    sorted_exp = sorted(expiries_set, key=lambda x: x[0])
    expiry_list[key] = [{"date": d, "label": lbl} for d, lbl in sorted_exp]

    elapsed = time.time() - t0
    total_strikes = sum(len(strikes) for strikes in db.values())

    # Log expiry details
    for e in expiry_list[key][:8]:
        strike_count = len(db.get(e["label"], {}))
        logger.info(f"  {e['label']}: {strike_count} strikes")

    logger.info(f"✅ {key} DB built: {len(expiry_list[key])} expiries, {total_strikes} strike-entries, {elapsed:.2f}s")
    del df


def query_chain_fast(index_name: str, spot: float, num_strikes: int = 5, expiry_label: str = "") -> dict:
    """Query option chain from in-memory dict. ~0.01ms."""
    key = index_name.upper()
    db = options_db.get(key)
    if not db:
        return {"error": f"No data for {key}. Loading..."}

    today_d = date.today()
    exp_list = expiry_list.get(key, [])

    # Determine target expiry
    target_label = ""
    if expiry_label:
        target_label = expiry_label
    else:
        for e in exp_list:
            if e["date"] >= today_d:
                target_label = e["label"]; break

    if not target_label and exp_list:
        target_label = exp_list[0]["label"]

    if not target_label:
        return {"error": f"No expiries for {key}"}

    strikes_data = db.get(target_label)
    if not strikes_data:
        return {"error": f"No data for {key} {target_label}"}

    all_strikes = sorted(strikes_data.keys())
    if not all_strikes:
        return {"error": "No strikes"}

    step_map = {"NIFTY":50,"BANKNIFTY":100,"SENSEX":100,"FINNIFTY":50}
    step = step_map.get(key, 50)

    # ATM
    atm = min(all_strikes, key=lambda x: abs(x - spot))
    atm_idx = all_strikes.index(atm)
    start = max(0, atm_idx - num_strikes)
    end = min(len(all_strikes), atm_idx + num_strikes + 1)
    selected = all_strikes[start:end]

    # Build chain
    chain = []
    lot = 1
    for strike in selected:
        row = {"strike": float(strike), "is_atm": bool(abs(strike - atm) < step / 2)}
        sdata = strikes_data.get(strike, {})
        for ot in ["CE", "PE"]:
            info = sdata.get(ot, {})
            if info:
                row[f"{ot.lower()}_ts"] = info["ts"]
                row[f"{ot.lower()}_symbol"] = info["symbol"]
                row[f"{ot.lower()}_seg"] = info["seg"]
                row[f"{ot.lower()}_lot"] = info["lot"]
                if lot == 1: lot = info["lot"]
            else:
                row[f"{ot.lower()}_ts"] = ""
                row[f"{ot.lower()}_symbol"] = ""
                row[f"{ot.lower()}_seg"] = ""
                row[f"{ot.lower()}_lot"] = 1
        chain.append(row)

    return {
        "atm_strike": float(atm), "spot_price": float(spot), "chain": chain,
        "index": str(key), "expiry": str(target_label),
        "total_strikes": int(len(all_strikes)), "step": int(step), "lot_size": int(lot),
    }


# ─── CSV Download ─────────────────────────────────────────────────────
cache_files: dict = {}

def fetch_scrip_paths():
    url = f"{session_state['base_url']}/script-details/1.0/masterscrip/file-paths"
    headers = {"Authorization": session_state["access_token"], "Content-Type": "application/json"}
    return requests.get(url, headers=headers, timeout=15).json().get("data",{}).get("filesPaths",[])

def download_csv(index_name):
    csv_key = "nse_fo" if index_name.upper() in ("NIFTY","BANKNIFTY","FINNIFTY") else "bse_fo"
    today_str = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(DATA_DIR, f"{csv_key}_{today_str}.csv")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        cache_files[csv_key] = path; return path
    paths = fetch_scrip_paths()
    target = [p for p in paths if csv_key in p]
    if not target: return ""
    logger.info(f"Downloading {csv_key}...")
    r = requests.get(target[0], timeout=120)
    lines = r.text.split("\n", 1)
    if len(lines) >= 2:
        hdr = ",".join(c.strip().rstrip(";").strip() for c in lines[0].split(","))
        content = hdr + "\n" + lines[1]
    else: content = r.text
    with open(path, "w") as f: f.write(content)
    logger.info(f"✅ Saved {csv_key}: {os.path.getsize(path)/(1024*1024):.1f}MB")
    cache_files[csv_key] = path
    for fn in os.listdir(DATA_DIR):
        if fn.startswith(csv_key) and today_str not in fn: os.remove(os.path.join(DATA_DIR, fn))
    return path


# ─── ASYNC Kotak API helpers ──────────────────────────────────────────
def _quote_headers():
    return {"Authorization": session_state["access_token"], "Content-Type": "application/json"}

def _post_headers():
    return {"accept":"application/json","Auth":session_state["session_token"],
            "Sid":session_state["session_sid"],"neo-fin-key":"neotradeapi",
            "Content-Type":"application/x-www-form-urlencoded"}


async def async_fetch_quote(seg: str, sym: str, filt: str = "ltp") -> dict:
    url = f"{session_state['base_url']}/script-details/1.0/quotes/neosymbol/{seg}|{sym}/{filt}"
    r = await http_client.get(url, headers=_quote_headers(), timeout=10)
    d = r.json()
    return d[0] if isinstance(d, list) and d else d


async def async_get_spot(idx: str) -> float:
    m = {"NIFTY":("nse_cm","Nifty 50"),"BANKNIFTY":("nse_cm","Nifty Bank"),
         "SENSEX":("bse_cm","SENSEX"),"FINNIFTY":("nse_cm","Nifty Fin Service")}
    seg, sym = m.get(idx.upper(), ("nse_cm","Nifty 50"))
    q = await async_fetch_quote(seg, sym, "ltp")
    return float(q.get("ltp", 0))


async def async_place_order(es, ts, tt, qty, pc="MIS", pt="MKT", pr="0", tp="0"):
    if not session_state["logged_in"]: return {"stat":"Not_Ok","emsg":"Not logged in"}
    jdata = json.dumps({"am":"NO","dq":"0","es":es,"mp":"0","pc":pc,"pf":"N",
                        "pr":pr,"pt":pt,"qt":str(qty),"rt":"DAY","tp":tp,"ts":ts,"tt":tt})
    logger.info(f"ORDER: {jdata}")
    r = await http_client.post(f"{session_state['base_url']}/quick/order/rule/ms/place",
                               headers=_post_headers(), content=f"jData={jdata}", timeout=10)
    result = r.json()
    logger.info(f"RESULT: {result}")
    return result


async def async_cancel_order(on):
    r = await http_client.post(f"{session_state['base_url']}/quick/order/cancel",
        headers=_post_headers(), content=f"jData={json.dumps({'on':on,'am':'NO'})}", timeout=10)
    return r.json()


async def async_get_orderbook():
    h = _post_headers(); h.pop("Content-Type", None)
    r = await http_client.get(f"{session_state['base_url']}/quick/user/orders", headers=h, timeout=10)
    return r.json()


async def async_get_positions():
    h = _post_headers(); h.pop("Content-Type", None)
    r = await http_client.get(f"{session_state['base_url']}/quick/user/positions", headers=h, timeout=10)
    return r.json()


async def async_get_limits():
    r = await http_client.post(f"{session_state['base_url']}/quick/user/limits",
        headers=_post_headers(),
        content=f"jData={json.dumps({'seg':'ALL','exch':'ALL','prod':'ALL'})}", timeout=10)
    return r.json()


# ─── BACKGROUND SPOT PRICE CACHING ────────────────────────────────────
async def spot_cache_loop():
    """Background task: refresh spot prices every 2 seconds."""
    while True:
        if not session_state["logged_in"]:
            await asyncio.sleep(2); continue

        indices = ["NIFTY", "BANKNIFTY", "SENSEX"]
        for idx in indices:
            try:
                price = await async_get_spot(idx)
                if price > 0:
                    spot_cache[idx] = {"price": price, "updated": time.time()}
            except Exception:
                pass

        await asyncio.sleep(2)


def get_cached_spot(idx: str) -> float:
    """Get spot from cache. Returns 0 if stale (>10s)."""
    key = idx.upper()
    cached = spot_cache.get(key)
    if cached and (time.time() - cached["updated"]) < 10:
        return cached["price"]
    return 0


# ─── LOGIN (still sync — only called once) ────────────────────────────
def kotak_login_totp(totp):
    r = requests.post("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin", headers={
        "Authorization": session_state["access_token"],
        "neo-fin-key": "neotradeapi", "Content-Type": "application/json",
    }, json={"mobileNumber": os.getenv("MOBILE_NUMBER"), "ucc": os.getenv("UCC"), "totp": totp}, timeout=15)
    d = r.json()
    if d.get("data",{}).get("status") == "success":
        session_state["view_token"] = d["data"]["token"]
        session_state["view_sid"] = d["data"]["sid"]
        return {"status": "success"}
    return {"status": "error", "message": d.get("message", str(d))}

def kotak_validate_mpin():
    r = requests.post("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate", headers={
        "Authorization": session_state["access_token"], "neo-fin-key": "neotradeapi",
        "Content-Type": "application/json",
        "sid": session_state["view_sid"], "Auth": session_state["view_token"],
    }, json={"mpin": os.getenv("MPIN")}, timeout=15)
    d = r.json()
    if d.get("data",{}).get("status") == "success":
        dd = d["data"]
        session_state.update({"session_token": dd["token"], "session_sid": dd["sid"],
            "base_url": dd.get("baseUrl",""), "logged_in": True,
            "greeting_name": dd.get("greetingName",""), "login_time": datetime.now().isoformat()})
        return {"status": "success", "greeting": session_state["greeting_name"]}
    return {"status": "error", "message": d.get("message", str(d))}


# ─── FastAPI App ──────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(http2=False, limits=httpx.Limits(max_connections=20))
    logger.info("🚀 Scalper starting...")
    # Start background spot cache
    task = asyncio.create_task(spot_cache_loop())
    yield
    task.cancel()
    await http_client.aclose()

app = FastAPI(title="Scalper", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root(): return FileResponse("static/index.html")


@app.post("/api/login")
async def login(p: dict):
    totp = p.get("totp","")
    if not totp: raise HTTPException(400)
    r = kotak_login_totp(totp)
    if r["status"] != "success": return r
    mr = kotak_validate_mpin()
    if mr["status"] == "success":
        asyncio.create_task(preload())
    return mr


async def preload():
    """Download CSVs and build in-memory DB (runs once after login)."""
    await asyncio.sleep(0.5)
    for idx in ["NIFTY", "BANKNIFTY", "SENSEX"]:
        try:
            download_csv(idx)
            build_options_db(idx)
            await broadcast({"type": "instruments_ready", "index": idx})
        except Exception as e:
            logger.error(f"{idx}: {e}", exc_info=True)
        await asyncio.sleep(0.2)
    logger.info("🏁 All instruments loaded into memory")


@app.get("/api/session")
async def sess():
    return {"logged_in": session_state["logged_in"], "greeting": session_state["greeting_name"]}


@app.get("/api/spot/{idx}")
async def api_spot(idx: str):
    if not session_state["logged_in"]: raise HTTPException(401)
    # Return cached spot (0ms) or fetch fresh if cache miss
    price = get_cached_spot(idx)
    if price <= 0:
        price = await async_get_spot(idx)
        if price > 0:
            spot_cache[idx.upper()] = {"price": price, "updated": time.time()}
    return {"index": idx.upper(), "spot": price}


@app.get("/api/expiries/{idx}")
async def api_expiries(idx: str):
    if not session_state["logged_in"]: raise HTTPException(401)
    key = idx.upper()
    lst = expiry_list.get(key, [])
    today_d = date.today()
    nearest = ""
    for e in lst:
        if e["date"] >= today_d: nearest = e["label"]; break
    return JSONResponse({"expiries": [{"label": e["label"], "is_nearest": e["label"]==nearest} for e in lst], "index": key})


@app.get("/api/option-chain/{idx}")
async def api_chain(idx: str, strikes: int = 5, expiry: str = ""):
    if not session_state["logged_in"]: raise HTTPException(401)

    # Get spot from cache (instant)
    price = get_cached_spot(idx)
    if price <= 0:
        price = await async_get_spot(idx)

    if price <= 0:
        return JSONResponse({"error": "No spot price"})

    # Query from in-memory dict (instant)
    t0 = time.time()
    result = query_chain_fast(idx, price, strikes, expiry)
    elapsed_ms = (time.time() - t0) * 1000
    logger.info(f"Chain query: {elapsed_ms:.2f}ms")

    return JSONResponse(result)


@app.post("/api/order/quick")
async def api_quick(p: dict):
    if not session_state["logged_in"]: raise HTTPException(401)
    ts, es, tt = p.get("ts",""), p.get("es",""), p.get("tt","")
    qty = int(p.get("lot", 1))
    psym = p.get("symbol", "")
    if not all([ts, es, tt]): return {"stat": "Not_Ok", "emsg": "Missing params"}

    # Place market order (async, non-blocking)
    r = await async_place_order(es, ts, tt, qty)

    # Fallback to limit if MKT rejected
    if r.get("stat") == "Not_Ok" and "LTP" in (r.get("errMsg","") + r.get("emsg","")):
        logger.info(f"MKT rejected, trying limit for {ts}...")
        if psym and es:
            q = await async_fetch_quote(es, psym, "ltp")
            ltp = float(q.get("ltp", 0))
            if ltp > 0:
                pr = round(ltp * (1.002 if tt == "B" else 0.998), 2)
                logger.info(f"Limit at {pr} (LTP={ltp})")
                r = await async_place_order(es, ts, tt, qty, pt="L", pr=str(pr))

    await broadcast({"type": "order_update", "data": r, "action": f"{'BUY' if tt=='B' else 'SELL'} {ts} x{qty}"})
    return r


@app.post("/api/order/cancel")
async def api_cancel(p: dict):
    if not session_state["logged_in"]: raise HTTPException(401)
    r = await async_cancel_order(p["on"])
    await broadcast({"type": "order_cancelled", "data": r})
    return r


@app.get("/api/orderbook")
async def api_ob():
    if not session_state["logged_in"]: raise HTTPException(401)
    return await async_get_orderbook()


@app.get("/api/positions")
async def api_pos():
    if not session_state["logged_in"]: raise HTTPException(401)
    return await async_get_positions()


@app.get("/api/limits")
async def api_lim():
    if not session_state["logged_in"]: raise HTTPException(401)
    return await async_get_limits()


@app.post("/api/logout")
async def api_logout():
    session_state.update({
        "session_token": None, "session_sid": None, "base_url": None,
        "view_token": None, "view_sid": None,
        "logged_in": False, "greeting_name": "", "login_time": None,
    })
    options_db.clear(); expiry_list.clear(); spot_cache.clear()
    return {"status": "success"}


@app.post("/api/order/close-all")
async def api_close_all():
    if not session_state["logged_in"]: raise HTTPException(401)
    try:
        pos_resp = await async_get_positions()
        if pos_resp.get("stat") != "Ok" or not pos_resp.get("data"):
            return {"status": "error", "message": "No positions to close"}
        results = []
        for pos in pos_resp["data"]:
            net_qty = int(pos.get("netQty", pos.get("qty", 0)))
            if net_qty == 0:
                continue
            ts = pos.get("trdSym", "")
            es = pos.get("seg", pos.get("exSeg", "nse_fo"))
            tt = "S" if net_qty > 0 else "B"
            qty = abs(net_qty)
            if not ts or not es:
                continue
            r = await async_place_order(es, ts, tt, qty)
            results.append({"symbol": ts, "qty": qty, "side": tt, "result": r})
        await broadcast({"type": "close_all", "count": len(results)})
        return {"status": "ok", "closed": len(results), "results": results}
    except Exception as e:
        logger.error(f"close-all error: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}


@app.post("/api/reload/{idx}")
async def api_reload(idx: str):
    if not session_state["logged_in"]: raise HTTPException(401)
    key = idx.upper()
    try:
        download_csv(key)
        build_options_db(key)
        await broadcast({"type": "instruments_ready", "index": key})
        return {"status": "ok", "index": key}
    except Exception as e:
        logger.error(f"Reload error for {key}: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in ws_clients:
            ws_clients.remove(websocket)
