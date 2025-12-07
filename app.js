/**
 * UI Controller (app.js)
 * Connects the DOM to the GameServer events.
 */

const App = {
    chart: {
        canvas: null,
        ctx: null,
        data: [], // Stores {x, y} points
        maxPoints: 200 // Sliding window size
    },

    init: () => {
        // Elements
        const canvas = document.getElementById('chartCanvas');
        App.chart.canvas = canvas;
        App.chart.ctx = canvas.getContext('2d');

        // Listeners - Window
        window.addEventListener('resize', App.resizeCanvas);
        App.resizeCanvas();

        // Listeners - Server Events
        if (!window.gameServer) return console.error("GameServer not found!");

        window.gameServer.subscribe((event, data) => {
            console.log("EVENT:", event, data);
            switch (event) {
                case 'INITIAL_STATE': App.onInit(data); break;
                case 'USER_UPDATE': App.updateUserUI(data); break;
                case 'GAME_START': App.onGameStart(data); break;
                case 'TICK': App.onTick(data); break;
                case 'GAME_CRASHED': App.onCrash(data); break;
                case 'BET_PLACED': App.onBet(data); break;
                case 'CASHOUT_SUCCESS': App.onCashout(data); break;
                case 'HISTORY_UPDATE': App.updateHistory(data); break;
            }
        });
    },

    // --- Actions ---
    resizeCanvas: () => {
        const p = App.chart.canvas.parentElement;
        App.chart.canvas.width = p.clientWidth;
        App.chart.canvas.height = p.clientHeight;
    },

    login: () => {
        const user = document.getElementById('usernameInput').value;
        const res = window.gameServer.login(user);
        if (res.success) App.closeModal('loginModal');
    },

    startGame: (modeIdx) => {
        App.showPage('gamePage');
        setTimeout(() => {
            // Simulate "Connecting to match..."
            window.gameServer.startGame(modeIdx);
        }, 500);
    },

    placeBet: () => {
        const amt = parseInt(document.getElementById('betAmount').value);
        const res = window.gameServer.placeBet(amt);
        if (res.error) alert(res.error);
    },

    cashOut: () => {
        const res = window.gameServer.cashOut();
        if (res.error) console.error(res.error);
    },

    // --- Event Handlers ---

    onInit: (state) => {
        if (state.user) App.updateUserUI(state.user);
        if (state.history) App.updateHistory(state.history);
    },

    updateUserUI: (user) => {
        if (user) {
            document.getElementById('loginBtn').style.display = 'none';
            document.getElementById('logoutBtn').style.display = 'block';
            document.getElementById('userStats').style.display = 'flex';
            document.getElementById('username').innerText = user.username;
            document.getElementById('crashCashBalance').innerText = Math.floor(user.balance).toLocaleString();
            document.getElementById('referralCode').innerText = user.referralCode;
            document.getElementById('totalProfit').innerText = Math.floor(user.totalProfit).toLocaleString();
            document.getElementById('loginModal').classList.remove('active');
        } else {
            document.getElementById('loginBtn').style.display = 'block';
            document.getElementById('logoutBtn').style.display = 'none';
            document.getElementById('userStats').style.display = 'none';
        }
    },

    onGameStart: ({ id }) => {
        document.getElementById('multiplierDisplay').className = 'multiplier-display';
        document.getElementById('multiplierDisplay').innerText = '1.00x';
        document.getElementById('marketHaltOverlay').classList.remove('active');
        document.getElementById('placeBetBtn').disabled = false;
        document.getElementById('course-text') ? document.getElementById('course-text').innerText = "Live" : null;

        // Reset Chart
        App.chart.data = [{ x: 0, y: 1.0 }];
        App.drawChart();
    },

    onTick: ({ multiplier, elapsed }) => {
        // Update Chart Data
        App.chart.data.push({ x: elapsed, y: multiplier });
        // Sliding Window
        if (App.chart.data.length > App.chart.maxPoints) {
            App.chart.data.shift();
        }
        App.drawChart(multiplier);

        // UI
        const disp = document.getElementById('multiplierDisplay');
        disp.innerText = multiplier.toFixed(2) + 'x';
        disp.classList.add('positive');
    },

    onBet: () => {
        document.getElementById('placeBetBtn').style.display = 'none';
        document.getElementById('cashOutBtn').style.display = 'block';
        document.getElementById('cashOutBtn').classList.add('active');
    },

    onCashout: ({ winAmount }) => {
        document.getElementById('cashOutBtn').innerText = `WON ${winAmount}`;
        document.getElementById('cashOutBtn').disabled = true;
    },

    onCrash: ({ crashPoint }) => {
        const disp = document.getElementById('multiplierDisplay');
        disp.innerText = crashPoint.toFixed(2) + 'x';
        disp.classList.remove('positive');
        disp.classList.add('negative');
        document.getElementById('marketHaltOverlay').classList.add('active');

        // Reset Buttons
        document.getElementById('cashOutBtn').style.display = 'none';
        document.getElementById('cashOutBtn').disabled = false;
        document.getElementById('cashOutBtn').innerText = 'CASH OUT';

        document.getElementById('placeBetBtn').style.display = 'block';
        document.getElementById('placeBetBtn').innerText = 'PLACE TRADE';

        // Auto restart for prototype feel
        setTimeout(() => {
            window.gameServer.startGame(0);
        }, 3000);
    },

    updateHistory: (history) => {
        const container = document.getElementById('gameHistory');
        container.innerHTML = history.map(h => `
            <div class="history-item">
                <span class="history-multiplier ${h.status}">${h.mult.toFixed(2)}x</span>
                <span class="history-amount ${h.status}">${h.profit > 0 ? '+' : ''}${h.profit}</span>
            </div>
        `).join('');
    },

    // --- Helpers ---
    showPage: (id) => {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    },

    closeModal: (id) => document.getElementById(id).classList.remove('active'),

    drawChart: (currentMult = 1.0) => {
        const ctx = App.chart.ctx;
        const w = App.chart.canvas.width;
        const h = App.chart.canvas.height;
        const data = App.chart.data;

        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;

        // Scaling
        // X-axis: Min time to Max time in window
        // Y-axis: 1.0 to Max Multiplier + padding

        const minX = data[0].x;
        const maxX = data[data.length - 1].x;
        const rangeX = maxX - minX || 1; // avoid div 0

        const maxY = currentMult * 1.1; // 10% padding top
        const minY = 1.0;
        const rangeY = maxY - minY || 0.1;

        for (let i = 0; i < data.length; i++) {
            const p = data[i];

            const x = ((p.x - minX) / rangeX) * w;
            const normalizedY = (p.y - minY) / rangeY;
            const y = h - (normalizedY * h);

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Gradient fill below
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = '#00ff88';
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }
};

window.onload = App.init;

// Global Hooks for OnClick attributes in HTML (Legacy support)
window.showLoginModal = () => document.getElementById('loginModal').classList.add('active');
window.closeModal = App.closeModal;
window.register = App.login;
window.startGame = App.startGame;
window.placeBet = App.placeBet;
window.cashOut = App.cashOut;
window.setBetAmount = (amt) => document.getElementById('betAmount').value = amt;
window.showPage = App.showPage;
window.logout = () => window.gameServer.logout();
window.showRedeemModal = () => document.getElementById('redeemModal').classList.add('active');
window.redeemCash = () => window.gameServer.redeem(document.getElementById('redeemAmount').value);
window.showEnterCodeModal = () => document.getElementById('enterCodeModal').classList.add('active');
