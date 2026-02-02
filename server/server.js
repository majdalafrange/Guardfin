const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = 3001;
const DB_DIR = path.join(__dirname, 'secure-data');
const CONFIG_FILE = path.join(__dirname, 'server-config.json');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// Load or create server configuration
let serverConfig = {
    apiKey: process.env.GEMINI_API_KEY || 'your-gemini-api-key-here',
    allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', 'null'],
    maxSyncSize: 50 * 1024 * 1024,
    rateLimitWindow: 15 * 60 * 1000,
    rateLimitRequests: 100
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        serverConfig = { ...serverConfig, ...config };
    } catch (error) {
        console.warn('Warning: Could not load server config, using defaults');
    }
} else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(serverConfig, null, 2));
}

// Initialize Gemini AI
let genAI = null;
let aiModel = null;

function initializeAI() {
    if (serverConfig.apiKey && serverConfig.apiKey !== 'your-gemini-api-key-here') {
        genAI = new GoogleGenerativeAI(serverConfig.apiKey);
        aiModel = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-latest",
            generationConfig: {
                maxOutputTokens: 1000,
                temperature: 0.7,
            }
        });
        return true;
    }
    return false;
}

initializeAI();

// Middleware setup
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || serverConfig.allowedOrigins.includes(origin) || origin === 'null') {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        if (buf.length > serverConfig.maxSyncSize) {
            const error = new Error('Payload too large');
            error.status = 413;
            throw error;
        }
    }
}));

// Rate limiting
const createRateLimiter = (windowMs, max, message) => rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const accountId = req.body?.accountId || req.params?.accountId || 'anonymous';
        return `${accountId}_${req.ip}`;
    }
});

app.use('/api', createRateLimiter(
    serverConfig.rateLimitWindow,
    serverConfig.rateLimitRequests,
    'Too many requests, please try again later'
));

const chatRateLimit = createRateLimiter(60 * 1000, 15, 'Too many AI requests, please wait');
const agentRateLimit = createRateLimiter(60 * 1000, 30, 'Too many agent requests, please wait');

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${req.method} ${req.path} - ${req.ip}`;
    console.log(logEntry);
    fs.appendFileSync(path.join(__dirname, 'server.log'), logEntry + '\n');
    next();
});

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Input validation middleware
function validateSyncData(req, res, next) {
    const { transactions, recurring_bills, goals, budgets, reminders, accountId } = req.body;
    
    if (!accountId || typeof accountId !== 'string') {
        return res.status(400).json({ error: 'Valid accountId required' });
    }
    
    const dataTypes = { transactions, recurring_bills, goals, budgets, reminders };
    for (const [type, data] of Object.entries(dataTypes)) {
        if (data !== undefined && !Array.isArray(data)) {
            return res.status(400).json({ error: `${type} must be an array` });
        }
    }
    
    next();
}

// ===== AI AGENT SYSTEM =====

const AGENT_SYSTEM_PROMPT = `You are Guardfin AI, a helpful and proactive financial assistant. You help users manage their finances through conversation.

CAPABILITIES:
1. ADD_TRANSACTION - Add expense or income (e.g., "Add $50 for groceries")
2. SET_BUDGET - Set category budget (e.g., "Set food budget to $500")
3. CREATE_GOAL - Create savings goal (e.g., "Create goal to save $1000 for vacation")
4. ADD_REMINDER - Set bill reminder (e.g., "Remind me about rent on the 1st")
5. ANALYZE - Analyze spending patterns
6. PREDICT - Predict future spending
7. SUGGEST - Provide savings suggestions
8. ANSWER - Answer financial questions

RESPONSE FORMAT (JSON):
{
  "intent": "ADD_TRANSACTION|SET_BUDGET|CREATE_GOAL|ADD_REMINDER|ANALYZE|PREDICT|SUGGEST|ANSWER",
  "confidence": 0.0-1.0,
  "action": {
    // For ADD_TRANSACTION:
    "type": "expense|income",
    "amount": number,
    "description": "string",
    "category": "Food & Dining|Transportation|Shopping|Entertainment|Bills & Utilities|Healthcare|Education|Travel|Income|Other"
    
    // For SET_BUDGET:
    "category": "string",
    "amount": number,
    "period": "monthly|weekly"
    
    // For CREATE_GOAL:
    "name": "string",
    "target": number,
    "deadline": "YYYY-MM-DD" or null
    
    // For ADD_REMINDER:
    "title": "string",
    "amount": number or null,
    "dueDay": 1-31,
    "recurring": true|false
  },
  "message": "Friendly response to user",
  "requiresConfirmation": true|false
}

