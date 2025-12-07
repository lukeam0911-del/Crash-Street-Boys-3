const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'crash_street.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initSchema();
    }
});

function initSchema() {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance REAL DEFAULT 1000.0,
            stripe_customer_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Transactions Table
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- 'deposit', 'withdraw', 'bet', 'win'
            amount REAL NOT NULL,
            status TEXT DEFAULT 'completed',
            external_id TEXT, -- Stripe Charge ID etc
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`);

        // Game History Table
        db.run(`CREATE TABLE IF NOT EXISTS game_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT NOT NULL,
            crash_point REAL NOT NULL,
            server_seed TEXT,
            hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        console.log('Database schema initialized.');
    });
}

// --- HELPER FUNCTIONS ---

const get = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const run = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
};

const all = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

// User Methods
const createUser = async (username, email, password) => {
    const hash = await bcrypt.hash(password, 10);
    return run(
        `INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)`,
        [username, email, hash]
    );
};

const findUserByEmail = (email) => {
    return get(`SELECT * FROM users WHERE email = ?`, [email]);
};

const findUserById = (id) => {
    return get(`SELECT id, username, email, balance, created_at FROM users WHERE id = ?`, [id]);
};

const updateUserBalance = async (userId, amount, type, externalId = null) => {
    // Transactional update
    return new Promise((resolve, reject) => {
        db.serialize(async () => {
            try {
                await run('BEGIN TRANSACTION');

                // Get current balance
                const user = await get('SELECT balance FROM users WHERE id = ?', [userId]);
                if (!user) throw new Error('User not found');

                const newBalance = user.balance + amount;
                if (newBalance < 0) throw new Error('Insufficient funds'); // Check mainly for bets/withdrawals

                // Update Balance
                await run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

                // Log Transaction
                await run(
                    'INSERT INTO transactions (user_id, type, amount, external_id) VALUES (?, ?, ?, ?)',
                    [userId, type, Math.abs(amount), externalId]
                );

                await run('COMMIT');
                resolve(newBalance);
            } catch (err) {
                await run('ROLLBACK');
                reject(err);
            }
        });
    });
};

module.exports = {
    db,
    createUser,
    findUserByEmail,
    findUserById,
    updateUserBalance
};
