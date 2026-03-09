# Akatsuki - Options Scalping Terminal

## Overview
Multi-user options scalping terminal for Kotak Securities NEO API. Dark terminal UI with real-time option chain display, one-click order placement, position tracking, and WebSocket-based updates. Supports multiple traders with independent Kotak sessions.

## Architecture
- **Frontend**: React 18 + Tailwind CSS + Wouter routing
- **Backend**: Node.js/Express + WebSocket (ws) + express-session
- **Database**: PostgreSQL (Drizzle ORM) - `traders` table for user accounts + encrypted Kotak credentials
- **Per-user sessions**: `Map<userId, KotakSession>` in memory for active trading sessions
- **In-memory options DB** - CSV scrip master downloaded from Kotak, parsed into memory (shared across users)

## Auth Flow
1. **Register/Login**: Email + password (SHA-256 hashed)
2. **Save Credentials** (first time only): Access Token, Mobile Number, MPIN, UCC saved to DB
3. **TOTP Connect**: 6-digit TOTP from authenticator app → Kotak API login → trading session
4. **Subsequent logins**: Email/password → TOTP only (credentials already saved)

## Key Files
- `server/kotak.ts` - Per-user Kotak API client (session map, auth, orders, quotes)
- `server/optionsDb.ts` - In-memory options database (CSV download, parse, chain queries)
- `server/routes.ts` - Express API routes + WebSocket + auth middleware
- `server/storage.ts` - Database CRUD for traders table
- `server/db.ts` - Drizzle PostgreSQL connection
- `shared/schema.ts` - Drizzle schema (traders table) + TypeScript interfaces
- `client/src/pages/terminal.tsx` - Full terminal: auth screens + trading UI
- `client/src/index.css` - Dark terminal theme with CSS variables (--t-* prefix)

## Speed Optimizations
- **Pre-computed order payloads**: All 4 order payloads (BUY/SELL CE/PE) are pre-built in refs when strike/lots change. Zero computation on keypress.
- **Fire-and-forget**: `/api/order/fast` returns immediately ("sent") and fires Kotak order in background. Result delivered via WebSocket with timing info.
- **Refs for hot path**: `strikeRef`, `lotsRef`, `precomputedRef` avoid React re-render overhead on the order dispatch path.
- **Toast shows execution time**: Order result toast includes Kotak API round-trip time in ms.

## API Endpoints
### Auth
- `POST /api/auth/register` - Create account (email, password)
- `POST /api/auth/login` - Login (email, password) → returns hasCredentials flag
- `POST /api/auth/credentials` - Save Kotak API credentials (first time)
- `GET /api/auth/session` - Check auth + Kotak connection status
- `POST /api/auth/logout` - Logout + disconnect Kotak

### Kotak
- `POST /api/kotak/connect` - TOTP login to Kotak
- `POST /api/kotak/disconnect` - Disconnect Kotak session

### Trading
- `GET /api/spot/:idx` - Get spot price (NIFTY/BANKNIFTY/SENSEX)
- `GET /api/expiries/:idx` - Get expiry list
- `GET /api/option-chain/:idx` - Get option chain data
- `POST /api/order/fast` - Fire-and-forget order (pre-built jData)
- `POST /api/order/quick` - Place order synchronously (fallback)
- `POST /api/order/cancel` - Cancel order
- `GET /api/orderbook` - Get order book
- `GET /api/positions` - Get positions
- `GET /api/limits` - Get account limits
- `POST /api/order/close-all` - Close all positions
- `POST /api/reload/:idx` - Reload instruments

## Environment Secrets
- `SESSION_SECRET` - Express session secret
- (Per-user: ACCESS_TOKEN, MOBILE_NUMBER, MPIN, UCC stored in DB)

## Keyboard Shortcuts
- `1` or `Numpad1` - BUY CE
- `3` or `Numpad3` - SELL CE
- `7` or `Numpad7` - BUY PE
- `9` or `Numpad9` - SELL PE

## Design
- Branded as "AKATSUKI" with copyright footer (Dr. Arvind Dahiya & HC)
- Dark terminal aesthetic (#06080d background)
- JetBrains Mono for prices/numbers
- Green (#10b981) for buy/profit, Red (#ef4444) for sell/loss
- Blue (#3b82f6) for accents, Yellow (#f59e0b) for strike prices
- WebSocket real-time updates with status indicator
- Multi-step auth screens with same dark aesthetic

## Responsive Layout
- **Desktop (md+)**: Full action bar with CE/PE buttons flanking center strike info + lots control, keyboard shortcut hints visible, positions/orders side-by-side when both toggled open
- **Mobile (<md)**: Compact header (clock/username hidden), P&L strip always visible above buttons, 2-column grid with large touch-friendly BUY/SELL buttons (CE left, PE right), active:scale press feedback
- Option Chain, Positions, Orders all behind toggle buttons in the controls bar (collapsed by default)
- Auth screens (login, credentials, TOTP) use max-width with responsive padding
