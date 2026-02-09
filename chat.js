// api/chat.js - Vercel Serverless Function
// Uses OpenRouter (sk-or-v1- keys) to access DeepSeek

const DEEPSEEK_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek/deepseek-chat';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { 
            message, 
            conversationHistory = [], 
            collectedInfo = {}, 
            // RANDOM NAME - Change this or pass it from your frontend
            businessName = "SmileCare Dental", 
            dentistPhone = "(555) 012-3456" 
        } = req.body;

        // 1. Extract Info (Now includes New/Existing check)
        const updatedInfo = extractInformation(message, collectedInfo, conversationHistory);

        // 2. Build System Prompt (Empathy + Priority Logic)
        const systemPrompt = buildSystemPrompt(updatedInfo, businessName, dentistPhone);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: message }
        ];

        // 3. Call DeepSeek
        const aiResponse = await callDeepSeekAPI(messages);

        const newHistory = [
            ...conversationHistory,
            { role: 'user', content: message },
            { role: 'assistant', content: aiResponse }
        ];

        const isComplete = checkIfComplete(updatedInfo) || aiResponse.includes('BOOKING_COMPLETE:');

        if (isComplete) {
            await saveAppointment(updatedInfo, businessName);
        }

        return res.status(200).json({
            reply: aiResponse.replace('BOOKING_COMPLETE:', '').trim(),
            conversationHistory: newHistory,
            collectedInfo: updatedInfo,
            isComplete: isComplete
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
}

async function callDeepSeekAPI(messages) {
    // Use env var in production (Vercel); fallback for local/testing
    const apiKey = process.env.DEEPSEEK_API_KEY || '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';

    const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: messages,
            max_tokens: 800,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek Error: ${errorData.error?.message || response.statusText || 'Unknown'}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "I'm sorry, I'm having trouble thinking. Can you repeat that?";
}

function buildSystemPrompt(info, businessName, dentistPhone) {
    return `You are a warm, empathetic booking assistant for ${businessName}. 
    
    TONE: Very caring, professional, and helpful. Use emojis like 🦷, 😊, and ✨. 
    If the user is in pain, acknowledge it: "Oh no, I'm so sorry you're dealing with that pain. Let's get your info so we can help you ASAP."

    YOUR GOAL: Collect the following details one-by-one:
    1. Name
    2. Are they a NEW or EXISTING patient?
    3. Email & Phone
    4. What's going on? (Issue)
    5. Are they in pain RIGHT NOW? (If yes, mark as URGENT)
    6. Insurance status (Just ask if they have it; if not, that's fine!)
    7. Preferred callback time (Morning/Afternoon/Evening)

    CURRENT DATA: ${JSON.stringify(info)}

    RULES:
    - Only ask ONE question at a time.
    - If they say they are in pain, comfort them.
    - Once all info is gathered, say "BOOKING_COMPLETE:" and tell them a human will call them within 2 hours to finalize the time.`;
}

function extractInformation(userMessage, currentInfo, history) {
    const info = { 
        name: '', patient_type: '', email: '', phone: '', 
        issue: '', urgency: 'Normal', insurance: 'None', 
        preferred_time: '', notes: '', ...currentInfo 
    };
    const msg = userMessage.toLowerCase();

    // Basic Extraction Logic
    if (!info.name && msg.includes('my name is')) info.name = userMessage.split('is').pop().trim();
    if (msg.includes('existing') || msg.includes('been there before')) info.patient_type = 'Existing';
    if (msg.includes('new patient') || msg.includes('first time')) info.patient_type = 'New';
    if (msg.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)) info.email = msg.match(/\S+@\S+\.\S+/)[0];
    if (msg.match(/\d{3}.*\d{3}.*\d{4}/)) info.phone = msg.match(/\d/g).join('');
    
    // URGENCY LOGIC
    if (msg.includes('yes') && history[history.length-1]?.content.toLowerCase().includes('pain right now')) {
        info.urgency = 'URGENT - PRIORITY 1';
    }

    info.notes += userMessage + " | ";
    return info;
}

function checkIfComplete(info) {
    return info.name && info.phone && info.issue && info.preferred_time;
}

async function saveAppointment(info, businessName) {
    const payload = {
        Timestamp: new Date().toLocaleString(),
        Name: info.name,
        Email: info.email,
        Phone: info.phone,
        Issue: info.issue,
        Urgency: info.urgency,
        Insurance: info.insurance,
        "Preferred Time": info.preferred_time,
        Notes: info.notes,
        "Business Name": businessName
    };

    try {
        // Send to Sheets
        await fetch(process.env.GOOGLE_SHEETS_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // Send Email
        await fetch(process.env.EMAIL_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({
                to: process.env.DENTIST_EMAIL,
                subject: `${info.urgency === 'URGENT - PRIORITY 1' ? '🚨 URGENT: ' : ''}New Lead - ${info.name}`,
                body: `You have a new booking request for ${businessName}.\n\nPriority: ${info.urgency}\nPatient: ${info.name}\nPhone: ${info.phone}\nIssue: ${info.issue}`
            })
        });
    } catch (e) { console.error("Sync Error", e); }
}