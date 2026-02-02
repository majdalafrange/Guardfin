// ===== GUARDFIN AI - MAIN APPLICATION =====
// Privacy-first financial planner with AI agent capabilities

const API_URL = 'http://localhost:3001';

// ===== CRYPTO MODULE =====
class SecureCrypto {
    constructor() {
        this.key = null;
        this.accountId = null;
        this.salt = null;
    }

    generateUUID() {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        arr[6] = (arr[6] & 0x0f) | 0x40;
        arr[8] = (arr[8] & 0x3f) | 0x80;
        const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    generateSalt() {
        return crypto.getRandomValues(new Uint8Array(32));
    }

    async deriveKey(passphrase, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async createVerifier(passphrase, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, keyMaterial, 256);
        return Array.from(new Uint8Array(bits));
    }

    async verifyPassword(passphrase, salt, storedVerifier) {
        const computed = await this.createVerifier(passphrase, salt);
        if (computed.length !== storedVerifier.length) return false;
        let result = 0;
        for (let i = 0; i < computed.length; i++) result |= computed[i] ^ storedVerifier[i];
        return result === 0;
    }

    async encrypt(data) {
        if (!this.key) throw new Error('No encryption key');
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, encoded);
        return { version: '1.0', algorithm: 'AES-GCM', iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)), timestamp: Date.now() };
    }

    async decrypt(obj) {
        if (!this.key) throw new Error('No encryption key');
        if (obj.version !== '1.0' || obj.algorithm !== 'AES-GCM') throw new Error('Unsupported format');
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(obj.iv) }, this.key, new Uint8Array(obj.data));
        return JSON.parse(new TextDecoder().decode(decrypted));
    }

    cleanup() {
        this.key = null;
        this.accountId = null;
        this.salt = null;
    }
}

// ===== DATABASE MODULE =====
class Database {
    constructor() {
        this.accountsDB = null;
        this.userDB = null;
        this.crypto = new SecureCrypto();
        this.isSyncing = false;
        this.pendingSync = false;
    }

    async init() {
        this.accountsDB = new PouchDB('guardfin-accounts-v3');
    }

    async createAccount(name, passphrase) {
        const id = this.crypto.generateUUID();
        const salt = this.crypto.generateSalt();
        const verifier = await this.crypto.createVerifier(passphrase, salt);
        await this.accountsDB.put({ _id: id, name, salt: Array.from(salt), verifier, createdAt: new Date().toISOString() });
        return id;
    }

    async signIn(accountId, passphrase) {
        const account = await this.accountsDB.get(accountId);
        const salt = new Uint8Array(account.salt);
        if (!await this.crypto.verifyPassword(passphrase, salt, account.verifier)) {
            throw new Error('Invalid passphrase');
        }
        this.crypto.accountId = accountId;
        this.crypto.salt = salt;
        this.crypto.key = await this.crypto.deriveKey(passphrase, salt);
        this.userDB = new PouchDB(`guardfin-user-${accountId}`);
        return account;
    }

    async getAccounts() {
        const result = await this.accountsDB.allDocs({ include_docs: true });
        return result.rows.map(r => ({ id: r.doc._id, name: r.doc.name, createdAt: r.doc.createdAt }));
    }

    async save(type, data) {
        if (!this.userDB) throw new Error('Not signed in');
        const id = `${type}_${this.crypto.generateUUID()}`;
        const encrypted = await this.crypto.encrypt(data);
        await this.userDB.put({ _id: id, type, encryptedData: encrypted, createdAt: new Date().toISOString() });
        this.scheduleSync();
        return id;
    }

    async update(docId, data) {
        if (!this.userDB) throw new Error('Not signed in');
        const doc = await this.userDB.get(docId);
        const encrypted = await this.crypto.encrypt(data);
        await this.userDB.put({ ...doc, encryptedData: encrypted, updatedAt: new Date().toISOString() });
        this.scheduleSync();
    }

    async delete(docId) {
        if (!this.userDB) throw new Error('Not signed in');
        const doc = await this.userDB.get(docId);
        await this.userDB.remove(doc);
        this.scheduleSync();
    }

    async getAll() {
        if (!this.userDB) return [];
        const result = await this.userDB.allDocs({ include_docs: true });
        const decrypted = [];
        for (const row of result.rows) {
            if (row.doc.encryptedData) {
                try {
                    const data = await this.crypto.decrypt(row.doc.encryptedData);
                    decrypted.push({ _id: row.doc._id, type: row.doc.type, createdAt: row.doc.createdAt, ...data });
                } catch (e) { console.error('Decrypt error:', e); }
            }
        }
        return decrypted;
    }

    async getByType(type) {
        const all = await this.getAll();
        return all.filter(d => d.type === type);
    }

    scheduleSync() {
        if (this.pendingSync) return;
        this.pendingSync = true;
        setTimeout(() => this.syncToServer(), 2000);
    }

