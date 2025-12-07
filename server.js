const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const CryptoJS = require('crypto-js');
const path = require('path');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const paymentRoutes = require('./routes/payments');

const {
    createUser,
    findUserByEmail,
    findUserById,
    updateUserBalance
} = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_123';

app.use(cors());

// Webhook raw body handling
app.use('/api', (req, res, next) => {
    if (req.originalUrl === '/api/webhook') {
        next();
    } else {
        bodyParser.json()(req, res, next);
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', paymentRoutes);

// serve the main page on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- API ROUTES ---

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

        await createUser(username, email, password);
        res.status(201).json({ message: 'User created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error creating user (email/username might be taken)' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await findUserByEmail(email);
        if (!user) return res.status(400).json({ error: 'User not found' });

        const valid = await require('bcrypt').compare(password, user.password_hash);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get Profile
app.get('/api/me', authenticateToken, async (req, res) => {
    const user = await findUserById(req.user.id);
    res.json(user);
});

// --- GAME LOGIC ---

class GameRoom {
    constructor(ticker, lambda, roomName) {
        this.ticker = ticker;
        this.lambda = lambda;
        this.roomName = roomName;

        this.isRunning = false;
        this.multiplier = 1.00;
        this.startTime = 0;
        this.crashPoint = 0;

        // Active bets: userId -> { amount, cashedOut: false, winAmount: 0 }
        this.bets = new Map();

        // Provably Fair
        this.serverSeed = null;
        this.serverSeedHash = null;
        this.nonce = 0;

        this.rotateSeed();
        this.startDateLoop();
    }

    rotateSeed() {
        const chars = 'abcdef0123456789';
        let result = '';
        for (let i = 0; i < 64; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        this.serverSeed = result;
        this.serverSeedHash = CryptoJS.SHA256(this.serverSeed).toString();
        this.nonce++;
    }

    getCrashPoint() {
        // Standard PF logic
        const combo = `${this.serverSeed}:${this.nonce}`;
        const hash = CryptoJS.HmacSHA256(combo, this.serverSeed).toString(); // simplified chain

        // 1 in 13 instant crash (1.00x)
        if (parseInt(hash.substring(0, 13), 16) % 13 === 0) return 1.00;

        const h = parseInt(hash.substring(0, 8), 16);
        const e = Math.pow(2, 32);
        const result = Math.floor((100 * 0.99) / (1 - (h / e))) / 100;
        return Math.max(1.00, result);
    }

    startDateLoop() {
        this.startGame();
    }

    startGame() {
        if (this.isRunning) return;
        this.rotateSeed();
        this.crashPoint = this.getCrashPoint();
        this.multiplier = 1.00;
        this.isRunning = true;
        this.startTime = Date.now() + 6000; // 6 seconds betting phase
        this.bets.clear();

        io.to(this.roomName).emit('game_start', {
            ticker: this.ticker,
            nonce: this.nonce,
            hash: this.serverSeedHash,
            startTime: this.startTime
        });

        // Betting Phase
        setTimeout(() => {
            this.runGameLoop();
        }, 6000);
    }

    runGameLoop() {
        const loopStart = Date.now();
        const interval = setInterval(() => {
            const elapsed = (Date.now() - loopStart) / 1000;

            // Growth function
            const k = 0.065 * (2.0 / this.lambda);
            const M = Math.pow(Math.E, k * elapsed * 2.5);
            this.multiplier = Math.max(1.00, parseFloat(M.toFixed(2)));

            if (this.multiplier >= this.crashPoint) {
                this.crashGame();
                clearInterval(interval);
            } else {
                io.to(this.roomName).emit('tick', this.multiplier);
            }
        }, 50);
    }

    crashGame() {
        this.isRunning = false;
        io.to(this.roomName).emit('crash', {
            multiplier: this.crashPoint,
            serverSeed: this.serverSeed
        });

        // Loop next game
        setTimeout(() => {
            this.startGame();
        }, 3000);
    }
}

const rooms = {
    'CORLA': new GameRoom('$CORLA', 2.5, 'CORLA'),
    'BRKR': new GameRoom('$BRKR', 1.75, 'BRKR'),
    'NFTX': new GameRoom('$NFTX', 1.4, 'NFTX'),
    'ETHRX': new GameRoom('$ETHRX', 1.0, 'ETHRX'),
    'TSLR': new GameRoom('$TSLR', 0.75, 'TSLR')
};

// --- SOCKET HANDLERS ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = decoded;
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`User ${socket.user.username} connected`);

    // Join Room
    socket.on('join_room', (roomName) => {
        if (rooms[roomName]) {
            socket.join(roomName);
            const r = rooms[roomName];
            socket.emit('current_game_state', {
                isRunning: r.isRunning,
                multiplier: r.multiplier,
                hash: r.serverSeedHash
            });
        }
    });

    // Place Bet
    socket.on('place_bet', async ({ room, amount }) => {
        if (!rooms[room]) return;
        const game = rooms[room];

        // Check phase (must be betting phase, i.e., before loop starts but isRunning is true? 
        // Logic adjust: isRunning=true meant game loop running in old code. 
        // New logic: Betting phase is implicit before 'tick' starts?
        // Let's simplify: If multiplier > 1.0, it's too late.
        if (game.multiplier > 1.0) {
            return socket.emit('bet_error', 'Game already started');
        }

        if (amount <= 0) return socket.emit('bet_error', 'Invalid amount');

        try {
            // Deduct balance
            await updateUserBalance(socket.user.id, -amount, 'bet', `room:${room}:nonce:${game.nonce}`);

            // Record bet
            game.bets.set(socket.user.id, { amount, cashedOut: false, winAmount: 0 });
            socket.emit('bet_success', { amount });

            // Get new balance to update UI
            const user = await findUserById(socket.user.id);
            socket.emit('balance_update', user.balance);

        } catch (err) {
            socket.emit('bet_error', err.message);
        }
    });

    // Cash Out
    socket.on('cash_out', async ({ room }) => {
        if (!rooms[room]) return;
        const game = rooms[room];

        if (!game.isRunning) return socket.emit('error', 'Game not running');
        // If crash just happened, strict check:
        // Actually crashGame sets isRunning=false. So this check passes if we are essentially alive.

        // Get user bet
        const bet = game.bets.get(socket.user.id);
        if (!bet) return socket.emit('error', 'No active bet');
        if (bet.cashedOut) return socket.emit('error', 'Already cashed out');

        const currentMult = game.multiplier;
        if (currentMult > game.crashPoint) {
            // Too late! (Race condition check)
            return socket.emit('error', 'Crashed!');
        }

        // Calculate Win
        const winAmount = Math.floor(bet.amount * currentMult);
        bet.cashedOut = true;
        bet.winAmount = winAmount;

        try {
            await updateUserBalance(socket.user.id, winAmount, 'win', `room:${room}:nonce:${game.nonce}`);
            socket.emit('cash_out_success', { multiplier: currentMult, winAmount });

            // Get new balance
            const user = await findUserById(socket.user.id);
            socket.emit('balance_update', user.balance);
        } catch (err) {
            console.error(err); // Should not happen on credit
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
