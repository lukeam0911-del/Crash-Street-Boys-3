/**
 * Mock Game Server
 * Simulates a backend server to keep game state secure and separate from UI.
 */

class GameServer {
    constructor() {
        // "Private" server state - not accessible directly by UI
        this._state = {
            user: null, // { username, balance, referralCode, totalProfit }
            game: {
                id: null,
                running: false,
                multiplier: 1.00,
                crashPoint: 0,
                startTime: 0,
                history: []
            },
            bets: new Map() // gameId -> { amount, cashedOut, profit }
        };

        this._subscribers = [];
        this._loopInterval = null;
        this._config = {
            houseEdge: 0.01, // 1%
            tickRate: 30
        };

        // Load from "Database" (LocalStorage for prototype persistence)
        this._loadUser();
    }

    // --- Public API (Simulates Socket Events) ---

    subscribe(callback) {
        this._subscribers.push(callback);
        // Send initial state
        this._emit('INITIAL_STATE', this._getPublicState());
    }

    login(username) {
        if (!username) return { error: "Username required" };

        this._state.user = {
            username: username,
            balance: 5000,
            referralCode: 'USER-' + Math.floor(1000 + Math.random() * 9000),
            totalProfit: 0
        };
        this._saveUser();
        this._emit('USER_UPDATE', this._state.user);
        return { success: true };
    }

    logout() {
        this._state.user = null;
        this._clearUser();
        this._emit('USER_UPDATE', null);
    }

    redeem(amount) {
        if (!this._state.user) return { error: "Not logged in" };
        if (amount > this._state.user.balance) return { error: "Insufficient funds" };
        this._state.user.balance -= amount;
        this._saveUser();
        this._emit('USER_UPDATE', this._state.user);
        return { success: true, message: `Redeemed $${(amount / 1000).toFixed(2)}` };
    }

    startGame(modeId) {
        if (this._state.game.running) return;

        // Reset Game State
        this._state.game.running = true;
        this._state.game.multiplier = 1.00;
        this._state.game.id = Date.now().toString();
        this._state.game.startTime = Date.now();
        this._state.game.crashed = false;

        // --- Provably Fair Crash Logic ---
        // Formula: E = 0.99 / (1 - r)
        // This distributes 1.00x - Infinity based on uniform random 'r'
        const r = Math.random();
        this._state.game.crashPoint = 0.99 / (1 - r);

        // Instant crash at 1.00x (House Edge event) happens if crashPoint < 1.00
        // (The formula effectively handles this, but let's clamp)
        if (this._state.game.crashPoint < 1.00) this._state.game.crashPoint = 1.00;

        // Cap for prototype safety (e.g. 1000x max)
        this._state.game.crashPoint = Math.min(this._state.game.crashPoint, 1000);

        this._emit('GAME_START', { id: this._state.game.id, modeId });

        // Start Loop
        this._loopInterval = setInterval(() => this._gameLoop(), this._config.tickRate);
    }

    placeBet(amount) {
        if (!this._state.game.running && !this._state.game.crashed) {
            // Allow betting during "countdown" or idle? 
            // For this prototype, we bet BEFORE the game starts usually, 
            // but let's assume we can bet right when we click 'Start' for single player.
            // Actually, in single player, Start = Bet usually.
        }

        if (!this._state.user) return { error: "Login required" };
        if (amount > this._state.user.balance) return { error: "Insufficient funds" };
        if (amount < 10) return { error: "Min bet 10" };

        this._state.user.balance -= amount;
        this._state.bets.set(this._state.game.id, {
            amount: amount,
            cashedOut: false,
            profit: 0
        });

        this._saveUser();
        this._emit('USER_UPDATE', this._state.user);
        this._emit('BET_PLACED', { amount });
        return { success: true };
    }

    cashOut() {
        if (!this._state.game.running) return { error: "Game not running" };
        const bet = this._state.bets.get(this._state.game.id);

        if (!bet || bet.cashedOut) return { error: "No active bet" };

        const currentMult = this._state.game.multiplier;
        const winAmount = Math.floor(bet.amount * currentMult);
        const profit = winAmount - bet.amount;

        bet.cashedOut = true;
        bet.profit = profit;

        this._state.user.balance += winAmount;
        this._state.user.totalProfit += profit;
        this._saveUser();

        this._emit('CASHOUT_SUCCESS', { multiplier: currentMult, winAmount, profit });
        this._emit('USER_UPDATE', this._state.user);
        return { success: true };
    }

    // --- Private Methods ---

    _gameLoop() {
        if (!this._state.game.running) return;

        const now = Date.now();
        const elapsed = (now - this._state.game.startTime) / 1000; // seconds

        // Exponential Growth: Multiplier = e^(0.06 * elapsed) usually
        // Let's use a simpler exponential for creating excitement
        // M(t) = 1.0 + t^1.5 * 0.1 was the old one.
        // Standard crash is roughly M(t) = 1.00 * e^(k*t)
        const growthRate = 0.15; // Tunable speed
        this._state.game.multiplier += (this._state.game.multiplier * growthRate * (this._config.tickRate / 1000));

        if (this._state.game.multiplier >= this._state.game.crashPoint) {
            this._crash();
        } else {
            this._emit('TICK', {
                multiplier: this._state.game.multiplier,
                elapsed: elapsed
            });
        }
    }

    _crash() {
        clearInterval(this._loopInterval);
        this._state.game.running = false;
        this._state.game.crashed = true;

        // Final value is the exact crash point
        const finalCrash = this._state.game.crashPoint;

        // Check if player lost
        const bet = this._state.bets.get(this._state.game.id);
        if (bet && !bet.cashedOut) {
            // Player lost
            this._state.user.totalProfit -= bet.amount;
            this._saveUser();
            this._emit('BET_LOST', { amount: bet.amount });
            // History
            this._addToHistory(finalCrash, -bet.amount, 'lost');
        } else if (bet && bet.cashedOut) {
            // Player won earlier
            this._addToHistory(finalCrash, bet.profit, 'won');
        } else {
            // No bet
            this._addToHistory(finalCrash, 0, 'none');
        }

        this._emit('GAME_CRASHED', { crashPoint: finalCrash });
        this._emit('USER_UPDATE', this._state.user);
    }

    _addToHistory(mult, profit, status) {
        this._state.game.history.unshift({ mult, profit, status });
        if (this._state.game.history.length > 50) this._state.game.history.pop();
        this._emit('HISTORY_UPDATE', this._state.game.history);
    }

    _emit(event, data) {
        this._subscribers.forEach(cb => cb(event, data));
    }

    _getPublicState() {
        return {
            user: this._state.user,
            history: this._state.game.history
        };
    }

    _saveUser() {
        if (this._state.user) {
            localStorage.setItem('cs_user', JSON.stringify(this._state.user));
        }
    }

    _loadUser() {
        const saved = localStorage.getItem('cs_user');
        if (saved) {
            try {
                this._state.user = JSON.parse(saved);
            } catch (e) {
                console.error("Save file corrupted");
            }
        }
    }

    _clearUser() {
        localStorage.removeItem('cs_user');
    }
}

// Export singleton
const gameServer = new GameServer();
window.gameServer = gameServer; // Expose to window for app.js to find, but NOT for user (ideally in a module system this wouldn't be on window)