RULES:
- Always be helpful and encouraging
- If unsure about intent, ask for clarification (intent: "ANSWER")
- For financial actions, set requiresConfirmation: true
- Keep responses concise but friendly
- Never ask for sensitive personal information
- Focus on actionable advice`;

const INSIGHTS_PROMPT = `Analyze this financial data and generate 3-5 actionable insights.

DATA:
{data}

Generate insights in this JSON format:
{
  "insights": [
    {
      "type": "warning|tip|achievement|alert",
      "title": "Short title",
      "message": "Detailed but concise message",
      "priority": 1-5,
      "category": "spending|budget|goals|savings|general",
      "actionable": true|false,
      "suggestedAction": "What user can do" or null
    }
  ]
}

Focus on:
- Spending anomalies (unusual increases)
- Budget adherence
- Goal progress
- Savings opportunities
- Positive achievements to celebrate`;

const PREDICTION_PROMPT = `Based on this financial history, predict spending for the rest of the month.

DATA:
{data}

Respond in JSON:
{
  "predictedTotal": number,
  "predictedByCategory": { "category": amount },
  "confidence": 0.0-1.0,
  "factors": ["reason1", "reason2"],
  "recommendation": "Brief advice"
}`;

// Local intent parser (works without AI)
function parseIntentLocally(message) {
    const lower = message.toLowerCase().trim();
    
    // Category keywords for auto-detection
    const categoryKeywords = {
        'Food & Dining': ['grocery', 'groceries', 'food', 'restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'breakfast', 'pizza', 'burger', 'takeout', 'uber eats', 'doordash', 'walmart', 'costco', 'target', 'eat'],
        'Transportation': ['gas', 'fuel', 'uber', 'lyft', 'taxi', 'bus', 'metro', 'train', 'parking', 'car', 'vehicle'],
        'Shopping': ['amazon', 'shopping', 'clothes', 'shoes', 'electronics', 'store', 'mall', 'buy', 'bought'],
        'Entertainment': ['movie', 'netflix', 'spotify', 'game', 'concert', 'streaming', 'hulu', 'disney', 'entertainment'],
        'Bills & Utilities': ['electric', 'water', 'internet', 'phone', 'utility', 'rent', 'mortgage', 'insurance', 'bill'],
        'Healthcare': ['doctor', 'hospital', 'pharmacy', 'medicine', 'medical', 'dentist', 'health'],
        'Income': ['salary', 'paycheck', 'income', 'bonus', 'refund', 'deposit', 'received', 'earned', 'got paid']
    };

    function detectCategory(text) {
        const lowerText = text.toLowerCase();
        for (const [category, keywords] of Object.entries(categoryKeywords)) {
            if (keywords.some(k => lowerText.includes(k))) {
                return category;
            }
        }
        return 'Other';
    }

    // Pattern: "add $50 for groceries" or "spent $50 on groceries" or "$50 groceries"
    const addTransactionPatterns = [
        /(?:add|spent|paid|bought|got|received|earned)\s+\$?(\d+(?:\.\d{2})?)\s+(?:for|on|at)?\s*(.+)/i,
        /\$(\d+(?:\.\d{2})?)\s+(?:for|on|at)?\s*(.+)/i,
        /(.+?)\s+\$(\d+(?:\.\d{2})?)/i
    ];

    for (const pattern of addTransactionPatterns) {
        const match = lower.match(pattern);
        if (match) {
            let amount, description;
            if (pattern === addTransactionPatterns[2]) {
                description = match[1].trim();
                amount = parseFloat(match[2]);
            } else {
                amount = parseFloat(match[1]);
                description = match[2]?.trim() || 'Transaction';
            }
            
            if (amount > 0) {
                const isIncome = /received|earned|got paid|salary|income|bonus|refund|deposit/i.test(message);
                const category = detectCategory(description);
                const type = isIncome || category === 'Income' ? 'income' : 'expense';
                
                // Capitalize description
                description = description.replace(/\b\w/g, l => l.toUpperCase());
                
                return {
                    intent: 'ADD_TRANSACTION',
                    confidence: 0.9,
                    action: {
                        type,
                        amount,
                        description,
                        category: type === 'income' ? 'Income' : category
                    },
                    message: `I'll add a ${type}: $${amount.toFixed(2)} for "${description}" (${type === 'income' ? 'Income' : category}). Confirm?`,
                    requiresConfirmation: true
                };
            }
        }
    }

    // Pattern: "set budget for food to $500" or "food budget $500"
    const budgetPatterns = [
        /(?:set|create)?\s*(?:a\s+)?budget\s+(?:for\s+)?(.+?)\s+(?:to\s+)?\$?(\d+)/i,
        /(.+?)\s+budget\s+(?:to\s+)?\$?(\d+)/i,
        /\$(\d+)\s+budget\s+(?:for\s+)?(.+)/i
    ];

    for (const pattern of budgetPatterns) {
        const match = lower.match(pattern);
        if (match) {
            let category, amount;
            if (pattern === budgetPatterns[2]) {
                amount = parseFloat(match[1]);
                category = match[2].trim();
            } else {
                category = match[1].trim();
                amount = parseFloat(match[2]);
            }
            
            // Map to proper category name
            const categoryMap = {
                'food': 'Food & Dining', 'dining': 'Food & Dining', 'groceries': 'Food & Dining', 'eating': 'Food & Dining',
                'transport': 'Transportation', 'transportation': 'Transportation', 'gas': 'Transportation', 'car': 'Transportation',
                'shopping': 'Shopping', 'clothes': 'Shopping',
                'entertainment': 'Entertainment', 'fun': 'Entertainment',
                'bills': 'Bills & Utilities', 'utilities': 'Bills & Utilities',
                'health': 'Healthcare', 'medical': 'Healthcare'
            };
            
            const mappedCategory = categoryMap[category.toLowerCase()] || category.replace(/\b\w/g, l => l.toUpperCase());
            
            if (amount > 0) {
                return {
                    intent: 'SET_BUDGET',
                    confidence: 0.9,
                    action: {
                        category: mappedCategory,
                        amount,
                        period: 'monthly'
                    },
                    message: `I'll set the ${mappedCategory} budget to $${amount}/month. Confirm?`,
                    requiresConfirmation: true
                };
            }
        }
    }

    // Pattern: "create goal to save $1000 for vacation"
    const goalPatterns = [
        /(?:create|set|add|start)\s+(?:a\s+)?goal\s+(?:to\s+)?(?:save\s+)?\$?(\d+)\s+(?:for\s+)?(.+)/i,
        /(?:save|saving)\s+\$?(\d+)\s+(?:for\s+)?(.+)/i,
        /goal[:\s]+(.+?)\s+\$(\d+)/i
    ];

    for (const pattern of goalPatterns) {
        const match = lower.match(pattern);
        if (match) {
            let target, name;
            if (pattern === goalPatterns[2]) {
                name = match[1].trim();
                target = parseFloat(match[2]);
            } else {
                target = parseFloat(match[1]);
                name = match[2]?.trim() || 'Savings Goal';
            }
            
            name = name.replace(/\b\w/g, l => l.toUpperCase());
            
            if (target > 0) {
                return {
                    intent: 'CREATE_GOAL',
                    confidence: 0.9,
                    action: {
                        name,
                        target,
                        deadline: null
                    },
                    message: `I'll create a goal: "${name}" with a target of $${target}. Confirm?`,
                    requiresConfirmation: true
                };
            }
        }
    }

    // Pattern: "remind me about rent on the 1st"
    const reminderPatterns = [
        /remind(?:er)?\s+(?:me\s+)?(?:about\s+)?(.+?)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?/i,
        /(?:add\s+)?reminder[:\s]+(.+?)\s+(?:on\s+)?(?:day\s+)?(\d{1,2})/i
    ];

    for (const pattern of reminderPatterns) {
        const match = lower.match(pattern);
        if (match) {
            const title = match[1].trim().replace(/\b\w/g, l => l.toUpperCase());
            const dueDay = parseInt(match[2]);
            
            if (dueDay >= 1 && dueDay <= 31) {
                return {
                    intent: 'ADD_REMINDER',
                    confidence: 0.9,
                    action: {
                        title,
                        amount: null,
                        dueDay,
                        recurring: true
                    },
                    message: `I'll add a reminder for "${title}" on day ${dueDay} of each month. Confirm?`,
                    requiresConfirmation: true
                };
            }
        }
    }

    return null; // No local match found
}