    async syncToServer() {
        if (this.isSyncing || !this.userDB) return;
        this.isSyncing = true;
        this.pendingSync = false;

        try {
            App.updateSyncStatus('syncing');
            const result = await this.userDB.allDocs({ include_docs: true });
            const data = {
                accountId: this.crypto.accountId,
                transactions: result.rows.filter(r => r.doc.type === 'transaction').map(r => r.doc),
                recurring_bills: result.rows.filter(r => r.doc.type === 'bill').map(r => r.doc),
                goals: result.rows.filter(r => r.doc.type === 'goal').map(r => r.doc),
                budgets: result.rows.filter(r => r.doc.type === 'budget').map(r => r.doc),
                reminders: result.rows.filter(r => r.doc.type === 'reminder').map(r => r.doc),
                settings: {}
            };

            const response = await fetch(`${API_URL}/api/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            App.updateSyncStatus(response.ok ? 'synced' : 'error');
        } catch (e) {
            console.error('Sync error:', e);
            App.updateSyncStatus('offline');
        } finally {
            this.isSyncing = false;
        }
    }

    async checkConnection() {
        try {
            const r = await fetch(`${API_URL}/api/health`);
            return r.ok;
        } catch { return false; }
    }

    signOut() {
        this.crypto.cleanup();
        this.userDB = null;
    }
}

// ===== TRANSACTION PARSER =====
class TransactionParser {
    constructor() {
        this.categories = {
            'Food & Dining': ['grocery', 'groceries', 'food', 'restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'breakfast', 'pizza', 'burger', 'takeout', 'uber eats', 'doordash', 'walmart', 'costco', 'target'],
            'Transportation': ['gas', 'fuel', 'uber', 'lyft', 'taxi', 'bus', 'metro', 'train', 'parking', 'car'],
            'Shopping': ['amazon', 'shopping', 'clothes', 'shoes', 'electronics', 'store', 'mall'],
            'Entertainment': ['movie', 'netflix', 'spotify', 'game', 'concert', 'streaming', 'hulu', 'disney'],
            'Bills & Utilities': ['electric', 'water', 'internet', 'phone', 'utility', 'rent', 'mortgage', 'insurance'],
            'Healthcare': ['doctor', 'hospital', 'pharmacy', 'medicine', 'medical', 'dentist', 'health'],
            'Income': ['salary', 'paycheck', 'income', 'bonus', 'refund', 'deposit', 'payment received']
        };
    }

    parse(text) {
        const transactions = [];
        const segments = text.split(/[,;]|\band\b|\bthen\b/).map(s => s.trim()).filter(s => s);
        
        for (const seg of segments) {
            const t = this.parseSegment(seg);
            if (t) transactions.push(t);
        }
        return transactions;
    }

    parseSegment(text) {
        const amountMatch = text.match(/\$?\s*(\d+(?:\.\d{2})?)/);
        if (!amountMatch) return null;
        
        const amount = parseFloat(amountMatch[1]);
        if (!amount || amount <= 0) return null;

        const isIncome = /received|got|earned|salary|income|bonus|refund|deposit/i.test(text);
        const type = isIncome ? 'income' : 'expense';
        
        let description = text.replace(/\$?\s*\d+(?:\.\d{2})?/g, '').trim();
        description = description.replace(/^(paid|spent|received|got|bought|for|at|from|to)\s+/i, '').trim();
        description = description.replace(/\s+(for|at|from)\s+/gi, ' ').trim();
        if (!description) description = type === 'income' ? 'Income' : 'Expense';

        const category = this.categorize(text, type);

        return { amount, description: this.capitalize(description), category, type, timestamp: new Date().toISOString() };
    }

    categorize(text, type) {
        const lower = text.toLowerCase();
        for (const [cat, keywords] of Object.entries(this.categories)) {
            if (type === 'income' && cat !== 'Income') continue;
            if (keywords.some(k => lower.includes(k))) return cat;
        }
        return type === 'income' ? 'Income' : 'Other';
    }

    capitalize(str) {
        return str.replace(/\b\w/g, l => l.toUpperCase());
    }
}

// ===== AI AGENT =====
class AIAgent {
    constructor(db) {
        this.db = db;
    }

    async chat(message) {
        const context = await this.getContext();
        
        try {
            const response = await fetch(`${API_URL}/api/agent/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, financialContext: context })
            });

            if (!response.ok) throw new Error('AI unavailable');
            return await response.json();
        } catch (e) {
            return { intent: 'ANSWER', message: 'AI service is currently unavailable. Please ensure the server is running.', requiresConfirmation: false };
        }
    }

    async executeAction(result) {
        const { intent, action } = result;
        
        switch (intent) {
            case 'ADD_TRANSACTION':
                await this.db.save('transaction', {
                    amount: action.amount,
                    description: action.description,
                    category: action.category,
                    type: action.type,
                    timestamp: new Date().toISOString()
                });
                return { success: true, message: `Added ${action.type}: $${action.amount} for ${action.description}` };

            case 'SET_BUDGET':
                const budgets = await this.db.getByType('budget');
                const existing = budgets.find(b => b.category === action.category);
                if (existing) {
                    await this.db.update(existing._id, { ...existing, amount: action.amount });
                } else {
                    await this.db.save('budget', { category: action.category, amount: action.amount, period: action.period || 'monthly' });
                }
                return { success: true, message: `Set ${action.category} budget to $${action.amount}/month` };

            case 'CREATE_GOAL':
                await this.db.save('goal', {
                    name: action.name,
                    target: action.target,
                    current: 0,
                    deadline: action.deadline,
                    timestamp: new Date().toISOString()
                });
                return { success: true, message: `Created goal: ${action.name} - $${action.target}` };

            case 'ADD_REMINDER':
                await this.db.save('reminder', {
                    title: action.title,
                    amount: action.amount,
                    dueDay: action.dueDay,
                    recurring: action.recurring,
                    timestamp: new Date().toISOString()
                });
                return { success: true, message: `Added reminder: ${action.title} on day ${action.dueDay}` };

            default:
                return { success: false, message: 'Unknown action' };
        }
    }

    async getInsights() {
        const context = await this.getContext();
        
        try {
            const response = await fetch(`${API_URL}/api/agent/insights`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ financialData: context })
            });

            if (!response.ok) return { insights: [] };
            return await response.json();
        } catch {
            return { insights: this.generateLocalInsights(context) };
        }
    }

    async getPredictions() {
        const context = await this.getContext();
        
        try {
            const response = await fetch(`${API_URL}/api/agent/predict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ financialData: context })
            });

            if (!response.ok) return null;
            const data = await response.json();
            return data.predictions;
        } catch {
            return this.generateLocalPredictions(context);
        }
    }

    async getContext() {
        const transactions = await this.db.getByType('transaction');
        const budgets = await this.db.getByType('budget');
        const goals = await this.db.getByType('goal');
        
        const now = new Date();
        const thisMonth = transactions.filter(t => {
            const d = new Date(t.timestamp);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const expenses = thisMonth.filter(t => t.type === 'expense');
        const income = thisMonth.filter(t => t.type === 'income');

        const categoryTotals = {};
        expenses.forEach(t => {
            categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
        });

        return {
            monthlyExpenses: expenses.reduce((s, t) => s + t.amount, 0),
            monthlyIncome: income.reduce((s, t) => s + t.amount, 0),
            budgetCount: budgets.length,
            goalCount: goals.length,
            transactionCount: transactions.length,
            topCategories: Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 5),
            categoryTotals,
            budgets: budgets.map(b => ({ category: b.category, limit: b.amount, spent: categoryTotals[b.category] || 0 })),
            goals: goals.map(g => ({ name: g.name, progress: (g.current / g.target) * 100 }))
        };
    }

    generateLocalInsights(ctx) {
        const insights = [];
        
        if (ctx.monthlyExpenses > ctx.monthlyIncome && ctx.monthlyIncome > 0) {
            insights.push({
                type: 'warning',
                title: 'Spending exceeds income',
                message: `You've spent $${ctx.monthlyExpenses.toFixed(0)} but earned $${ctx.monthlyIncome.toFixed(0)} this month.`,
                priority: 5
            });
        }

        ctx.budgets.forEach(b => {
            const pct = (b.spent / b.limit) * 100;
            if (pct >= 100) {
                insights.push({
                    type: 'danger',
                    title: `${b.category} budget exceeded`,
                    message: `You've spent $${b.spent.toFixed(0)} of your $${b.limit} budget (${pct.toFixed(0)}%)`,
                    priority: 4
                });
            } else if (pct >= 80) {
                insights.push({
                    type: 'warning',
                    title: `${b.category} budget at ${pct.toFixed(0)}%`,
                    message: `$${(b.limit - b.spent).toFixed(0)} remaining in your ${b.category} budget`,
                    priority: 3
                });
            }
        });

        if (ctx.topCategories.length > 0) {
            const [topCat, topAmt] = ctx.topCategories[0];
            const pct = (topAmt / ctx.monthlyExpenses) * 100;
            if (pct > 40) {
                insights.push({
                    type: 'tip',
                    title: `${topCat} is your top expense`,
                    message: `${pct.toFixed(0)}% of your spending goes to ${topCat}. Consider if there are optimization opportunities.`,
                    priority: 2
                });
            }
        }

        return insights;
    }

    generateLocalPredictions(ctx) {
        const dayOfMonth = new Date().getDate();
        const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
        const dailyAvg = ctx.monthlyExpenses / dayOfMonth;
        const predicted = dailyAvg * daysInMonth;

        return {
            predictedTotal: predicted,
            daysRemaining: daysInMonth - dayOfMonth,
            dailyAverage: dailyAvg,
            confidence: Math.min(0.9, dayOfMonth / 15)
        };
    }
}

// ===== CHARTS =====
class Charts {
    constructor() {
        this.spending = null;
        this.category = null;
        this.budget = null;
    }

    init() {
        const isDark = document.body.dataset.theme === 'dark';
        Chart.defaults.color = isDark ? '#6b6b6b' : '#a3a3a3';
        Chart.defaults.borderColor = isDark ? '#2a2a2a' : '#e5e5e5';
    }

