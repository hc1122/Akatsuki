import os, json, re, asyncio, time, logging, uuid, hashlib, secrets
from datetime import datetime, date
from pathlib import Path
from contextlib import asynccontextmanager
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

import httpx
import pandas as pd
import bcrypt
import asyncpg
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request, Response, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("akatsuki")

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "kotak-scalper-secret-2025")
ENCRYPT_KEY = (SESSION_SECRET).ljust(32, "0")[:32].encode("utf-8")

# ─── AES-256-CBC encryption (same as Node.js version) ───

def encrypt_aes(text: str) -> str:
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(ENCRYPT_KEY), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    pad_len = 16 - (len(text.encode()) % 16)
    padded = text.encode() + bytes([pad_len] * pad_len)
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return iv.hex() + ":" + encrypted.hex()

def decrypt_aes(data: str) -> str:
    iv_hex, encrypted_hex = data.split(":")
    iv = bytes.fromhex(iv_hex)
    encrypted = bytes.fromhex(encrypted_hex)
    cipher = Cipher(algorithms.AES(ENCRYPT_KEY), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(encrypted) + decryptor.finalize()
    pad_len = decrypted[-1]
    return decrypted[:-pad_len].decode("utf-8")

# ─── Database ───

db_pool: Optional[asyncpg.Pool] = None

async def init_db():
    global db_pool
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    await db_pool.execute("""
        CREATE TABLE IF NOT EXISTS traders (
            id VARCHAR(36) PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            access_token TEXT,
            mobile_number TEXT,
            mpin TEXT,
            ucc TEXT,
            has_credentials BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)

async def create_trader(email: str, password: str) -> dict:
    tid = str(uuid.uuid4())
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()
    await db_pool.execute(
        "INSERT INTO traders (id, email, password_hash) VALUES ($1, $2, $3)",
        tid, email.lower().strip(), pw_hash
    )
    return {"id": tid, "email": email.lower().strip(), "has_credentials": False}

async def get_trader_by_email(email: str) -> Optional[dict]:
    row = await db_pool.fetchrow("SELECT * FROM traders WHERE email = $1", email.lower().strip())
    return dict(row) if row else None

async def get_trader_by_id(tid: str) -> Optional[dict]:
    row = await db_pool.fetchrow("SELECT * FROM traders WHERE id = $1", tid)
    return dict(row) if row else None

async def save_kotak_credentials(tid: str, creds: dict):
    await db_pool.execute(
        """UPDATE traders SET access_token=$1, mobile_number=$2, mpin=$3, ucc=$4, has_credentials=TRUE WHERE id=$5""",
        encrypt_aes(creds["accessToken"]),
        encrypt_aes(creds["mobileNumber"]),
        encrypt_aes(creds["mpin"]),
        encrypt_aes(creds["ucc"]),
        tid
    )

def decrypt_credentials(trader: dict) -> Optional[dict]:
    if not trader.get("access_token") or not trader.get("mobile_number"):
        return None
    try:
        return {
            "accessToken": decrypt_aes(trader["access_token"]),
            "mobileNumber": decrypt_aes(trader["mobile_number"]),
            "mpin": decrypt_aes(trader["mpin"]),
            "ucc": decrypt_aes(trader["ucc"]),
        }
    except Exception:
        return None

# ─── Sessions (in-memory, cookie-based) ───

sessions: dict[str, dict] = {}

def create_session() -> str:
    sid = secrets.token_hex(32)
    sessions[sid] = {}
    return sid

def get_session_data(request: Request) -> dict:
    sid = request.cookies.get("session_id", "")
    return sessions.get(sid, {})

def set_session_cookie(response: Response, sid: str):
    response.set_cookie("session_id", sid, httponly=True, samesite="lax", max_age=86400)

# ─── Kotak Sessions (per user, in-memory) ───

class KotakSession:
    def __init__(self, user_id: str, creds: dict):
        self.user_id = user_id
        self.access_token = creds["accessToken"]
        self.mobile_number = creds["mobileNumber"]
        self.mpin = creds["mpin"]
        self.ucc = creds["ucc"]
        self.session_token: Optional[str] = None
        self.session_sid: Optional[str] = None
        self.base_url: Optional[str] = None
        self.view_token: Optional[str] = None
        self.view_sid: Optional[str] = None
        self.logged_in = False
        self.greeting_name = ""
        self.login_time: Optional[str] = None

    def quote_headers(self):
        return {"Authorization": self.access_token, "Content-Type": "application/json"}

    def post_headers(self):
        return {
            "accept": "application/json",
            "Auth": self.session_token,
            "Sid": self.session_sid,
            "neo-fin-key": "neotradeapi",
            "Content-Type": "application/x-www-form-urlencoded",
        }

    def logout(self):
        self.session_token = None
        self.session_sid = None
        self.base_url = None
        self.view_token = None
        self.view_sid = None
        self.logged_in = False
        self.greeting_name = ""
        self.login_time = None

kotak_sessions: dict[str, KotakSession] = {}

# ─── Options DB (in-memory) ───

options_db: dict = {}
expiry_list: dict = {}
spot_cache: dict = {}
csv_cache_files: dict = {}

MONTHS = {"JAN":1,"FEB":2,"MAR":3,"APR":4,"MAY":5,"JUN":6,"JUL":7,"AUG":8,"SEP":9,"OCT":10,"NOV":11,"DEC":12}

def parse_expiry_from_symbol(ts: str, prefix: str):
    rest = ts[len(prefix):]
    monthly = re.match(r'^(\d{2})([A-Z]{3})', rest)
    if monthly:
        day = int(monthly.group(1))
        month = MONTHS.get(monthly.group(2), 0)
        if month and 1 <= day <= 31:
            now = datetime.now()
            for yr in [now.year, now.year + 1, now.year - 1]:
                try:
                    d = date(yr, month, day)
                    if d.year >= 2025:
                        return d
                except ValueError:
                    continue
    if len(rest) >= 5:
        try:
            yr_val = int(rest[:2])
            year = 2000 + yr_val
            if year < 2025 or year > 2030:
                return None
            remaining = rest[2:]
            if len(remaining) >= 4:
                m2 = int(remaining[:2])
                d2 = int(remaining[2:4])
                if 10 <= m2 <= 12 and 1 <= d2 <= 31:
                    try:
                        return date(year, m2, d2)
                    except ValueError:
                        pass
            if len(remaining) >= 3:
                m1 = int(remaining[0])
                d1 = int(remaining[1:3])
                if 1 <= m1 <= 9 and 1 <= d1 <= 31:
                    try:
                        return date(year, m1, d1)
                    except ValueError:
                        pass
        except (ValueError, IndexError):
            pass
    return None

def format_expiry_label(d: date) -> str:
    ms = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
    return f"{d.day:02d}-{ms[d.month-1]}-{d.year}"

def build_options_db(index_name: str):
    key = index_name.upper()
    csv_key = "nse_fo" if key in ["NIFTY","BANKNIFTY","FINNIFTY"] else "bse_fo"
    csv_path = csv_cache_files.get(csv_key)
    if not csv_path or not Path(csv_path).exists():
        log.warning(f"No CSV for {key}")
        return
    t0 = time.time()
    alt_needed = ["pSymbol","pExchSeg","pTrdSymbol","pOptionType","lLotSize","pSymbolName","pInstType","dStrikePrice"]
    try:
        df = pd.read_csv(csv_path, usecols=lambda c: c.strip().replace(";","") in alt_needed, dtype=str, na_filter=False, engine="c")
    except Exception as e:
        log.error(f"CSV parse error for {key}: {e}")
        return
    df.columns = [c.strip().replace(";","") for c in df.columns]
    for col in alt_needed:
        if col not in df.columns:
            df[col] = ""
    df["pSymbolName"] = df["pSymbolName"].str.upper().str.strip()
    df["pOptionType"] = df["pOptionType"].str.strip()
    df["pTrdSymbol"] = df["pTrdSymbol"].str.upper().str.strip()
    mask = (df["pSymbolName"] == key) & (df["pOptionType"].isin(["CE","PE"]))
    if key in ["NIFTY","BANKNIFTY","FINNIFTY"]:
        mask = mask & (df["pInstType"].str.upper().str.strip() == "OPTIDX")
    filtered = df[mask]
    if filtered.empty:
        log.warning(f"No options found for {key}")
        return
    today_d = date.today()
    db: dict = {}
    expiries_set: dict = {}
    for _, row in filtered.iterrows():
        try:
            strike_num = float(row.get("dStrikePrice","0")) / 100.0
        except (ValueError, TypeError):
            continue
        if strike_num <= 0:
            continue
        ts = row["pTrdSymbol"]
        d = parse_expiry_from_symbol(ts, key)
        if not d or d.year > 2030:
            continue
        label = format_expiry_label(d)
        opt = row["pOptionType"]
        lot = int(row.get("lLotSize","1") or "1")
        if label not in db:
            db[label] = {}
        if strike_num not in db[label]:
            db[label][strike_num] = {}
        db[label][strike_num][opt] = {"ts": ts, "symbol": row.get("pSymbol",""), "seg": row.get("pExchSeg",""), "lot": lot}
        if d >= today_d:
            expiries_set[label] = d
    options_db[key] = db
    sorted_exp = sorted(expiries_set.items(), key=lambda x: x[1])
    expiry_list[key] = [{"date": d, "label": lbl} for lbl, d in sorted_exp]
    elapsed = (time.time() - t0) * 1000
    total_s = sum(len(exp) for exp in db.values())
    log.info(f"{key} DB built: {len(sorted_exp)} expiries, {total_s} strike-entries, {elapsed:.0f}ms")

def query_chain_fast(index_name: str, spot: float, num_strikes: int = 5, expiry_label: str = ""):
    key = index_name.upper()
    db = options_db.get(key)
    if not db:
        return {"error": f"No data for {key}. Loading..."}
    today_d = date.today()
    exp_list = expiry_list.get(key, [])
    target_label = ""
    if expiry_label:
        target_label = expiry_label
    else:
        for e in exp_list:
            if e["date"] >= today_d:
                target_label = e["label"]
                break
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
    step_map = {"NIFTY": 50, "BANKNIFTY": 100, "SENSEX": 100, "FINNIFTY": 50}
    step = step_map.get(key, 50)
    atm = min(all_strikes, key=lambda s: abs(s - spot))
    atm_idx = all_strikes.index(atm)
    start = max(0, atm_idx - num_strikes)
    end = min(len(all_strikes), atm_idx + num_strikes + 1)
    selected = all_strikes[start:end]
    lot_size = 1
    chain = []
    for strike in selected:
        row = {"strike": strike, "is_atm": abs(strike - atm) < step / 2}
        sdata = strikes_data.get(strike, {})
        for ot in ["CE", "PE"]:
            p = ot.lower()
            info = sdata.get(ot)
            if info:
                row[f"{p}_ts"] = info["ts"]
                row[f"{p}_symbol"] = info["symbol"]
                row[f"{p}_seg"] = info["seg"]
                row[f"{p}_lot"] = info["lot"]
                if lot_size == 1:
                    lot_size = info["lot"]
            else:
                row[f"{p}_ts"] = ""
                row[f"{p}_symbol"] = ""
                row[f"{p}_seg"] = ""
                row[f"{p}_lot"] = 1
        chain.append(row)
    return {"atm_strike": atm, "spot_price": spot, "chain": chain, "index": key, "expiry": target_label, "total_strikes": len(all_strikes), "step": step, "lot_size": lot_size}

def get_expiries(index_name: str):
    key = index_name.upper()
    lst = expiry_list.get(key, [])
    today_d = date.today()
    nearest = ""
    for e in lst:
        if e["date"] >= today_d:
            nearest = e["label"]
            break
    return {"expiries": [{"label": e["label"], "is_nearest": e["label"] == nearest} for e in lst], "index": key}

def get_cached_spot(idx: str) -> float:
    cached = spot_cache.get(idx.upper())
    if cached and (time.time() - cached["updated"]) < 10:
        return cached["price"]
    return 0

def set_cached_spot(idx: str, price: float):
    spot_cache[idx.upper()] = {"price": price, "updated": time.time()}

# ─── Kotak API calls ───

http_client: Optional[httpx.AsyncClient] = None

async def kotak_login_totp(ks: KotakSession, totp: str) -> dict:
    try:
        r = await http_client.post("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin",
            headers={"Authorization": ks.access_token, "neo-fin-key": "neotradeapi", "Content-Type": "application/json"},
            json={"mobileNumber": ks.mobile_number, "ucc": ks.ucc, "totp": totp})
        data = r.json()
        if data.get("data", {}).get("status") == "success":
            ks.view_token = data["data"]["token"]
            ks.view_sid = data["data"]["sid"]
            return {"status": "success"}
        return {"status": "error", "message": data.get("message", str(data))}
    except Exception as e:
        return {"status": "error", "message": str(e)}

async def kotak_validate_mpin(ks: KotakSession) -> dict:
    try:
        r = await http_client.post("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate",
            headers={"Authorization": ks.access_token, "neo-fin-key": "neotradeapi", "Content-Type": "application/json",
                      "sid": ks.view_sid, "Auth": ks.view_token},
            json={"mpin": ks.mpin})
        data = r.json()
        if data.get("data", {}).get("status") == "success":
            dd = data["data"]
            ks.session_token = dd["token"]
            ks.session_sid = dd["sid"]
            ks.base_url = dd.get("baseUrl", "")
            ks.logged_in = True
            ks.greeting_name = dd.get("greetingName", "")
            ks.login_time = datetime.now().isoformat()
            return {"status": "success", "greeting": ks.greeting_name}
        return {"status": "error", "message": data.get("message", str(data))}
    except Exception as e:
        return {"status": "error", "message": str(e)}

async def fetch_quote(ks: KotakSession, seg: str, sym: str, filt: str = "ltp") -> dict:
    try:
        url = f"{ks.base_url}/script-details/1.0/quotes/neosymbol/{seg}|{sym}/{filt}"
        r = await http_client.get(url, headers=ks.quote_headers())
        data = r.json()
        return data[0] if isinstance(data, list) and data else data
    except Exception as e:
        log.error(f"Quote error {seg}|{sym}: {e}")
        return {}

async def kotak_get_spot(ks: KotakSession, idx: str) -> float:
    m = {"NIFTY": ("nse_cm","Nifty 50"), "BANKNIFTY": ("nse_cm","Nifty Bank"), "SENSEX": ("bse_cm","SENSEX"), "FINNIFTY": ("nse_cm","Nifty Fin Service")}
    seg, sym = m.get(idx.upper(), ("nse_cm","Nifty 50"))
    q = await fetch_quote(ks, seg, sym, "ltp")
    return float(q.get("ltp","0") or "0")

async def kotak_place_order(ks: KotakSession, es: str, ts: str, tt: str, qty: int, pc="MIS", pt="MKT", pr="0", tp="0") -> dict:
    if not ks.logged_in:
        return {"stat": "Not_Ok", "emsg": "Not logged in"}
    j = json.dumps({"am":"NO","dq":"0","es":es,"mp":"0","pc":pc,"pf":"N","pr":pr,"pt":pt,"qt":str(qty),"rt":"DAY","tp":tp,"ts":ts,"tt":tt})
    log.info(f"ORDER [{ks.user_id}]: {j}")
    try:
        r = await http_client.post(f"{ks.base_url}/quick/order/rule/ms/place", headers=ks.post_headers(), content=f"jData={j}")
        result = r.json()
        log.info(f"RESULT [{ks.user_id}]: {json.dumps(result)[:500]}")
        return result
    except Exception as e:
        return {"stat": "Not_Ok", "emsg": str(e)}

async def kotak_fast_order(ks: KotakSession, j_data: str) -> dict:
    r = await http_client.post(f"{ks.base_url}/quick/order/rule/ms/place", headers=ks.post_headers(), content=f"jData={j_data}")
    return r.json()

async def kotak_cancel_order(ks: KotakSession, on: str) -> dict:
    try:
        r = await http_client.post(f"{ks.base_url}/quick/order/cancel", headers=ks.post_headers(), content=f'jData={json.dumps({"on":on,"am":"NO"})}')
        return r.json()
    except Exception as e:
        return {"stat": "Not_Ok", "emsg": str(e)}

async def kotak_get_orderbook(ks: KotakSession) -> dict:
    try:
        h = {k: v for k, v in ks.post_headers().items() if k != "Content-Type"}
        r = await http_client.get(f"{ks.base_url}/quick/user/orders", headers=h)
        return r.json()
    except Exception as e:
        return {"stat": "Not_Ok", "emsg": str(e)}

async def kotak_get_positions(ks: KotakSession) -> dict:
    try:
        h = {k: v for k, v in ks.post_headers().items() if k != "Content-Type"}
        r = await http_client.get(f"{ks.base_url}/quick/user/positions", headers=h)
        return r.json()
    except Exception as e:
        return {"stat": "Not_Ok", "emsg": str(e)}

async def kotak_get_limits(ks: KotakSession) -> dict:
    try:
        r = await http_client.post(f"{ks.base_url}/quick/user/limits", headers=ks.post_headers(), content=f'jData={json.dumps({"seg":"ALL","exch":"ALL","prod":"ALL"})}')
        return r.json()
    except Exception as e:
        return {"stat": "Not_Ok", "emsg": str(e)}

async def fetch_scrip_paths(ks: KotakSession) -> list:
    try:
        r = await http_client.get(f"{ks.base_url}/script-details/1.0/masterscrip/file-paths", headers=ks.quote_headers())
        return r.json().get("data", {}).get("filesPaths", [])
    except Exception as e:
        log.error(f"Scrip paths error: {e}")
        return []

async def download_csv(index_name: str, ks: KotakSession):
    key = index_name.upper()
    csv_key = "nse_fo" if key in ["NIFTY","BANKNIFTY","FINNIFTY"] else "bse_fo"
    today_str = date.today().isoformat()
    file_path = DATA_DIR / f"{csv_key}_{today_str}.csv"
    if file_path.exists() and file_path.stat().st_size > 1000:
        csv_cache_files[csv_key] = str(file_path)
        return
    paths = await fetch_scrip_paths(ks)
    target = [p for p in paths if csv_key in p]
    if not target:
        return
    log.info(f"Downloading {csv_key}...")
    r = await http_client.get(target[0], headers=ks.quote_headers())
    text = r.text
    first_nl = text.find("\n")
    if first_nl > 0:
        header = text[:first_nl]
        rest = text[first_nl+1:]
        clean = ",".join(c.strip().replace(";","") for c in header.split(","))
        text = clean + "\n" + rest
    file_path.write_text(text)
    log.info(f"Saved {csv_key}: {file_path.stat().st_size/(1024*1024):.1f}MB")
    csv_cache_files[csv_key] = str(file_path)
    for fn in DATA_DIR.iterdir():
        if fn.name.startswith(csv_key) and today_str not in fn.name:
            fn.unlink()

# ─── WebSocket per-user ───

ws_clients: dict[str, list[WebSocket]] = {}

async def broadcast_to_user(user_id: str, msg: dict):
    data = json.dumps(msg)
    dead = []
    for ws in ws_clients.get(user_id, []):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients = ws_clients.get(user_id, [])
        if ws in clients:
            clients.remove(ws)

# ─── Spot cache poller per user ───

spot_tasks: dict[str, asyncio.Task] = {}

async def spot_poller(user_id: str):
    while True:
        ks = kotak_sessions.get(user_id)
        if not ks or not ks.logged_in:
            break
        for idx in ["NIFTY", "BANKNIFTY", "SENSEX"]:
            try:
                price = await kotak_get_spot(ks, idx)
                if price > 0:
                    set_cached_spot(idx, price)
            except Exception:
                pass
        await asyncio.sleep(2)

def start_spot_cache(user_id: str):
    if user_id in spot_tasks:
        spot_tasks[user_id].cancel()
    spot_tasks[user_id] = asyncio.create_task(spot_poller(user_id))

async def preload_instruments(user_id: str):
    ks = kotak_sessions.get(user_id)
    if not ks or not ks.logged_in:
        return
    await asyncio.sleep(0.5)
    for idx in ["NIFTY", "BANKNIFTY", "SENSEX"]:
        try:
            await download_csv(idx, ks)
            build_options_db(idx)
            await broadcast_to_user(user_id, {"type": "instruments_ready", "index": idx})
        except Exception as e:
            log.error(f"{idx} preload error: {e}")
        await asyncio.sleep(0.2)
    log.info("All instruments loaded into memory")

# ─── FastAPI app ───

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0), limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
    await init_db()
    yield
    for t in spot_tasks.values():
        t.cancel()
    await http_client.aclose()
    await db_pool.close()

app = FastAPI(title="AKATSUKI", lifespan=lifespan)

# ─── Helpers ───

def require_auth(request: Request) -> str:
    sd = get_session_data(request)
    tid = sd.get("traderId")
    if not tid:
        raise HTTPException(401, "Not authenticated")
    return tid

def require_kotak(request: Request) -> KotakSession:
    tid = require_auth(request)
    ks = kotak_sessions.get(tid)
    if not ks or not ks.logged_in:
        raise HTTPException(401, "Kotak not connected")
    return ks

def get_any_logged_in_session() -> Optional[KotakSession]:
    for ks in kotak_sessions.values():
        if ks.logged_in:
            return ks
    return None

# ─── Auth routes ───

class AuthRequest(BaseModel):
    email: str
    password: str

class CredentialsRequest(BaseModel):
    accessToken: str
    mobileNumber: str
    mpin: str
    ucc: str

class TotpRequest(BaseModel):
    totp: str

class FastOrderRequest(BaseModel):
    jData: str
    action: str = ""

class CancelRequest(BaseModel):
    on: str

class LtpRequest(BaseModel):
    tokens: list[dict]

@app.post("/api/auth/register")
async def auth_register(req: AuthRequest, response: Response):
    if not req.email or not req.password:
        raise HTTPException(400, "Email and password required")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    existing = await get_trader_by_email(req.email)
    if existing:
        raise HTTPException(400, "Email already registered")
    trader = await create_trader(req.email, req.password)
    sid = create_session()
    sessions[sid]["traderId"] = trader["id"]
    set_session_cookie(response, sid)
    return {"status": "success", "hasCredentials": False, "traderId": trader["id"]}

@app.post("/api/auth/login")
async def auth_login(req: AuthRequest, response: Response):
    if not req.email or not req.password:
        raise HTTPException(400, "Email and password required")
    trader = await get_trader_by_email(req.email)
    if not trader:
        raise HTTPException(401, "Invalid email or password")
    if not bcrypt.checkpw(req.password.encode(), trader["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    sid = create_session()
    sessions[sid]["traderId"] = trader["id"]
    set_session_cookie(response, sid)
    return {"status": "success", "hasCredentials": bool(trader.get("has_credentials")), "email": trader["email"], "traderId": trader["id"]}

@app.post("/api/auth/credentials")
async def auth_credentials(req: CredentialsRequest, request: Request):
    tid = require_auth(request)
    if not req.accessToken or not req.mobileNumber or not req.mpin or not req.ucc:
        raise HTTPException(400, "All credential fields required")
    await save_kotak_credentials(tid, {"accessToken": req.accessToken, "mobileNumber": req.mobileNumber, "mpin": req.mpin, "ucc": req.ucc})
    return {"status": "success"}

@app.get("/api/auth/session")
async def auth_session(request: Request):
    sd = get_session_data(request)
    tid = sd.get("traderId")
    if not tid:
        return {"authenticated": False}
    trader = await get_trader_by_id(tid)
    if not trader:
        return {"authenticated": False}
    ks = kotak_sessions.get(tid)
    return {
        "authenticated": True,
        "email": trader["email"],
        "hasCredentials": bool(trader.get("has_credentials")),
        "kotakConnected": ks.logged_in if ks else False,
        "greeting": ks.greeting_name if ks else "",
        "traderId": trader["id"],
    }

@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    sd = get_session_data(request)
    tid = sd.get("traderId")
    if tid:
        ks = kotak_sessions.get(tid)
        if ks:
            ks.logout()
        kotak_sessions.pop(tid, None)
        if tid in spot_tasks:
            spot_tasks[tid].cancel()
            del spot_tasks[tid]
    sid = request.cookies.get("session_id", "")
    sessions.pop(sid, None)
    response.delete_cookie("session_id")
    return {"status": "success"}

@app.post("/api/kotak/connect")
async def kotak_connect(req: TotpRequest, request: Request):
    tid = require_auth(request)
    if not req.totp:
        raise HTTPException(400, "TOTP required")
    trader = await get_trader_by_id(tid)
    if not trader or not trader.get("has_credentials"):
        return {"status": "error", "message": "Kotak credentials not configured"}
    creds = decrypt_credentials(trader)
    if not creds:
        return {"status": "error", "message": "Failed to decrypt credentials"}
    ks = KotakSession(tid, creds)
    kotak_sessions[tid] = ks
    r1 = await kotak_login_totp(ks, req.totp)
    if r1["status"] != "success":
        kotak_sessions.pop(tid, None)
        return r1
    r2 = await kotak_validate_mpin(ks)
    if r2["status"] == "success":
        sd = get_session_data(request)
        sd["kotakLoggedIn"] = True
        start_spot_cache(tid)
        asyncio.create_task(preload_instruments(tid))
    else:
        kotak_sessions.pop(tid, None)
    return r2

@app.post("/api/kotak/disconnect")
async def kotak_disconnect(request: Request):
    tid = require_auth(request)
    ks = kotak_sessions.get(tid)
    if ks:
        ks.logout()
    kotak_sessions.pop(tid, None)
    sd = get_session_data(request)
    sd["kotakLoggedIn"] = False
    if tid in spot_tasks:
        spot_tasks[tid].cancel()
        del spot_tasks[tid]
    return {"status": "success"}

# ─── Trading routes ───

@app.get("/api/spot/{idx}")
async def api_spot(idx: str, request: Request):
    ks = require_kotak(request)
    key = idx.upper()
    price = get_cached_spot(key)
    if price <= 0:
        price = await kotak_get_spot(ks, key)
        if price > 0:
            set_cached_spot(key, price)
    return {"index": key, "spot": price}

@app.get("/api/expiries/{idx}")
async def api_expiries(idx: str, request: Request):
    require_kotak(request)
    return get_expiries(idx)

@app.get("/api/option-chain/{idx}")
async def api_option_chain(idx: str, request: Request, strikes: int = 5, expiry: str = ""):
    ks = require_kotak(request)
    key = idx.upper()
    price = get_cached_spot(key)
    if price <= 0:
        price = await kotak_get_spot(ks, key)
    if price <= 0:
        return {"error": "No spot price"}
    return query_chain_fast(key, price, strikes, expiry)

@app.post("/api/order/fast")
async def api_order_fast(req: FastOrderRequest, request: Request):
    ks = require_kotak(request)
    asyncio.create_task(_execute_fast_order(ks, req.jData, req.action))
    return {"status": "sent", "ts": int(time.time() * 1000)}

async def _execute_fast_order(ks: KotakSession, j_data: str, action: str):
    try:
        t0 = time.time()
        result = await kotak_fast_order(ks, j_data)
        elapsed = int((time.time() - t0) * 1000)
        log.info(f"FAST ORDER {elapsed}ms [{ks.user_id}]: {json.dumps(result)[:500]}")
        if result.get("stat") == "Not_Ok":
            err_msg = (result.get("errMsg","") + result.get("emsg",""))
            if "LTP" in err_msg:
                try:
                    parsed = json.loads(j_data)
                    tok = parsed.get("tok","")
                    q = await fetch_quote(ks, parsed["es"], tok, "ltp") if tok else await fetch_quote(ks, parsed["es"], parsed["ts"], "ltp")
                    ltp = float(q.get("ltp","0") or "0")
                    if ltp > 0:
                        pr = f"{ltp * (1.002 if parsed['tt'] == 'B' else 0.998):.2f}"
                        parsed["pt"] = "L"
                        parsed["pr"] = pr
                        d2 = await kotak_fast_order(ks, json.dumps(parsed))
                        await broadcast_to_user(ks.user_id, {"type": "order_result", "data": d2, "action": action, "elapsed": elapsed})
                        return
                except Exception:
                    pass
        await broadcast_to_user(ks.user_id, {"type": "order_result", "data": result, "action": action, "elapsed": elapsed})
    except Exception as e:
        log.error(f"FAST ORDER error: {e}")
        await broadcast_to_user(ks.user_id, {"type": "order_result", "data": {"stat":"Not_Ok","emsg":str(e)}, "action": action, "elapsed": -1})

@app.post("/api/order/quick")
async def api_order_quick(request: Request):
    ks = require_kotak(request)
    body = await request.json()
    tt, ts, es = body.get("tt",""), body.get("ts",""), body.get("es","")
    lot = int(body.get("lot", 1))
    tok = body.get("tok","") or body.get("symbol","")
    if not tt or not ts or not es:
        return {"stat": "Not_Ok", "emsg": "Missing params"}
    r = await kotak_place_order(ks, es, ts, tt, lot)
    if r.get("stat") == "Not_Ok" and "LTP" in (r.get("errMsg","") + r.get("emsg","")):
        if tok and es:
            q = await fetch_quote(ks, es, tok, "ltp")
            ltp = float(q.get("ltp","0") or "0")
            if ltp > 0:
                pr = f"{ltp * (1.002 if tt == 'B' else 0.998):.2f}"
                r = await kotak_place_order(ks, es, ts, tt, lot, "MIS", "L", pr)
    await broadcast_to_user(ks.user_id, {"type": "order_update", "data": r, "action": f"{'BUY' if tt=='B' else 'SELL'} {ts} x{lot}"})
    return r

@app.post("/api/order/cancel")
async def api_order_cancel(req: CancelRequest, request: Request):
    ks = require_kotak(request)
    r = await kotak_cancel_order(ks, req.on)
    await broadcast_to_user(ks.user_id, {"type": "order_cancelled", "data": r})
    return r

@app.get("/api/orderbook")
async def api_orderbook(request: Request):
    ks = require_kotak(request)
    return await kotak_get_orderbook(ks)

@app.get("/api/positions")
async def api_positions(request: Request):
    ks = require_kotak(request)
    pos_data = await kotak_get_positions(ks)
    stat = (pos_data.get("stat","") or "").lower()
    if stat == "ok" and isinstance(pos_data.get("data"), list):
        for p in pos_data["data"]:
            ba = float(p.get("buyAmt", p.get("cfBuyAmt","0")) or "0")
            sa = float(p.get("sellAmt", p.get("cfSellAmt","0")) or "0")
            p["_pnl"] = sa - ba
    return pos_data

@app.post("/api/ltp")
async def api_ltp(req: LtpRequest, request: Request):
    ks = require_kotak(request)
    if not req.tokens:
        return {"stat": "ok", "data": {}}
    result = {}
    async def fetch_one(t):
        try:
            ltp = 0
            tok = t.get("tok","")
            seg = t.get("seg","nse_fo")
            sym = t.get("sym","")
            if tok:
                q = await fetch_quote(ks, seg, tok, "ltp")
                ltp = float(q.get("ltp","0") or "0")
            if ltp <= 0 and sym:
                q2 = await fetch_quote(ks, seg, sym, "ltp")
                ltp = float(q2.get("ltp","0") or "0")
            if ltp > 0:
                result[sym] = ltp
        except Exception:
            pass
    await asyncio.gather(*[fetch_one(t) for t in req.tokens])
    return {"stat": "ok", "data": result}

@app.get("/api/limits")
async def api_limits(request: Request):
    ks = require_kotak(request)
    return await kotak_get_limits(ks)

@app.post("/api/order/close-all")
async def api_close_all(request: Request):
    ks = require_kotak(request)
    pos_resp = await kotak_get_positions(ks)
    stat = (pos_resp.get("stat","") or "").lower()
    if stat != "ok" or not pos_resp.get("data"):
        return {"status": "error", "message": "No positions to close"}
    results = []
    for pos in pos_resp["data"]:
        buy_q = int(pos.get("flBuyQty", pos.get("cfBuyQty", pos.get("buyQty","0"))) or "0")
        sell_q = int(pos.get("flSellQty", pos.get("cfSellQty", pos.get("sellQty","0"))) or "0")
        try:
            net_qty = int(pos["netQty"]) if "netQty" in pos else (buy_q - sell_q)
        except (ValueError, TypeError):
            net_qty = buy_q - sell_q
        if net_qty == 0:
            continue
        ts = pos.get("trdSym","")
        es = pos.get("seg", pos.get("exSeg","nse_fo"))
        tt = "S" if net_qty > 0 else "B"
        qty = abs(net_qty)
        if not ts or not es:
            continue
        r = await kotak_place_order(ks, es, ts, tt, qty)
        results.append({"symbol": ts, "qty": qty, "side": tt, "result": r})
    await broadcast_to_user(ks.user_id, {"type": "close_all", "count": len(results)})
    return {"status": "ok", "closed": len(results), "results": results}

@app.post("/api/reload/{idx}")
async def api_reload(idx: str, request: Request):
    ks = require_kotak(request)
    key = idx.upper()
    try:
        await download_csv(key, ks)
        build_options_db(key)
        await broadcast_to_user(ks.user_id, {"type": "instruments_ready", "index": key})
        return {"status": "ok", "index": key}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ─── WebSocket ───

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, request: Request = None):
    await ws.accept()
    user_id = ""
    sid = ws.cookies.get("session_id", "")
    sd = sessions.get(sid, {})
    user_id = sd.get("traderId", "")
    if user_id:
        if user_id not in ws_clients:
            ws_clients[user_id] = []
        ws_clients[user_id].append(ws)
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if user_id and user_id in ws_clients:
            clients = ws_clients[user_id]
            if ws in clients:
                clients.remove(ws)

# ─── Static files & root ───

app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

@app.get("/")
async def root():
    return FileResponse(Path(__file__).parent / "static" / "index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5000, loop="uvloop", log_level="info")