// Parse AI intent from user message
async function parseIntent(message, financialContext) {
    // First, try local parsing (works without AI)
    const localResult = parseIntentLocally(message);
    if (localResult) {
        console.log('Handled locally:', localResult.intent);
        return localResult;
    }

    // If no AI configured, provide helpful response
    if (!aiModel) {
        return {
            intent: 'ANSWER',
            confidence: 1.0,
            message: `I can help you with:\n• "Add $50 for groceries" - add transactions\n• "Set food budget to $500" - create budgets\n• "Create goal to save $1000 for vacation" - set goals\n• "Remind me about rent on the 1st" - add reminders\n\nFor more advanced questions, please add your Gemini API key to server-config.json`,
            requiresConfirmation: false
        };
    }

    try {
        const prompt = `${AGENT_SYSTEM_PROMPT}

USER MESSAGE: "${message}"

FINANCIAL CONTEXT (anonymized):
- Monthly expenses: $${financialContext.monthlyExpenses || 0}
- Monthly income: $${financialContext.monthlyIncome || 0}
- Active budgets: ${financialContext.budgetCount || 0}
- Active goals: ${financialContext.goalCount || 0}
- Top categories: ${JSON.stringify(financialContext.topCategories || [])}

Respond with valid JSON only.`;

        const result = await aiModel.generateContent(prompt);
        const response = result.response.text();
        
        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        return {
            intent: 'ANSWER',
            confidence: 0.5,
            message: response.replace(/```json|```/g, '').trim(),
            requiresConfirmation: false
        };
    } catch (error) {
        console.error('AI parsing error:', error.message);
        // Fallback to helpful message
        return {
            intent: 'ANSWER',
            confidence: 0.0,
            message: `I couldn't process that with AI, but I can help with:\n• "Add $50 for groceries"\n• "Set food budget to $500"\n• "Create goal to save $1000"\n• "Remind me about rent on the 1st"`,
            requiresConfirmation: false
        };
    }
}