    updateSpending(transactions) {
        const ctx = document.getElementById('spendingChart');
        if (!ctx) return;

        const isDark = document.body.dataset.theme === 'dark';
        const months = [];
        const expenses = [];
        const income = [];

        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const month = d.toLocaleString('default', { month: 'short' });
            months.push(month);

            const monthTrans = transactions.filter(t => {
                const td = new Date(t.timestamp);
                return td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
            });

            expenses.push(monthTrans.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0));
            income.push(monthTrans.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0));
        }

        if (this.spending) this.spending.destroy();

        this.spending = new Chart(ctx, {
            type: 'line',
            data: {
                labels: months,
                datasets: [
                    { 
                        label: 'Expenses', 
                        data: expenses, 
                        borderColor: isDark ? '#ffffff' : '#000000', 
                        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', 
                        fill: true, 
                        tension: 0.4,
                        borderWidth: 2
                    },
                    { 
                        label: 'Income', 
                        data: income, 
                        borderColor: '#00d4aa', 
                        backgroundColor: 'rgba(0, 212, 170, 0.05)', 
                        fill: true, 
                        tension: 0.4,
                        borderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { 
                        position: 'bottom',
                        labels: { boxWidth: 12, padding: 20 }
                    } 
                },
                scales: { 
                    y: { 
                        beginAtZero: true,
                        grid: { color: isDark ? '#222' : '#eee' }
                    },
                    x: {
                        grid: { display: false }
                    }
                }
            }
        });
    }

    updateCategory(transactions) {
        const ctx = document.getElementById('categoryChart');
        if (!ctx) return;

        const isDark = document.body.dataset.theme === 'dark';
        const now = new Date();
        const thisMonth = transactions.filter(t => {
            const d = new Date(t.timestamp);
            return t.type === 'expense' && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const totals = {};
        thisMonth.forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });

        const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6);
        // Grayscale palette with accent
        const colors = isDark 
            ? ['#ffffff', '#cccccc', '#999999', '#666666', '#444444', '#00d4aa']
            : ['#000000', '#333333', '#666666', '#999999', '#cccccc', '#00a884'];

        if (this.category) this.category.destroy();

        this.category = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map(s => s[0]),
                datasets: [{ 
                    data: sorted.map(s => s[1]), 
                    backgroundColor: colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: { 
                    legend: { 
                        position: 'right',
                        labels: { boxWidth: 12, padding: 15 }
                    } 
                }
            }
        });
    }

    updateBudget(budgets, transactions) {
        const ctx = document.getElementById('budgetChart');
        if (!ctx) return;

        const isDark = document.body.dataset.theme === 'dark';
        const now = new Date();
        const thisMonth = transactions.filter(t => {
            const d = new Date(t.timestamp);
            return t.type === 'expense' && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const spent = {};
        thisMonth.forEach(t => { spent[t.category] = (spent[t.category] || 0) + t.amount; });

        const labels = budgets.map(b => b.category);
        const limits = budgets.map(b => b.amount);
        const actual = budgets.map(b => spent[b.category] || 0);

        if (this.budget) this.budget.destroy();

        this.budget = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { 
                        label: 'Budget', 
                        data: limits, 
                        backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', 
                        borderColor: isDark ? '#444' : '#ccc', 
                        borderWidth: 1,
                        borderRadius: 4
                    },
                    { 
                        label: 'Spent', 
                        data: actual, 
                        backgroundColor: actual.map((a, i) => a > limits[i] ? '#ff4d4d' : '#00d4aa'),
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { 
                        position: 'bottom',
                        labels: { boxWidth: 12, padding: 20 }
                    } 
                },
                scales: { 
                    y: { 
                        beginAtZero: true,
                        grid: { color: isDark ? '#222' : '#eee' }
                    },
                    x: {
                        grid: { display: false }
                    }
                }
            }
        });
    }
}

