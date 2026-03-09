# Kotak Scalper Terminal

## Overview
Professional options scalping terminal for Kotak Securities NEO API. Dark terminal UI with real-time option chain display, one-click order placement, position tracking, and WebSocket-based updates.

## Architecture
- **Frontend**: React 18 + Tailwind CSS + Wouter routing
- **Backend**: Node.js/Express + WebSocket (ws)
- **No database** - all trading data is in-memory via Kotak API calls
- **In-memory options DB** - CSV scrip master downloaded from Kotak, parsed into memory

## Key Files
- `server/kotak.ts` - Kotak Securities NEO API client (auth, orders, quotes)
- `server/optionsDb.ts` - In-memory options database (CSV download, parse, chain queries)
- `server/routes.ts` - Express API routes + WebSocket server at `/ws`
- `shared/schema.ts` - TypeScript interfaces + minimal drizzle schema (users table kept for compatibility)
- `client/src/pages/terminal.tsx` - Main terminal page with all trading UI
- `client/src/index.css` - Dark terminal theme with CSS variables (--t-* prefix)

## Speed Optimizations
- **Pre-computed order payloads**: All 4 order payloads (BUY/SELL CE/PE) are pre-built in refs when strike/lots change. Zero computation on keypress.
- **Fire-and-forget**: `/api/order/fast` returns immediately ("sent") and fires Kotak order in background. Result delivered via WebSocket with timing info.
- **Refs for hot path**: `strikeRef`, `lotsRef`, `precomputedRef` avoid React re-render overhead on the order dispatch path.
- **Toast shows execution time**: Order result toast includes Kotak API round-trip time in ms.

## API Endpoints
- `POST /api/login` - TOTP + MPIN login
- `GET /api/session` - Check login status
- `GET /api/spot/:idx` - Get spot price (NIFTY/BANKNIFTY/SENSEX)
- `GET /api/expiries/:idx` - Get expiry list
- `GET /api/option-chain/:idx` - Get option chain data
- `POST /api/order/fast` - Fire-and-forget order (pre-built jData, instant response, result via WebSocket)
- `POST /api/order/quick` - Place order synchronously (fallback)
- `POST /api/order/cancel` - Cancel order
- `GET /api/orderbook` - Get order book
- `GET /api/positions` - Get positions
- `GET /api/limits` - Get account limits
- `POST /api/order/close-all` - Close all positions
- `POST /api/reload/:idx` - Reload instruments
- `POST /api/logout` - Logout

## Environment Secrets
- `ACCESS_TOKEN` - Kotak API access token
- `MOBILE_NUMBER` - Registered mobile number
- `MPIN` - Trading MPIN
- `UCC` - Unique Client Code
- `SESSION_SECRET` - Express session secret

## Keyboard Shortcuts
- `1` or `Numpad1` - BUY CE
- `3` or `Numpad3` - SELL CE
- `7` or `Numpad7` - BUY PE
- `9` or `Numpad9` - SELL PE

## Design
- Dark terminal aesthetic (#06080d background)
- JetBrains Mono for prices/numbers
- Green (#10b981) for buy/profit, Red (#ef4444) for sell/loss
- Blue (#3b82f6) for accents, Yellow (#f59e0b) for strike prices
- WebSocket real-time updates with status indicator
