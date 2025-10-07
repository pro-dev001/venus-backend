# app.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import os, json, time, math, datetime, decimal, threading, uuid, random

app = Flask(__name__)
CORS(app)

DATA_FILE = os.path.join(os.path.dirname(__file__), "data.json")

# Initialize storage if missing
def load_data():
    if not os.path.isfile(DATA_FILE):
        base = {
            "users": {
                # example user for testing:
                # "alice": {"balance": 1000.0, "trades": []}
            },
            "pair_seeds": {
                # deterministic seeds per pair (client and server use the same)
                # e.g. "EUR/USD": 12345
            }
        }
        with open(DATA_FILE, "w") as f:
            json.dump(base, f, indent=2)
        return base
    with open(DATA_FILE, "r") as f:
        return json.load(f)

def save_data(d):
    with open(DATA_FILE, "w") as f:
        json.dump(d, f, indent=2, default=str)

_data_lock = threading.Lock()

# deterministic pseudo-random price generator based on seed + unix timestamp (seconds)
def price_at(seed: int, ts: float):
    # ts is UNIX seconds (float)
    # build a deterministic pseudo-random waveform + small noise from seed
    # scale factors tuned for FX-like movements
    t = ts / 60.0  # minutes scale
    base = 1.0 + ((seed % 1000) / 1000.0) * 0.5  # base moves a bit per pair
    # primary slow wave
    w1 = math.sin((t * 2 * math.pi) / 1440.0 + (seed % 17)) * 0.0025
    # medium wave
    w2 = math.sin((t * 2 * math.pi) / 60.0 + (seed % 23)) * 0.0015
    # fast jitter derived deterministically from timestamp
    jitter = (((int(ts) ^ seed) % 1000) / 1000.0 - 0.5) * 0.0008
    return base + w1 + w2 + jitter

# helper: ensure user exists
def ensure_user(username):
    with _data_lock:
        d = load_data()
        if username not in d["users"]:
            d["users"][username] = {"balance": 1000.0, "trades": []}
            save_data(d)
        return d

# settle any expired trades for all users (idempotent)
def settle_expired_trades_for_all():
    now = time.time()
    changed = False
    with _data_lock:
        d = load_data()
        for username, u in d["users"].items():
            new_trades = []
            for trade in u.get("trades", []):
                if trade.get("settled"):
                    new_trades.append(trade)
                    continue
                if now >= trade["expires_at"]:
                    # need to settle deterministically comparing entry & exit price
                    pair = trade["pair"]
                    seed = d["pair_seeds"].get(pair) or (abs(hash(pair)) % 100000)
                    # compute prices at placed_at and at expires_at
                    entry_price = price_at(seed, trade["placed_at"])
                    exit_price = price_at(seed, trade["expires_at"])
                    side = trade["side"]
                    win = (side == "buy" and exit_price > entry_price) or (side == "sell" and exit_price < entry_price)
                    trade["exit_price"] = exit_price
                    trade["result"] = "win" if win else "loss"
                    trade["settled"] = True
                    # profit: +95% of stake when win (credit stake + profit), otherwise stake already debited so no change
                    if win:
                        profit = float(decimal.Decimal(str(trade["amount"])) * decimal.Decimal("0.95"))
                        # credit profit + stake back
                        u["balance"] = float(decimal.Decimal(str(u["balance"])) + decimal.Decimal(str(trade["amount"])) + decimal.Decimal(str(profit)))
                    # if lost: stake was debited when trade started
                    changed = True
                    new_trades.append(trade)
                else:
                    new_trades.append(trade)
            u["trades"] = new_trades
        if changed:
            save_data(d)
    return