// ===== MAIN APPLICATION =====
const App = {
    db: null,
    parser: null,
    agent: null,
    charts: null,
    currentTab: 'dashboard',
    pendingAction: null,

    async init() {
        try {
            this.showLoading('Initializing secure database...');
            
            this.db = new Database();
            await this.db.init();
            
            this.parser = new TransactionParser();
            this.agent = new AIAgent(this.db);
            this.charts = new Charts();
            
            this.loadTheme();
            this.bindEvents();
            this.populateCategories();
            
            const connected = await this.db.checkConnection();
            this.updateSyncStatus(connected ? 'connected' : 'offline');
            
            this.hideLoading();
        } catch (err) {
            console.error('Init error:', err);
            this.hideLoading();
            alert('Failed to initialize: ' + err.message);
        }
    },

    // ===== UI HELPERS =====
    showLoading(text = 'Loading...') {
        document.getElementById('loadingText').textContent = text;
        document.getElementById('loadingOverlay').classList.remove('hidden');
    },

    hideLoading() {
        document.getElementById('loadingOverlay').classList.add('hidden');
    },

    updateSyncStatus(status) {
        const el = document.getElementById('syncStatus');
        const states = {
            connected: { dot: 'dot-green', text: 'Connected' },
            syncing: { dot: 'dot-gray pulse', text: 'Syncing...' },
            synced: { dot: 'dot-green', text: 'Synced' },
            offline: { dot: 'dot-gray', text: 'Offline' },
            error: { dot: 'dot-red', text: 'Error' }
        };
        const s = states[status] || states.offline;
        el.innerHTML = `<span class="dot ${s.dot}"></span><span class="hide-mobile">${s.text}</span>`;
    },

    showTab(tab) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('[data-tab]').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('[data-mobile-tab]').forEach(el => el.style.color = 'var(--text-3)');

        const tabEl = document.getElementById(`${tab}Tab`);
        if (tabEl) tabEl.classList.remove('hidden');
        document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
        document.querySelector(`[data-mobile-tab="${tab}"]`)?.style.setProperty('color', 'var(--text-0)');

        this.currentTab = tab;
        this.refreshTab(tab);
    },

    async refreshTab(tab) {
        switch (tab) {
            case 'dashboard': await this.refreshDashboard(); break;
            case 'transactions': await this.refreshTransactions(); break;
            case 'budgets': await this.refreshBudgets(); break;
            case 'goals': await this.refreshGoals(); break;
            case 'insights': await this.refreshInsights(); break;
        }
    },

    showModal(content) {
        document.getElementById('modalContent').innerHTML = content;
        document.getElementById('modalOverlay').classList.remove('hidden');
    },

    hideModal() {
        document.getElementById('modalOverlay').classList.add('hidden');
    },

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 fade-in`;
        toast.style.background = type === 'success' ? 'var(--accent)' : type === 'error' ? 'var(--danger)' : 'var(--bg-4)';
        toast.style.color = type === 'success' ? '#000' : 'var(--text-0)';
        toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check' : type === 'error' ? 'times' : 'info'}-circle mr-2"></i>${message}`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    },

    // ===== THEME =====
    loadTheme() {
        const theme = localStorage.getItem('guardfin-theme') || 'light';
        document.body.dataset.theme = theme;
        this.updateThemeIcon();
    },

    toggleTheme() {
        const current = document.body.dataset.theme;
        const next = current === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        localStorage.setItem('guardfin-theme', next);
        this.updateThemeIcon();
        this.charts.init();
    },

    updateThemeIcon() {
        const icon = document.querySelector('#themeToggle i');
        icon.className = document.body.dataset.theme === 'dark' ? 'fas fa-sun text-sm' : 'fas fa-moon text-sm';
        this.charts?.init();
    },

    // ===== AUTH =====
    showScreen(screen) {
        ['welcomeScreen', 'accountSelectScreen', 'loginScreen', 'createScreen'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const target = document.getElementById(screen);
        if (target) target.classList.remove('hidden');
    },

    async loadAccounts() {
        const accounts = await this.db.getAccounts();
        const list = document.getElementById('accountList');
        
        if (accounts.length === 0) {
            list.innerHTML = '<p class="text-center py-4" style="color: var(--text-muted)">No accounts found</p>';
            return;
        }

        list.innerHTML = accounts.map(a => `
            <button onclick="App.selectAccount('${a.id}', '${a.name}')" class="w-full p-4 rounded-lg text-left card card-hover transition-all">
                <div class="font-medium text-[var(--text-1)]">${a.name}</div>
                <div class="text-xs text-[var(--text-3)] mt-1">Created ${new Date(a.createdAt).toLocaleDateString()}</div>
            </button>
        `).join('');
    },

    selectAccount(id, name) {
        document.getElementById('loginAccountName').textContent = name;
        document.getElementById('loginBtn').dataset.accountId = id;
        this.showScreen('loginScreen');
    },

    async login() {
        const btn = document.getElementById('loginBtn');
        const passphrase = document.getElementById('loginPassphrase').value;
        const accountId = btn.dataset.accountId;

        if (!passphrase) {
            document.getElementById('loginError').textContent = 'Please enter your passphrase';
            document.getElementById('loginError').classList.remove('hidden');
            return;
        }

        btn.disabled = true;
        document.getElementById('loginSpinner').classList.remove('hidden');
        document.getElementById('loginBtnText').classList.add('hidden');

        try {
            const account = await this.db.signIn(accountId, passphrase);
            this.onSignIn(account);
        } catch (e) {
            document.getElementById('loginError').textContent = 'Invalid passphrase';
            document.getElementById('loginError').classList.remove('hidden');
        } finally {
            btn.disabled = false;
            document.getElementById('loginSpinner').classList.add('hidden');
            document.getElementById('loginBtnText').classList.remove('hidden');
        }
    },

    async createAccount() {
        const name = document.getElementById('createName').value.trim();
        const passphrase = document.getElementById('createPassphrase').value;
        const confirm = document.getElementById('confirmPassphrase').value;

        if (!name || !passphrase || passphrase !== confirm) return;

        const btn = document.getElementById('createBtn');
        btn.disabled = true;
        document.getElementById('createSpinner').classList.remove('hidden');
        document.getElementById('createBtnText').classList.add('hidden');

        try {
            const id = await this.db.createAccount(name, passphrase);
            const account = await this.db.signIn(id, passphrase);
            this.onSignIn(account);
            this.showToast('Account created successfully!', 'success');
        } catch (e) {
            this.showToast('Failed to create account', 'error');
        } finally {
            btn.disabled = false;
            document.getElementById('createSpinner').classList.add('hidden');
            document.getElementById('createBtnText').classList.remove('hidden');
        }
    },

    onSignIn(account) {
        document.getElementById('authSection').classList.add('hidden');
        document.getElementById('appContent').classList.remove('hidden');
        document.getElementById('chatToggle').classList.remove('hidden');
        document.getElementById('signOutBtn').classList.remove('hidden');

        this.charts.init();
        this.showTab('dashboard');
        this.initChat();
    },

    signOut() {
        this.db.signOut();
        document.getElementById('authSection').classList.remove('hidden');
        document.getElementById('appContent').classList.add('hidden');
        document.getElementById('chatToggle').classList.add('hidden');
        document.getElementById('signOutBtn').classList.add('hidden');
        document.getElementById('loginPassphrase').value = '';
        this.showScreen('onboardingScreen');
    },

    validateCreateForm() {
        const name = document.getElementById('createName').value.trim();
        const pass = document.getElementById('createPassphrase').value;
        const confirm = document.getElementById('confirmPassphrase').value;

        const strength = this.getPasswordStrength(pass);
        document.getElementById('strengthText').textContent = strength.label;
        document.getElementById('strengthText').style.color = strength.color;
        document.getElementById('strengthBar').style.width = strength.width + '%';
        document.getElementById('strengthBar').style.background = strength.color;

        const valid = name.length >= 2 && pass.length >= 12 && pass === confirm && strength.score >= 3;
        document.getElementById('createBtn').disabled = !valid;
    },

    getPasswordStrength(pass) {
        let score = 0;
        if (pass.length >= 12) score++;
        if (pass.length >= 16) score++;
        if (/[a-z]/.test(pass)) score++;
        if (/[A-Z]/.test(pass)) score++;
        if (/\d/.test(pass)) score++;
        if (/[^A-Za-z0-9]/.test(pass)) score++;

        if (score <= 2) return { score, label: 'Weak', color: 'var(--danger)', width: 25 };
        if (score <= 4) return { score, label: 'Medium', color: 'var(--warning)', width: 60 };
        return { score, label: 'Strong', color: 'var(--success)', width: 100 };
    },

    // ===== CATEGORIES =====
    getCategories() {
        return ['Food & Dining', 'Transportation', 'Shopping', 'Entertainment', 'Bills & Utilities', 'Healthcare', 'Education', 'Travel', 'Income', 'Other'];
    },

    populateCategories() {
        const cats = this.getCategories().filter(c => c !== 'Income');
        const selects = ['manualCategory', 'filterCategory', 'budgetCategory'];
        
        selects.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const firstOption = el.querySelector('option');
            el.innerHTML = '';
            if (firstOption) el.appendChild(firstOption);
            cats.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                el.appendChild(opt);
            });
        });
    },

    // ===== DASHBOARD =====
    async refreshDashboard() {
        const transactions = await this.db.getByType('transaction');
        const budgets = await this.db.getByType('budget');
        const goals = await this.db.getByType('goal');

        const now = new Date();
        const thisMonth = transactions.filter(t => {
            const d = new Date(t.timestamp);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const expenses = thisMonth.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
        const income = thisMonth.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);

        // Update stats
        document.getElementById('statExpenses').textContent = expenses.toFixed(0);
        document.getElementById('statIncome').textContent = income.toFixed(0);
        document.getElementById('statNet').textContent = (income - expenses).toFixed(0);

        // Budget progress
        const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
        const categorySpent = {};
        thisMonth.filter(t => t.type === 'expense').forEach(t => {
            categorySpent[t.category] = (categorySpent[t.category] || 0) + t.amount;
        });
        const budgetUsed = budgets.reduce((s, b) => s + Math.min(categorySpent[b.category] || 0, b.amount), 0);
        const budgetPct = totalBudget > 0 ? (budgetUsed / totalBudget) * 100 : 0;
        document.getElementById('statBudgetPct').textContent = budgetPct.toFixed(0);
        document.getElementById('statBudgetRemain').textContent = Math.max(0, totalBudget - budgetUsed).toFixed(0);

        // Goals progress
        const goalsPct = goals.length > 0 ? goals.reduce((s, g) => s + Math.min(100, (g.current / g.target) * 100), 0) / goals.length : 0;
        document.getElementById('statGoalsPct').textContent = goalsPct.toFixed(0);
        document.getElementById('statGoalsCount').textContent = goals.length;

        // Charts
        this.charts.updateSpending(transactions);
        this.charts.updateCategory(transactions);

        // Recent transactions
        const recent = transactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
        document.getElementById('recentTransactions').innerHTML = recent.length ? recent.map(t => `
            <div class="flex justify-between items-center py-3 border-b border-[var(--border)] last:border-0">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-[var(--text-1)] truncate">${t.description}</div>
                    <div class="text-xs text-[var(--text-3)]">${t.category}</div>
                </div>
                <div class="text-sm font-semibold ml-4 ${t.type === 'income' ? 'text-[var(--accent)]' : 'text-[var(--text-1)]'}">
                    ${t.type === 'income' ? '+' : '-'}$${t.amount.toFixed(2)}
                </div>
            </div>
        `).join('') : '<p class="text-sm text-[var(--text-3)]">No transactions yet</p>';

        // Dashboard insights
        const ctx = await this.agent.getContext();
        const insights = this.agent.generateLocalInsights(ctx);
        document.getElementById('dashboardInsights').innerHTML = insights.slice(0, 3).map(i => `
            <div class="p-3 rounded-lg bg-[var(--bg-3)] border-l-2 ${i.type === 'danger' ? 'border-[var(--danger)]' : i.type === 'warning' ? 'border-[var(--warning)]' : 'border-[var(--accent)]'}">
                <div class="font-medium text-sm text-[var(--text-1)]">${i.title}</div>
                <div class="text-xs mt-1 text-[var(--text-2)]">${i.message}</div>
            </div>
        `).join('') || '<p class="text-sm text-[var(--text-3)]">Add transactions to see insights</p>';
    },

    // ===== TRANSACTIONS =====
    async refreshTransactions() {
        let transactions = await this.db.getByType('transaction');

        // Apply filters
        const typeFilter = document.getElementById('filterType').value;
        const catFilter = document.getElementById('filterCategory').value;
        const periodFilter = document.getElementById('filterPeriod').value;
        const search = document.getElementById('searchTransactions').value.toLowerCase();

        if (typeFilter !== 'all') transactions = transactions.filter(t => t.type === typeFilter);
        if (catFilter !== 'all') transactions = transactions.filter(t => t.category === catFilter);
        if (search) transactions = transactions.filter(t => t.description.toLowerCase().includes(search) || t.category.toLowerCase().includes(search));

        const now = new Date();
        if (periodFilter === 'today') {
            transactions = transactions.filter(t => new Date(t.timestamp).toDateString() === now.toDateString());
        } else if (periodFilter === 'week') {
            const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
            transactions = transactions.filter(t => new Date(t.timestamp) >= weekAgo);
        } else if (periodFilter === 'month') {
            transactions = transactions.filter(t => {
                const d = new Date(t.timestamp);
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            });
        } else if (periodFilter === 'year') {
            transactions = transactions.filter(t => new Date(t.timestamp).getFullYear() === now.getFullYear());
        }

        transactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Render table
        const tbody = document.getElementById('transactionsTable');
        tbody.innerHTML = transactions.length ? transactions.map(t => `
            <div class="table-row">
                <div class="text-sm text-[var(--text-3)] mono">${new Date(t.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                <div class="text-sm text-[var(--text-1)] truncate pr-4">${t.description}</div>
                <div><span class="tag">${t.category}</span></div>
                <div class="text-sm font-medium text-right ${t.type === 'income' ? 'text-[var(--accent)]' : 'text-[var(--text-1)]'}">
                    ${t.type === 'income' ? '+' : '−'}$${t.amount.toFixed(2)}
                </div>
                <div class="flex justify-end gap-2">
                    <button onclick="App.editTransaction('${t._id}')" class="btn btn-ghost p-2 text-xs">
                        <i class="fas fa-pen"></i>
                    </button>
                    <button onclick="App.deleteTransaction('${t._id}')" class="btn btn-ghost p-2 text-xs text-[var(--danger)]">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('') : '<div class="text-center py-12 text-[var(--text-3)]">No transactions found</div>';
    },

    async addTransaction(data) {
        await this.db.save('transaction', data);
        this.showToast('Transaction added!', 'success');
        if (this.currentTab === 'transactions') await this.refreshTransactions();
        if (this.currentTab === 'dashboard') await this.refreshDashboard();
    },

    async editTransaction(id) {
        const all = await this.db.getAll();
        const t = all.find(d => d._id === id);
        if (!t) return;

        this.showModal(`
            <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary)">Edit Transaction</h3>
            <div class="space-y-3">
                <input type="text" id="editDesc" class="input-field" value="${t.description}">
                <input type="number" id="editAmount" class="input-field" value="${t.amount}" step="0.01">
                <select id="editCategory" class="input-field">
                    ${this.getCategories().map(c => `<option value="${c}" ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
                <select id="editType" class="input-field">
                    <option value="expense" ${t.type === 'expense' ? 'selected' : ''}>Expense</option>
                    <option value="income" ${t.type === 'income' ? 'selected' : ''}>Income</option>
                </select>
                <div class="flex gap-2">
                    <button onclick="App.saveEditTransaction('${id}')" class="btn-primary flex-1">Save</button>
                    <button onclick="App.hideModal()" class="btn-secondary flex-1">Cancel</button>
                </div>
            </div>
        `);
    },

    async saveEditTransaction(id) {
        const all = await this.db.getAll();
        const t = all.find(d => d._id === id);
        
        await this.db.update(id, {
            ...t,
            description: document.getElementById('editDesc').value,
            amount: parseFloat(document.getElementById('editAmount').value),
            category: document.getElementById('editCategory').value,
            type: document.getElementById('editType').value
        });

        this.hideModal();
        this.showToast('Transaction updated!', 'success');
        await this.refreshTransactions();
    },

    async deleteTransaction(id) {
        if (!confirm('Delete this transaction?')) return;
        await this.db.delete(id);
        this.showToast('Transaction deleted', 'success');
        await this.refreshTransactions();
    },

    parseNlpInput() {
        const text = document.getElementById('nlpText').value.trim();
        if (!text) return;

        const transactions = this.parser.parse(text);
        if (transactions.length === 0) {
            this.showToast('Could not parse transactions. Try: "$50 groceries at Walmart"', 'error');
            return;
        }

        this.showPreview(transactions);
    },

    showPreview(transactions) {
        const list = document.getElementById('previewList');
        list.innerHTML = transactions.map((t, i) => `
            <div class="flex justify-between items-center p-2 rounded" style="background: var(--bg-secondary)">
                <div>
                    <span class="font-medium">${t.description}</span>
                    <span class="text-sm ml-2" style="color: var(--text-muted)">${t.category}</span>
                </div>
                <span class="font-semibold" style="color: ${t.type === 'income' ? 'var(--success)' : 'var(--danger)'}">
                    ${t.type === 'income' ? '+' : '-'}$${t.amount.toFixed(2)}
                </span>
            </div>
        `).join('');

        document.getElementById('transactionPreview').classList.remove('hidden');
        document.getElementById('transactionPreview').dataset.transactions = JSON.stringify(transactions);
    },

    async confirmPreview() {
        const transactions = JSON.parse(document.getElementById('transactionPreview').dataset.transactions || '[]');
        for (const t of transactions) {
            await this.db.save('transaction', t);
        }
        document.getElementById('transactionPreview').classList.add('hidden');
        document.getElementById('nlpText').value = '';
        this.showToast(`Added ${transactions.length} transaction(s)!`, 'success');
        await this.refreshTransactions();
    },

    addManualTransaction() {
        const desc = document.getElementById('manualDesc').value.trim();
        const amount = parseFloat(document.getElementById('manualAmount').value);
        const category = document.getElementById('manualCategory').value;
        const type = document.getElementById('manualType').value;
        const date = document.getElementById('manualDate').value;

        if (!desc || !amount || !category) {
            this.showToast('Please fill all fields', 'error');
            return;
        }

        this.addTransaction({
            description: desc,
            amount,
            category,
            type,
            timestamp: date ? new Date(date).toISOString() : new Date().toISOString()
        });

        document.getElementById('manualDesc').value = '';
        document.getElementById('manualAmount').value = '';
        document.getElementById('manualCategory').value = '';
        document.getElementById('manualDate').value = '';
    },

    exportCsv() {
        this.db.getByType('transaction').then(transactions => {
            const csv = [
                ['Date', 'Description', 'Category', 'Type', 'Amount'].join(','),
                ...transactions.map(t => [
                    new Date(t.timestamp).toLocaleDateString(),
                    `"${t.description}"`,
                    t.category,
                    t.type,
                    t.amount.toFixed(2)
                ].join(','))
            ].join('\n');

            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `guardfin-transactions-${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    },

    // ===== BUDGETS =====
    async refreshBudgets() {
        const budgets = await this.db.getByType('budget');
        const transactions = await this.db.getByType('transaction');

        const now = new Date();
        const thisMonth = transactions.filter(t => {
            const d = new Date(t.timestamp);
            return t.type === 'expense' && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        const spent = {};
        thisMonth.forEach(t => { spent[t.category] = (spent[t.category] || 0) + t.amount; });

        const list = document.getElementById('budgetsList');
        list.innerHTML = budgets.length ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">${budgets.map(b => {
            const s = spent[b.category] || 0;
            const pct = Math.min(100, (s / b.amount) * 100);
            const progressClass = pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'accent';

            return `
                <div class="card p-5">
                    <div class="flex justify-between items-start mb-4">
                        <div>
                            <h4 class="font-medium text-[var(--text-1)]">${b.category}</h4>
                            <p class="text-xs text-[var(--text-3)] mt-1">${pct >= 100 ? 'Budget exceeded' : `$${(b.amount - s).toFixed(0)} remaining`}</p>
                        </div>
                        <button onclick="App.deleteBudget('${b._id}')" class="btn btn-ghost p-1 text-[var(--text-4)]">
                            <i class="fas fa-times text-xs"></i>
                        </button>
                    </div>
                    <div class="flex items-end justify-between mb-2">
                        <span class="stat-value text-2xl">$${s.toFixed(0)}</span>
                        <span class="text-sm text-[var(--text-3)]">/ $${b.amount}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill ${progressClass}" style="width: ${pct}%"></div>
                    </div>
                </div>
            `;
        }).join('')}</div>` : '<p class="text-center py-12 text-[var(--text-3)]">No budgets set yet</p>';

        this.charts.updateBudget(budgets, transactions);
    },

    async addBudget() {
        const category = document.getElementById('budgetCategory').value;
        const amount = parseFloat(document.getElementById('budgetAmount').value);

        if (!category || !amount) {
            this.showToast('Please select category and amount', 'error');
            return;
        }

        const budgets = await this.db.getByType('budget');
        const existing = budgets.find(b => b.category === category);

        if (existing) {
            await this.db.update(existing._id, { ...existing, amount });
        } else {
            await this.db.save('budget', { category, amount, period: 'monthly' });
        }

        document.getElementById('budgetCategory').value = '';
        document.getElementById('budgetAmount').value = '';
        this.showToast('Budget saved!', 'success');
        await this.refreshBudgets();
    },

    async deleteBudget(id) {
        if (!confirm('Delete this budget?')) return;
        await this.db.delete(id);
        this.showToast('Budget deleted', 'success');
        await this.refreshBudgets();
    },

    // ===== GOALS =====
    async refreshGoals() {
        const goals = await this.db.getByType('goal');

        const list = document.getElementById('goalsList');
        list.innerHTML = goals.length ? goals.map(g => {
            const pct = Math.min(100, (g.current / g.target) * 100);
            const progressClass = pct >= 100 ? 'accent' : '';

            return `
                <div class="card p-5">
                    <div class="flex justify-between items-start mb-4">
                        <div>
                            <h4 class="font-medium text-[var(--text-1)]">${g.name}</h4>
                            ${g.deadline ? `<p class="text-xs text-[var(--text-3)] mt-1">Due ${new Date(g.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>` : ''}
                        </div>
                        <button onclick="App.deleteGoal('${g._id}')" class="btn btn-ghost p-1 text-[var(--text-4)]">
                            <i class="fas fa-times text-xs"></i>
                        </button>
                    </div>
                    <div class="text-center py-4">
                        <div class="stat-value text-4xl ${pct >= 100 ? 'text-[var(--accent)]' : 'text-[var(--text-0)]'}">${pct.toFixed(0)}%</div>
                        <div class="text-sm text-[var(--text-3)] mt-2">$${g.current.toLocaleString()} of $${g.target.toLocaleString()}</div>
                    </div>
                    <div class="progress-bar mb-4">
                        <div class="progress-fill ${progressClass}" style="width: ${pct}%"></div>
                    </div>
                    <button onclick="App.updateGoalProgress('${g._id}')" class="btn btn-secondary w-full text-sm">
                        <i class="fas fa-plus mr-2"></i>Add Progress
                    </button>
                </div>
            `;
        }).join('') : '<p class="col-span-3 text-center py-12 text-[var(--text-3)]">No goals yet</p>';
    },

    async addGoal() {
        const name = document.getElementById('goalName').value.trim();
        const target = parseFloat(document.getElementById('goalTarget').value);
        const current = parseFloat(document.getElementById('goalCurrent').value) || 0;
        const deadline = document.getElementById('goalDeadline').value;

        if (!name || !target) {
            this.showToast('Please enter goal name and target', 'error');
            return;
        }

        await this.db.save('goal', { name, target, current, deadline: deadline || null, timestamp: new Date().toISOString() });

        document.getElementById('goalName').value = '';
        document.getElementById('goalTarget').value = '';
        document.getElementById('goalCurrent').value = '0';
        document.getElementById('goalDeadline').value = '';

        this.showToast('Goal created!', 'success');
        await this.refreshGoals();
    },

    async updateGoalProgress(id) {
        const all = await this.db.getAll();
        const goal = all.find(d => d._id === id);
        if (!goal) return;

        this.showModal(`
            <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary)">Update Progress: ${goal.name}</h3>
            <p class="text-sm mb-3" style="color: var(--text-secondary)">Current: $${goal.current} / $${goal.target}</p>
            <input type="number" id="goalProgressAmount" class="input-field mb-3" placeholder="Amount to add ($)">
            <div class="flex gap-2">
                <button onclick="App.saveGoalProgress('${id}')" class="btn-primary flex-1">Add</button>
                <button onclick="App.hideModal()" class="btn-secondary flex-1">Cancel</button>
            </div>
        `);
    },

    async saveGoalProgress(id) {
        const amount = parseFloat(document.getElementById('goalProgressAmount').value);
        if (!amount) return;

        const all = await this.db.getAll();
        const goal = all.find(d => d._id === id);
        
        await this.db.update(id, { ...goal, current: goal.current + amount });
        this.hideModal();
        this.showToast('Progress updated!', 'success');
        await this.refreshGoals();
    },

    async deleteGoal(id) {
        if (!confirm('Delete this goal?')) return;
        await this.db.delete(id);
        this.showToast('Goal deleted', 'success');
        await this.refreshGoals();
    },

    // ===== INSIGHTS =====
    async refreshInsights() {
        const { insights } = await this.agent.getInsights();
        const predictions = await this.agent.getPredictions();

        const list = document.getElementById('insightsList');
        list.innerHTML = insights.length ? insights.map(i => `
            <div class="p-3 rounded-lg bg-[var(--bg-3)] border-l-2 ${i.type === 'danger' ? 'border-[var(--danger)]' : i.type === 'warning' ? 'border-[var(--warning)]' : 'border-[var(--accent)]'}">
                <div class="font-medium text-sm text-[var(--text-1)]">${i.title}</div>
                <div class="text-xs mt-1 text-[var(--text-2)]">${i.message}</div>
            </div>
        `).join('') : '<p class="text-sm text-[var(--text-3)]">Add more transactions to generate insights</p>';

        const predEl = document.getElementById('predictionContent');
        if (predictions) {
            predEl.innerHTML = `
                <div class="text-center py-6">
                    <div class="stat-value text-4xl text-[var(--text-0)]">$${predictions.predictedTotal?.toFixed(0) || 0}</div>
                    <div class="text-sm text-[var(--text-3)] mt-2">Predicted month-end spending</div>
                </div>
                ${predictions.daysRemaining ? `<div class="text-center text-sm text-[var(--text-2)]">${predictions.daysRemaining} days remaining</div>` : ''}
                ${predictions.recommendation ? `<div class="mt-4 p-3 rounded-lg bg-[var(--bg-3)] text-sm text-[var(--text-2)]">${predictions.recommendation}</div>` : ''}
            `;
        } else {
            predEl.innerHTML = '<p class="text-sm text-[var(--text-3)] text-center py-6">Add more transactions for predictions</p>';
        }

        // Reminders
        const reminders = await this.db.getByType('reminder');
        document.getElementById('remindersList').innerHTML = reminders.length ? reminders.map(r => `
            <div class="flex justify-between items-center p-4 rounded-lg bg-[var(--bg-3)]">
                <div>
                    <div class="font-medium text-sm text-[var(--text-1)]">${r.title}</div>
                    <div class="text-xs text-[var(--text-3)]">Day ${r.dueDay} ${r.recurring ? '• Recurring' : ''}</div>
                </div>
                <div class="flex items-center gap-4">
                    ${r.amount ? `<span class="font-medium text-[var(--text-1)]">$${r.amount}</span>` : ''}
                    <button onclick="App.deleteReminder('${r._id}')" class="btn btn-ghost p-2 text-[var(--danger)]"><i class="fas fa-trash text-xs"></i></button>
                </div>
            </div>
        `).join('') : '<p class="text-sm text-[var(--text-3)] text-center py-6">No reminders set</p>';
    },

    showAddReminder() {
        this.showModal(`
            <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary)">Add Bill Reminder</h3>
            <div class="space-y-3">
                <input type="text" id="reminderTitle" class="input-field" placeholder="Bill name (e.g., Rent)">
                <input type="number" id="reminderAmount" class="input-field" placeholder="Amount ($) - optional">
                <input type="number" id="reminderDay" class="input-field" placeholder="Due day (1-31)" min="1" max="31">
                <label class="flex items-center gap-2">
                    <input type="checkbox" id="reminderRecurring" checked>
                    <span style="color: var(--text-secondary)">Recurring monthly</span>
                </label>
                <div class="flex gap-2">
                    <button onclick="App.saveReminder()" class="btn-primary flex-1">Save</button>
                    <button onclick="App.hideModal()" class="btn-secondary flex-1">Cancel</button>
                </div>
            </div>
        `);
    },

    async saveReminder() {
        const title = document.getElementById('reminderTitle').value.trim();
        const amount = parseFloat(document.getElementById('reminderAmount').value) || null;
        const dueDay = parseInt(document.getElementById('reminderDay').value);
        const recurring = document.getElementById('reminderRecurring').checked;

        if (!title || !dueDay) {
            this.showToast('Please enter title and due day', 'error');
            return;
        }

        await this.db.save('reminder', { title, amount, dueDay, recurring, timestamp: new Date().toISOString() });
        this.hideModal();
        this.showToast('Reminder added!', 'success');
        await this.refreshInsights();
    },

    async deleteReminder(id) {
        await this.db.delete(id);
        this.showToast('Reminder deleted', 'success');
        await this.refreshInsights();
    },

    // ===== CHAT =====
    initChat() {
        const messages = document.getElementById('chatMessages');
        messages.innerHTML = `
            <div class="chat-bubble chat-ai">
                <div class="font-medium mb-2">Hey! I can help you:</div>
                <div class="text-xs space-y-1 text-[var(--text-2)]">
                    <div>• "Add $50 for groceries"</div>
                    <div>• "Set food budget to $500"</div>
                    <div>• "Save $1000 for vacation"</div>
                    <div>• "How much did I spend?"</div>
                </div>
            </div>
        `;
    },

    async sendChat() {
        const input = document.getElementById('chatInput');
        const message = input.value.trim();
        if (!message) return;

        this.addChatMessage(message, 'user');
        input.value = '';

        const thinkingId = this.addChatMessage('<i class="fas fa-spinner fa-spin"></i> Thinking...', 'ai');

        const result = await this.agent.chat(message);
        document.getElementById(thinkingId).remove();

        if (result.requiresConfirmation && result.action) {
            this.pendingAction = result;
            this.addChatMessage(result.message, 'ai');
            this.addChatMessage(`
                <div class="action-card">
                    <p class="text-sm mb-2">Ready to execute:</p>
                    <p class="font-medium">${this.describeAction(result)}</p>
                    <div class="flex gap-2 mt-3">
                        <button onclick="App.confirmChatAction()" class="btn-success text-sm px-3 py-1">Confirm</button>
                        <button onclick="App.cancelChatAction()" class="btn-secondary text-sm px-3 py-1">Cancel</button>
                    </div>
                </div>
            `, 'ai', true);
        } else {
            this.addChatMessage(result.message, 'ai');
        }
    },

    describeAction(result) {
        const { intent, action } = result;
        switch (intent) {
            case 'ADD_TRANSACTION': return `Add ${action.type}: $${action.amount} - ${action.description} (${action.category})`;
            case 'SET_BUDGET': return `Set ${action.category} budget to $${action.amount}/month`;
            case 'CREATE_GOAL': return `Create goal: ${action.name} - $${action.target}`;
            case 'ADD_REMINDER': return `Add reminder: ${action.title} on day ${action.dueDay}`;
            default: return 'Unknown action';
        }
    },

    async confirmChatAction() {
        if (!this.pendingAction) return;
        
        const result = await this.agent.executeAction(this.pendingAction);
        this.addChatMessage(result.success ? `✅ ${result.message}` : `❌ ${result.message}`, 'ai');
        this.pendingAction = null;

        // Refresh current tab
        await this.refreshTab(this.currentTab);
    },

    cancelChatAction() {
        this.pendingAction = null;
        this.addChatMessage('Action cancelled.', 'ai');
    },

    addChatMessage(content, sender, isHtml = false) {
        const id = 'msg-' + Date.now();
        const messages = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.id = id;
        div.className = `chat-bubble ${sender === 'user' ? 'chat-user' : 'chat-ai'}`;
        if (isHtml) {
            div.innerHTML = content;
        } else {
            div.textContent = content;
        }
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return id;
    },

    toggleChat() {
        document.getElementById('chatWindow').classList.toggle('hidden');
    },

    // ===== KEYBOARD SHORTCUTS =====
    handleKeyboard(e) {
        // Don't trigger if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            if (e.key === 'Escape') e.target.blur();
            return;
        }

        switch (e.key) {
            case 'n': case 'N':
                if (!e.ctrlKey && !e.metaKey) {
                    document.getElementById('quickAddInput')?.focus();
                    e.preventDefault();
                }
                break;
            case '/':
                document.getElementById('searchTransactions')?.focus();
                e.preventDefault();
                break;
            case 't': case 'T':
                this.toggleTheme();
                break;
            case '?':
                this.showKeyboardHelp();
                break;
            case 'Escape':
                this.hideModal();
                document.getElementById('chatWindow').classList.add('hidden');
                break;
            case '1': this.showTab('dashboard'); break;
            case '2': this.showTab('transactions'); break;
            case '3': this.showTab('budgets'); break;
            case '4': this.showTab('goals'); break;
            case '5': this.showTab('insights'); break;
        }
    },

    showKeyboardHelp() {
        this.showModal(`
            <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary)">Keyboard Shortcuts</h3>
            <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span>New transaction</span><span class="kbd">N</span></div>
                <div class="flex justify-between"><span>Search</span><span class="kbd">/</span></div>
                <div class="flex justify-between"><span>Toggle theme</span><span class="kbd">T</span></div>
                <div class="flex justify-between"><span>Dashboard</span><span class="kbd">1</span></div>
                <div class="flex justify-between"><span>Transactions</span><span class="kbd">2</span></div>
                <div class="flex justify-between"><span>Budgets</span><span class="kbd">3</span></div>
                <div class="flex justify-between"><span>Goals</span><span class="kbd">4</span></div>
                <div class="flex justify-between"><span>Insights</span><span class="kbd">5</span></div>
                <div class="flex justify-between"><span>Close modal</span><span class="kbd">Esc</span></div>
            </div>
            <button onclick="App.hideModal()" class="btn-primary w-full mt-4">Got it</button>
        `);
    },

    showSecurityInfo() {
        this.showModal(`
            <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary)">
                <i class="fas fa-shield-halved mr-2" style="color: var(--success)"></i>
                Security & Privacy
            </h3>
            <div class="space-y-3 text-sm">
                <div class="flex items-start gap-3">
                    <i class="fas fa-check-circle mt-1" style="color: var(--success)"></i>
                    <div>
                        <strong style="color: var(--text-primary)">End-to-end encryption</strong>
                        <p style="color: var(--text-secondary)">Your data is encrypted with AES-256-GCM using your passphrase</p>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <i class="fas fa-check-circle mt-1" style="color: var(--success)"></i>
                    <div>
                        <strong style="color: var(--text-primary)">Local-first storage</strong>
                        <p style="color: var(--text-secondary)">All data stored locally in your browser's secure storage</p>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <i class="fas fa-check-circle mt-1" style="color: var(--success)"></i>
                    <div>
                        <strong style="color: var(--text-primary)">Zero-knowledge sync</strong>
                        <p style="color: var(--text-secondary)">Server only stores encrypted blobs it cannot read</p>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <i class="fas fa-check-circle mt-1" style="color: var(--success)"></i>
                    <div>
                        <strong style="color: var(--text-primary)">AI privacy</strong>
                        <p style="color: var(--text-secondary)">Only anonymized, aggregated data shared with AI</p>
                    </div>
                </div>
            </div>
            <button onclick="App.hideModal()" class="btn-primary w-full mt-4">Got it</button>
        `);
    },

    // ===== EVENT BINDING =====
    bindEvents() {
        // Theme
        document.getElementById('themeToggle')?.addEventListener('click', () => this.toggleTheme());

        // Auth
        document.getElementById('showLoginBtn')?.addEventListener('click', async () => {
            await this.loadAccounts();
            this.showScreen('accountSelectScreen');
        });
        document.getElementById('showCreateBtn')?.addEventListener('click', () => this.showScreen('createScreen'));
        document.getElementById('backToWelcome')?.addEventListener('click', () => this.showScreen('welcomeScreen'));
        document.getElementById('backToWelcome2')?.addEventListener('click', () => this.showScreen('welcomeScreen'));
        document.getElementById('backToAccounts')?.addEventListener('click', () => this.showScreen('accountSelectScreen'));
        document.getElementById('createFromList')?.addEventListener('click', () => this.showScreen('createScreen'));
        document.getElementById('loginBtn')?.addEventListener('click', () => this.login());
        document.getElementById('createBtn')?.addEventListener('click', () => this.createAccount());
        document.getElementById('signOutBtn')?.addEventListener('click', () => this.signOut());

        document.getElementById('createName')?.addEventListener('input', () => this.validateCreateForm());
        document.getElementById('createPassphrase')?.addEventListener('input', () => this.validateCreateForm());
        document.getElementById('confirmPassphrase')?.addEventListener('input', () => this.validateCreateForm());

        document.getElementById('loginPassphrase')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.login(); });

        // Navigation - Desktop
        document.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => this.showTab(btn.dataset.tab));
        });
        // Navigation - Mobile
        document.querySelectorAll('[data-mobile-tab]').forEach(btn => {
            btn.addEventListener('click', () => this.showTab(btn.dataset.mobileTab));
        });

        // Quick add
        document.getElementById('quickAddBtn')?.addEventListener('click', () => {
            const text = document.getElementById('quickAddInput').value.trim();
            if (!text) return;
            const transactions = this.parser.parse(text);
            if (transactions.length) {
                transactions.forEach(t => this.addTransaction(t));
                document.getElementById('quickAddInput').value = '';
            } else {
                this.showToast('Could not parse. Try: "$50 groceries"', 'error');
            }
        });
        document.getElementById('quickAddInput')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('quickAddBtn').click();
        });

        // Transactions
        document.getElementById('inputModeNlp')?.addEventListener('click', () => this.setInputMode('nlp'));
        document.getElementById('inputModeManual')?.addEventListener('click', () => this.setInputMode('manual'));
        document.getElementById('parseNlp')?.addEventListener('click', () => this.parseNlpInput());
        document.getElementById('confirmPreview')?.addEventListener('click', () => this.confirmPreview());
        document.getElementById('cancelPreview')?.addEventListener('click', () => document.getElementById('transactionPreview').classList.add('hidden'));
        document.getElementById('addManual')?.addEventListener('click', () => this.addManualTransaction());
        document.getElementById('exportCsv')?.addEventListener('click', () => this.exportCsv());

        document.getElementById('filterType')?.addEventListener('change', () => this.refreshTransactions());
        document.getElementById('filterCategory')?.addEventListener('change', () => this.refreshTransactions());
        document.getElementById('filterPeriod')?.addEventListener('change', () => this.refreshTransactions());
        document.getElementById('searchTransactions')?.addEventListener('input', () => this.refreshTransactions());

        // Budgets
        document.getElementById('addBudget')?.addEventListener('click', () => this.addBudget());

        // Goals
        document.getElementById('addGoal')?.addEventListener('click', () => this.addGoal());

        // Insights
        document.getElementById('refreshInsights')?.addEventListener('click', () => this.refreshInsights());
        document.getElementById('addReminderBtn')?.addEventListener('click', () => this.showAddReminder());

        // Chat
        document.getElementById('chatToggle')?.addEventListener('click', () => this.toggleChat());
        document.getElementById('closeChat')?.addEventListener('click', () => this.toggleChat());
        document.getElementById('sendChat')?.addEventListener('click', () => this.sendChat());
        document.getElementById('chatInput')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.sendChat(); });

        // Modal
        document.getElementById('modalOverlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'modalOverlay') this.hideModal();
        });

        // Keyboard
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Set initial date
        const dateEl = document.getElementById('manualDate');
        if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
    },

    setInputMode(mode) {
        document.querySelectorAll('.input-mode').forEach(b => b.classList.remove('active'));
        const btn = document.getElementById(`inputMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
        if (btn) btn.classList.add('active');
        
        document.getElementById('nlpInput').classList.toggle('hidden', mode !== 'nlp');
        document.getElementById('manualInput').classList.toggle('hidden', mode !== 'manual');
        document.getElementById('csvInput').classList.toggle('hidden', mode !== 'csv');
    },

    async parseCsvFile() {
        const file = document.getElementById('csvFile').files[0];
        if (!file) return;

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const transactions = [];
                for (const row of results.data) {
                    const amount = parseFloat(row.Amount || row.amount || row.AMOUNT || 0);
                    const desc = row.Description || row.description || row.DESCRIPTION || row.Memo || 'Imported';
                    if (amount) {
                        transactions.push({
                            amount: Math.abs(amount),
                            description: desc,
                            category: this.parser.categorize(desc, amount < 0 ? 'expense' : 'income'),
                            type: amount < 0 ? 'expense' : 'income',
                            timestamp: new Date(row.Date || row.date || Date.now()).toISOString()
                        });
                    }
                }
                if (transactions.length) {
                    this.showPreview(transactions);
                } else {
                    this.showToast('No valid transactions found in CSV', 'error');
                }
            },
            error: () => this.showToast('Error reading CSV file', 'error')
        });
    }
};

// Initialize app
document.addEventListener('DOMContentLoaded', () => App.init());