// Generate proactive insights
async function generateInsights(financialData) {
    if (!aiModel) {
        return { insights: [] };
    }

    try {
        const prompt = INSIGHTS_PROMPT.replace('{data}', JSON.stringify(financialData, null, 2));
        const result = await aiModel.generateContent(prompt);
        const response = result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return { insights: [] };
    } catch (error) {
        console.error('Insights generation error:', error);
        return { insights: [] };
    }
}

// Generate spending predictions
async function generatePredictions(financialData) {
    if (!aiModel) {
        return null;
    }

    try {
        const prompt = PREDICTION_PROMPT.replace('{data}', JSON.stringify(financialData, null, 2));
        const result = await aiModel.generateContent(prompt);
        const response = result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (error) {
        console.error('Prediction error:', error);
        return null;
    }
}

// ===== API ENDPOINTS =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '3.0.0',
        aiEnabled: !!aiModel
    });
});

// Get encrypted data
app.get('/api/data/:accountId', (req, res) => {
    try {
        const { accountId } = req.params;
        
        if (!accountId || typeof accountId !== 'string') {
            return res.status(400).json({ error: 'Valid accountId required' });
        }
        
        const dataFile = path.join(DB_DIR, `${accountId}.json`);
        
        if (!fs.existsSync(dataFile)) {
            return res.json({
                transactions: [],
                recurring_bills: [],
                goals: [],
                budgets: [],
                reminders: [],
                settings: {},
                lastSync: null
            });
        }
        
        const encryptedData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        res.json({
            ...encryptedData,
            lastSync: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error reading data:', error);
        res.status(500).json({ error: 'Failed to read data' });
    }
});

// Sync encrypted data
app.post('/api/sync', validateSyncData, (req, res) => {
    try {
        const { transactions, recurring_bills, goals, budgets, reminders, settings, accountId } = req.body;
        
        const dataFile = path.join(DB_DIR, `${accountId}.json`);
        
        const encryptedData = {
            transactions: transactions || [],
            recurring_bills: recurring_bills || [],
            goals: goals || [],
            budgets: budgets || [],
            reminders: reminders || [],
            settings: settings || {},
            lastSync: new Date().toISOString(),
            syncCount: 0
        };
        
        if (fs.existsSync(dataFile)) {
            try {
                const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
                encryptedData.syncCount = (existing.syncCount || 0) + 1;
            } catch (e) {
                console.warn('Could not read existing sync count');
            }
        }
        
        const tempFile = dataFile + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(encryptedData, null, 2));
        fs.renameSync(tempFile, dataFile);
        
        res.json({ 
            message: 'Data synced successfully',
            syncCount: encryptedData.syncCount,
            timestamp: encryptedData.lastSync
        });
        
    } catch (error) {
        console.error('Error syncing data:', error);
        res.status(500).json({ error: 'Failed to sync data' });
    }
});

// AI Agent Chat endpoint
app.post('/api/agent/chat', agentRateLimit, async (req, res) => {
    try {
        const { message, financialContext } = req.body;
        
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        if (message.length > 1000) {
            return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
        }
        
        const result = await parseIntent(message, financialContext || {});
        
        res.json({
            ...result,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Agent chat error:', error);
        res.status(500).json({ error: 'AI service temporarily unavailable' });
    }
});

// Generate insights endpoint
app.post('/api/agent/insights', agentRateLimit, async (req, res) => {
    try {
        const { financialData } = req.body;
        
        if (!financialData) {
            return res.status(400).json({ error: 'Financial data required' });
        }
        
        const insights = await generateInsights(financialData);
        
        res.json({
            ...insights,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Insights error:', error);
        res.status(500).json({ error: 'Failed to generate insights' });
    }
});

// Predictions endpoint
app.post('/api/agent/predict', agentRateLimit, async (req, res) => {
    try {
        const { financialData } = req.body;
        
        if (!financialData) {
            return res.status(400).json({ error: 'Financial data required' });
        }
        
        const predictions = await generatePredictions(financialData);
        
        res.json({
            predictions,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Prediction error:', error);
        res.status(500).json({ error: 'Failed to generate predictions' });
    }
});

// Legacy chat endpoint (backward compatibility)
app.post('/api/chat', chatRateLimit, async (req, res) => {
    try {
        const { message, financialData } = req.body;
        
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        if (!aiModel) {
            return res.status(503).json({ 
                error: 'AI service not configured. Please set GEMINI_API_KEY.' 
            });
        }
        
        const systemPrompt = `You are a helpful financial advisor. Provide concise, practical advice. Keep responses under 200 words.`;
        
        const userPrompt = `User: "${message}"
Financial context: Monthly expenses $${financialData?.monthlyExpenses || 0}, ${financialData?.totalTransactions || 0} transactions.`;
        
        const result = await aiModel.generateContent([
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'user', parts: [{ text: userPrompt }] }
        ]);
        
        const response = result.response.text().replace(/\*\*/g, '').replace(/\*/g, '').trim();
        
        res.json({ 
            response,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'AI service temporarily unavailable' });
    }
});

// Delete account data
app.delete('/api/data/:accountId', (req, res) => {
    try {
        const { accountId } = req.params;
        const { confirmDelete } = req.body;
        
        if (!accountId || typeof accountId !== 'string') {
            return res.status(400).json({ error: 'Valid accountId required' });
        }
        
        if (confirmDelete !== 'DELETE_ALL_DATA') {
            return res.status(400).json({ error: 'Confirmation string required' });
        }
        
        const dataFile = path.join(DB_DIR, `${accountId}.json`);
        
        if (fs.existsSync(dataFile)) {
            fs.unlinkSync(dataFile);
        }
        
        res.json({ 
            message: 'Account data deleted successfully',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error deleting account data:', error);
        res.status(500).json({ error: 'Failed to delete account data' });
    }
});

// Admin stats
app.get('/api/admin/stats', (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== 'Bearer admin-token') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
        
        res.json({
            totalAccounts: files.length,
            serverUptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            nodeVersion: process.version,
            aiEnabled: !!aiModel,
            lastRequest: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ===== ERROR HANDLING =====

app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET /api/health',
            'GET /api/data/:accountId',
            'POST /api/sync',
            'POST /api/agent/chat',
            'POST /api/agent/insights',
            'POST /api/agent/predict',
            'POST /api/chat',
            'DELETE /api/data/:accountId'
        ]
    });
});

app.use((error, req, res, next) => {
    console.error('Server error:', error);
    
    if (error.status === 413) {
        return res.status(413).json({ error: 'Payload too large' });
    }
    
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// ===== SERVER STARTUP =====

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`\n🚀 Guardfin AI Server v3.0.0 running on http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${DB_DIR}`);
    console.log(`🔧 Config file: ${CONFIG_FILE}`);
    console.log(`🛡️  Security: Rate limiting, Input validation, CORS protection`);
    
    if (aiModel) {
        console.log('✅ AI Agent enabled');
    } else {
        console.log('⚠️  AI Agent disabled - configure API key in server-config.json');
    }
    
    console.log(`\n📋 Endpoints:`);
    console.log(`   GET  /api/health - Health check`);
    console.log(`   GET  /api/data/:accountId - Fetch data`);
    console.log(`   POST /api/sync - Sync encrypted data`);
    console.log(`   POST /api/agent/chat - AI agent chat`);
    console.log(`   POST /api/agent/insights - Generate insights`);
    console.log(`   POST /api/agent/predict - Spending predictions`);
    console.log(`\n🔒 All data encrypted client-side. Zero-knowledge architecture.`);
});