# API: get user data (balance, active trades, seeds)
@app.route("/user-data")
def user_data():
    username = request.args.get("username")
    if not username:
        return jsonify({"ok": False, "error": "missing username"}), 400
    # settle expired trades before returning
    settle_expired_trades_for_all()
    with _data_lock:
        d = load_data()
    # ensure pair seeds exist for common pairs
    pairs = ["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","BTC/USD","ETH/USD","XRP/USD","LTC/USD","NZD/USD","EUR/GBP"]
    with _data_lock:
        for p in pairs:
            if p not in d["pair_seeds"]:
                d["pair_seeds"][p] = random.randint(1, 99999)
        save_data(d)

    # ensure user exists
    with _data_lock:
        d = load_data()
        if username not in d["users"]:
            d["users"][username] = {"balance": 1000.0, "trades": []}
            save_data(d)
        user = d["users"][username]
        # provide only unsettled (active) trades to client plus all trades if you'd like
        active_trades = [t for t in user.get("trades", []) if not t.get("settled", False)]
        # For each active trade include remaining seconds
        now = time.time()
        at = []
        for t in active_trades:
            remaining = max(0, int(t["expires_at"] - now))
            at.append({
                "trade_id": t["trade_id"],
                "pair": t["pair"],
                "side": t["side"],
                "amount": t["amount"],
                "placed_at": t["placed_at"],
                "expires_at": t["expires_at"],
                "remaining": remaining,
                "entry_price": price_at(d["pair_seeds"].get(t["pair"], 1), t["placed_at"]),
            })
        return jsonify({
            "ok": True,
            "balance": float(user["balance"]),
            "active_trades": at,
            "pair_seeds": d["pair_seeds"]
        })

# API: start trade (debit immediately)
@app.route("/start-trade", methods=["POST"])
def start_trade():
    payload = request.get_json(force=True)
    username = payload.get("username")
    pair = payload.get("pair")
    side = payload.get("side")
    amount = float(payload.get("amount", 0))
    duration = int(payload.get("duration", 60))
    if not username or not pair or side not in ("buy","sell") or amount <= 0:
        return jsonify({"ok": False, "error": "invalid payload"}), 400

    with _data_lock:
        d = load_data()
        if username not in d["users"]:
            d["users"][username] = {"balance": 1000.0, "trades": []}
        user = d["users"][username]
        if float(user["balance"]) < amount:
            return jsonify({"ok": False, "error": "insufficient balance"}), 400
        # debit immediately
        user["balance"] = float(decimal.Decimal(str(user["balance"])) - decimal.Decimal(str(amount)))
        # ensure pair seed
        if pair not in d["pair_seeds"]:
            d["pair_seeds"][pair] = random.randint(1, 99999)
        placed_at = time.time()
        expires_at = placed_at + duration
        trade_id = str(uuid.uuid4())
        trade = {
            "trade_id": trade_id,
            "pair": pair,
            "side": side,
            "amount": amount,
            "placed_at": placed_at,
            "expires_at": expires_at,
            "settled": False
        }
        user.setdefault("trades", []).append(trade)
        save_data(d)
    return jsonify({"ok": True, "trade_id": trade_id, "new_balance": float(user["balance"])})

# API: optionally let client ask to settle a trade (server will settle automatically on next user-data call anyway)
@app.route("/settle-trade", methods=["POST"])
def settle_trade_endpoint():
    payload = request.get_json(force=True)
    username = payload.get("username")
    trade_id = payload.get("trade_id")
    if not username or not trade_id:
        return jsonify({"ok": False, "error": "missing"}), 400
    # call settle_expired_trades_for_all (which will settle any expired ones)
    settle_expired_trades_for_all()
    with _data_lock:
        d = load_data()
        user = d["users"].get(username)
        if not user:
            return jsonify({"ok": False, "error": "user not found"}), 404
        # return updated balance and trade status if present
        for t in user.get("trades", []):
            if t["trade_id"] == trade_id:
                return jsonify({"ok": True, "trade": t, "balance": float(user["balance"])})
    return jsonify({"ok": False, "error": "trade not found"}), 404

# helper endpoint to expose deterministic price at timestamp (for debugging)
@app.route("/price_at")
def price_at_endpoint():
    pair = request.args.get("pair", "EUR/USD")
    ts = float(request.args.get("ts", time.time()))
    d = load_data()
    seed = d["pair_seeds"].get(pair, abs(hash(pair)) % 100000)
    return jsonify({"price": price_at(seed, ts), "seed": seed})

if __name__ == "__main__":
    # ensure file exists and seeds for default pairs
    with _data_lock:
        d = load_data()
        default_pairs = ["EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","BTC/USD","ETH/USD","XRP/USD","LTC/USD","NZD/USD","EUR/GBP"]
        for p in default_pairs:
            if p not in d["pair_seeds"]:
                d["pair_seeds"][p] = random.randint(1, 99999)
        save_data(d)
    app.run(host="0.0.0.0", port=5000, debug=True)
