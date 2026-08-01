require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// CONFIGURATION FROM ENVIRONMENT VARIABLES
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'campusdash_secret_verify_token';
const ADMIN_PSID = process.env.ADMIN_PSID; // CEO Messenger PSID
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// -------------------------------------------------------------
// 0. HOMEPAGE ROUTE (Confirms server is live in browser)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.send("🚀 CampusDash PH Server is Live and Running!");
});

// -------------------------------------------------------------
// 1. WEBHOOK VERIFICATION (GET /webhook)
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// -------------------------------------------------------------
// 2. MAIN WEBHOOK LISTENER (POST /webhook)
// -------------------------------------------------------------
app.post('/webhook', (req, res) => {
    let body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(entry => {
            if (entry.messaging && entry.messaging.length > 0) {
                let event = entry.messaging[0];
                let sender_psid = event.sender.id;

                if (event.message) {
                    handleIncomingMessage(sender_psid, event.message);
                } else if (event.postback) {
                    handleIncomingPostback(sender_psid, event.postback);
                }
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// -------------------------------------------------------------
// 3. UNIFIED MESSAGE ROUTER (CLIENT / RUNNER / ADMIN)
// -------------------------------------------------------------
async function handleIncomingMessage(sender_psid, message) {
    let session = await getOrCreateSession(sender_psid);
    let isRunner = await checkIfRunner(sender_psid);
    let isAdmin = (sender_psid === ADMIN_PSID);

    let text = message.text ? message.text.trim() : "";

    // A. ADMIN COMMANDS (CEO)
    if (isAdmin && (text.toLowerCase() === 'admin' || session.current_step.startsWith('ADMIN_'))) {
        await handleAdminMessageStep(sender_psid, session, text);
        return;
    }

    // B. IMAGE / SCREENSHOT ATTACHMENTS
    if (message.attachments && message.attachments[0].type === 'image') {
        let imageUrl = message.attachments[0].payload.url;

        // Runner Receipt or Dropoff Photo Upload
        if (isRunner && session.current_step === 'RUNNER_WAITING_RECEIPT') {
            await handleRunnerReceiptUpload(sender_psid, session.active_order_id, imageUrl);
            return;
        } else if (isRunner && session.current_step === 'RUNNER_WAITING_DROPOFF_PHOTO') {
            await handleRunnerDropoffPhotoUpload(sender_psid, session.active_order_id, imageUrl);
            return;
        }

        // Client GCash Payment Screenshot Upload
        if (!isRunner) {
            await handleClientGCashScreenshot(sender_psid, imageUrl);
            return;
        }
    }

    // C. ACTIVE ORDER 2-WAY MESSAGE RELAY (CLIENT <-> RUNNER)
    let isRelayed = await handleActiveOrderRelay(sender_psid, text, isRunner);
    if (isRelayed) return;

    // D. QUICK REPLIES
    if (message.quick_reply) {
        await handlePayload(sender_psid, session, message.quick_reply.payload);
        return;
    }

    // E. CLIENT CONVERSATIONAL FORM STEPS (SAFE CRASH-PROOF STEP CHECK)
    let currentStep = (session && session.current_step) ? session.current_step : 'IDLE';

    switch (currentStep) {
        case 'STEP_STORE_LOCATION':
            await updateSession(sender_psid, { store_location: text, current_step: 'STEP_DROPOFF_LOCATION' });
            sendTextMessage(sender_psid, "📍 Where should the runner deliver your item? (Building / Room #)");
            break;

        case 'STEP_DROPOFF_LOCATION':
            await updateSession(sender_psid, { dropoff_location: text, current_step: 'STEP_ITEM_DESC' });
            sendTextMessage(sender_psid, "📦 What item/s do you need? (Be specific!)");
            break;

        case 'STEP_ITEM_DESC':
            await updateSession(sender_psid, { item_description: text, current_step: 'STEP_ESTIMATED_COST' });
            sendTextMessage(sender_psid, "💵 What is the estimated cost of the item/s in Pesos? (e.g., 150)");
            break;

        case 'STEP_ESTIMATED_COST':
            let cost = parseFloat(text.replace(/[^0-9.]/g, '')) || 0;
            await updateSession(sender_psid, { estimated_item_cost: cost, current_step: 'STEP_PAYMENT_METHOD' });
            sendQuickReplies(sender_psid, `Estimated Cost: ₱${cost.toFixed(2)}\n\nHow would you like to pay?`, [
                { title: "💵 Cash on Delivery", payload: "PAY_COD" },
                { title: "📱 Full Upfront GCash", payload: "PAY_GCASH" }
            ]);
            break;

        default:
            if (isAdmin) showAdminMenu(sender_psid);
            else sendWelcomeMenu(sender_psid);
            break;
    }
}

async function handleIncomingPostback(sender_psid, postback) {
    let session = await getOrCreateSession(sender_psid);
    await handlePayload(sender_psid, session, postback.payload);
}

// -------------------------------------------------------------
// 4. PAYLOAD & ACTION ROUTER
// -------------------------------------------------------------
async function handlePayload(sender_psid, session, payload) {
    if (payload === 'GET_STARTED' || payload === 'START_ORDER') {
        await updateSession(sender_psid, { current_step: 'STEP_TIER_SELECTION' });
        let settings = await getPricingSettings();
        sendQuickReplies(sender_psid, "🛵 Select your Errand Tier:", [
            { title: `Small (₱${settings.fee_small} Fee)`, payload: "TIER_SMALL" },
            { title: `Medium (₱${settings.fee_medium} Fee)`, payload: "TIER_MEDIUM" },
            { title: `Large (₱${settings.fee_large} Fee)`, payload: "TIER_LARGE" }
        ]);
    } else if (payload === 'ADMIN_MENU') {
        showAdminMenu(sender_psid);
    } else if (payload.startsWith('ADMIN_')) {
        await handleAdminPayload(sender_psid, session, payload);
    } else if (payload === 'VIEW_RATES') {
        let s = await getPricingSettings();
        let ratesMsg = `📋 CAMPUSDASH PH RATES:\n\n• Small (₱${s.fee_small}): In-campus docs\n• Medium (₱${s.fee_medium}): Near off-campus food\n• Large (₱${s.fee_large}): Far off-campus/Pamasahe\n\n✨ 0% Markup on Store Receipts!`;
        sendQuickReplies(sender_psid, ratesMsg, [{ title: "🛵 Order Errand", payload: "START_ORDER" }]);
    } else if (payload.startsWith('TIER_')) {
        let tier = payload.replace('TIER_', '');
        await updateSession(sender_psid, { errand_tier: tier, current_step: 'STEP_STORE_LOCATION' });
        sendTextMessage(sender_psid, "🏬 Where should the runner buy/pickup your item? (Store / Location Name)");
    } else if (payload === 'PAY_COD' || payload === 'PAY_GCASH') {
        let method = payload === 'PAY_COD' ? 'CASH_COD' : 'FULL_GCASH';
        await updateSession(sender_psid, { payment_method: method, current_step: 'STEP_CONFIRMATION' });
        showOrderSummary(sender_psid);
    } else if (payload === 'CONFIRM_FINAL_ORDER') {
        await finalizeOrderAndAutoDispatch(sender_psid);
    } 
    // RUNNER ACTIONS
    else if (payload.startsWith('CLAIM_')) {
        let orderId = payload.replace('CLAIM_', '');
        await handleRunnerClaim(sender_psid, orderId);
    } else if (payload.startsWith('PROMPT_RECEIPT_')) {
        let orderId = payload.replace('PROMPT_RECEIPT_', '');
        await updateSession(sender_psid, { current_step: 'RUNNER_WAITING_RECEIPT', active_order_id: orderId });
        sendTextMessage(sender_psid, "📸 Please send a photo of the store's paper receipt here!");
    } else if (payload.startsWith('ARRIVED_')) {
        let orderId = payload.replace('ARRIVED_', '');
        await handleRunnerArrived(sender_psid, orderId);
    } else if (payload.startsWith('PROMPT_COMPLETE_')) {
        let orderId = payload.replace('PROMPT_COMPLETE_', '');
        await updateSession(sender_psid, { current_step: 'RUNNER_WAITING_DROPOFF_PHOTO', active_order_id: orderId });
        sendTextMessage(sender_psid, "📸 Please send a photo of the item at the drop-off location to complete!");
    }
}

// -------------------------------------------------------------
// 5. CLIENT CHECKOUT & >₱200 DEPOSIT LOGIC
// -------------------------------------------------------------
async function showOrderSummary(sender_psid) {
    let s = await getOrCreateSession(sender_psid);
    let settings = await getPricingSettings();

    let fee = settings.fee_small;
    if (s.errand_tier === 'MEDIUM') fee = settings.fee_medium;
    if (s.errand_tier === 'LARGE') fee = settings.fee_large;

    let depNote = "";
    if (s.payment_method === 'CASH_COD' && s.estimated_item_cost > 200) {
        let dep = s.estimated_item_cost / 2;
        depNote = `\n⚠️ Item >₱200: Requires 50% upfront deposit (₱${dep.toFixed(2)}).`;
    }

    let summaryText = `📝 ORDER SUMMARY:\n\n• Tier: ${s.errand_tier}\n• Pickup: ${s.store_location}\n• Dropoff: ${s.dropoff_location}\n• Item: ${s.item_description}\n• Est. Cost: ₱${s.estimated_item_cost}\n• Delivery Fee: ₱${fee}\n• Payment: ${s.payment_method === 'CASH_COD' ? 'Cash COD' : '100% GCash'}${depNote}\n\nDo you agree to our terms and waiting policy?`;

    sendQuickReplies(sender_psid, summaryText, [
        { title: "✅ Agree & Order", payload: "CONFIRM_FINAL_ORDER" },
        { title: "❌ Cancel", payload: "START_ORDER" }
    ]);
}

async function finalizeOrderAndAutoDispatch(sender_psid) {
    let s = await getOrCreateSession(sender_psid);
    let settings = await getPricingSettings();

    let fee = settings.fee_small; let ceoCut = settings.ceo_cut_small; let runnerCut = fee - ceoCut;
    if (s.errand_tier === 'MEDIUM') { fee = settings.fee_medium; ceoCut = settings.ceo_cut_medium; runnerCut = fee - ceoCut; }
    if (s.errand_tier === 'LARGE') { fee = settings.fee_large; ceoCut = settings.ceo_cut_large; runnerCut = fee - ceoCut; }

    let requiresDeposit = (s.payment_method === 'CASH_COD' && s.estimated_item_cost > 200);
    let depositAmt = requiresDeposit ? (s.estimated_item_cost / 2) : 0.00;

    const { data, error } = await supabase.from('orders').insert([{
        client_name: 'Campus Student',
        client_fb_id: sender_psid,
        errand_tier: s.errand_tier,
        store_location: s.store_location,
        dropoff_location: s.dropoff_location,
        item_description: s.item_description,
        estimated_item_cost: s.estimated_item_cost,
        delivery_fee: fee,
        ceo_cut: ceoCut,
        runner_cut: runnerCut,
        payment_method: s.payment_method,
        deposit_required: requiresDeposit,
        deposit_amount: depositAmt,
        status: requiresDeposit ? 'PENDING_DEPOSIT' : 'DISPATCHED'
    }]).select();

    if (!error && data && data.length > 0) {
        let order = data[0];
        await resetSession(sender_psid);

        if (requiresDeposit) {
            sendTextMessage(sender_psid, `🎉 ORDER #CMD-${order.order_number} CREATED!\n\n⚠️ Item >₱200: Send ₱${depositAmt.toFixed(2)} deposit to CEO GCash: 09XX-XXX-XXXX and upload screenshot here!`);
            if (ADMIN_PSID) sendTextMessage(ADMIN_PSID, `🚨 NEW ORDER #CMD-${order.order_number} REQUIRES ₱${depositAmt.toFixed(2)} DEPOSIT!`);
        } else {
            sendTextMessage(sender_psid, `🎉 ORDER #CMD-${order.order_number} DISPATCHED!\nNearby runners are being notified!`);
            await broadcastOrderToRunners(order);
        }
    }
}

// -------------------------------------------------------------
// 6. GCASH SCREENSHOT AUTO-FORWARDING (TO ADMIN & RUNNER)
// -------------------------------------------------------------
async function handleClientGCashScreenshot(sender_psid, imageUrl) {
    const { data: order } = await supabase
        .from('orders')
        .select('*, runners(fb_user_id)')
        .eq('client_fb_id', sender_psid)
        .in('status', ['PENDING_DEPOSIT', 'DISPATCHED', 'IN_PROGRESS', 'ARRIVED'])
        .single();

    if (!order) return;

    await supabase.from('orders').update({ gcash_proof_url: imageUrl }).eq('id', order.id);

    // Forward Screenshot to ADMIN (CEO)
    if (ADMIN_PSID) {
        sendTextMessage(ADMIN_PSID, `💳 GCASH RECEIPT ATTACHED (#CMD-${order.order_number})\n• Client: ${order.client_name}\n• Deposit Required: ₱${order.deposit_amount}`);
        sendImageMessage(ADMIN_PSID, imageUrl);
        sendQuickReplies(ADMIN_PSID, `Approve Order #${order.order_number}?`, [
            { title: `Approve Deposit #${order.order_number}`, payload: `ADMIN_APPROVE_${order.id}` }
        ]);
    }

    // Forward Screenshot to ASSIGNED RUNNER
    if (order.runners && order.runners.fb_user_id) {
        sendTextMessage(order.runners.fb_user_id, `💳 CLIENT SENT GCASH RECEIPT (#CMD-${order.order_number})!`);
        sendImageMessage(order.runners.fb_user_id, imageUrl);
    }

    sendTextMessage(sender_psid, `✅ Payment screenshot received for #CMD-${order.order_number}! Processing your order.`);
}

// -------------------------------------------------------------
// 7. TWO-WAY MESSAGING RELAY (CLIENT <-> RUNNER)
// -------------------------------------------------------------
async function handleActiveOrderRelay(sender_psid, text, isRunner) {
    if (isRunner) {
        const { data: runner } = await supabase.from('runners').select('id').eq('fb_user_id', sender_psid).single();
        if (!runner) return false;

        const { data: order } = await supabase.from('orders').select('*').eq('assigned_runner_id', runner.id).in('status', ['IN_PROGRESS', 'ARRIVED']).single();
        if (order) {
            sendTextMessage(order.client_fb_id, `💬 RUNNER UPDATE (#CMD-${order.order_number}):\n"${text}"`);
            return true;
        }
    } else {
        const { data: order } = await supabase.from('orders').select('*, runners(fb_user_id)').eq('client_fb_id', sender_psid).in('status', ['IN_PROGRESS', 'ARRIVED']).single();
        if (order && order.runners) {
            sendTextMessage(order.runners.fb_user_id, `💬 CLIENT MESSAGE (#CMD-${order.order_number}):\n"${text}"`);
            return true;
        }
    }
    return false;
}

// -------------------------------------------------------------
// 8. RUNNER DISPATCH & ACTION HANDLERS
// -------------------------------------------------------------
async function broadcastOrderToRunners(order) {
    const { data: activeRunners } = await supabase.from('runners').select('*').eq('status', 'ACTIVE');
    if (!activeRunners) return;

    let msg = `🚨 NEW ERRAND #CMD-${order.order_number} (${order.errand_tier})\n\n• Pickup: ${order.store_location}\n• Dropoff: ${order.dropoff_location}\n• Item: ${order.item_description}\n• Est. Cost: ₱${order.estimated_item_cost}\n💰 Your Pay: ₱${order.runner_cut}`;

    activeRunners.forEach(runner => {
        sendQuickReplies(runner.fb_user_id, msg, [{ title: "🛵 CLAIM ERRAND", payload: `CLAIM_${order.id}` }]);
    });
}

async function handleRunnerClaim(runner_psid, order_id) {
    const { data: runner } = await supabase.from('runners').select('*').eq('fb_user_id', runner_psid).single();
    if (!runner) return;

    const { data: order } = await supabase.from('orders').select('*').eq('id', order_id).single();
    if (order.status !== 'DISPATCHED') {
        sendTextMessage(runner_psid, "❌ Sorry, this errand was already claimed!");
        return;
    }

    await supabase.from('orders').update({ assigned_runner_id: runner.id, status: 'IN_PROGRESS' }).eq('id', order_id);

    sendQuickReplies(runner_psid, `✅ YOU CLAIMED #CMD-${order.order_number}!\nPickup: ${order.store_location}`, [
        { title: "📸 ATTACH RECEIPT", payload: `PROMPT_RECEIPT_${order.id}` }
    ]);

    sendTextMessage(order.client_fb_id, `🛵 ERRAND UPDATE (#CMD-${order.order_number})\nClaimed by Runner ${runner.full_name}! ETA: 15-20 mins.`);
}

async function handleRunnerReceiptUpload(runner_psid, order_id, imageUrl) {
    const { data: order } = await supabase.from('orders').update({ receipt_photo_url: imageUrl }).eq('id', order_id).select().single();
    await resetSession(runner_psid);

    sendQuickReplies(runner_psid, `Receipt attached! Proceed to ${order.dropoff_location}.`, [
        { title: "📍 I HAVE ARRIVED", payload: `ARRIVED_${order.id}` }
    ]);

    sendImageMessage(order.client_fb_id, imageUrl);
    sendTextMessage(order.client_fb_id, `🧾 ITEM PURCHASED!\nPaper receipt attached.\n\n• Est. Cost: ₱${order.estimated_item_cost}\n• Delivery Fee: ₱${order.delivery_fee}\n💰 TOTAL DUE: ₱${parseFloat(order.estimated_item_cost) + parseFloat(order.delivery_fee)}`);
}

async function handleRunnerArrived(runner_psid, order_id) {
    const { data: order } = await supabase.from('orders').update({ status: 'ARRIVED' }).eq('id', order_id).select().single();

    sendQuickReplies(runner_psid, `Client notified of arrival!`, [
        { title: "✅ MARK COMPLETED", payload: `PROMPT_COMPLETE_${order.id}` }
    ]);

    sendTextMessage(order.client_fb_id, `📍 RUNNER ARRIVED!\nWaiting at ${order.dropoff_location}.\n⏰ 5-min grace period starts now!`);
}

async function handleRunnerDropoffPhotoUpload(runner_psid, order_id, imageUrl) {
    const { data: order } = await supabase.from('orders').update({ dropoff_photo_url: imageUrl, status: 'COMPLETED' }).eq('id', order_id).select().single();
    await resetSession(runner_psid);

    sendTextMessage(runner_psid, `🎉 #CMD-${order.order_number} COMPLETED!\n💰 Earned: ₱${order.runner_cut}`);
    sendTextMessage(order.client_fb_id, `🎉 DELIVERY COMPLETE!\nThank you for using CampusDash PH!\n\nHow was your service today?\n[ ⭐⭐⭐⭐⭐ Rate 5 Stars ]`);
}

// -------------------------------------------------------------
// 9. CEO INTERACTIVE DASHBOARD & CONTROLS
// -------------------------------------------------------------
function showAdminMenu(psid) {
    sendQuickReplies(psid, "👑 CAMPUSDASH CEO DASHBOARD\nSelect an option below:", [
        { title: "📊 EOD Audit Report", payload: "ADMIN_AUDIT" },
        { title: "📢 Message All Runners", payload: "ADMIN_BROADCAST_PROMPT" },
        { title: "💰 Edit Pricing", payload: "ADMIN_PRICING_MENU" },
        { title: "🛵 Active Runners", payload: "ADMIN_LIST_RUNNERS" }
    ]);
}

async function handleAdminPayload(psid, session, payload) {
    if (payload === 'ADMIN_AUDIT') {
        const { data: orders } = await supabase.from('orders').select('*, runners(full_name)').eq('status', 'COMPLETED');
        let ceoTotal = 0; let runnerTotal = 0;
        orders?.forEach(o => { ceoTotal += parseFloat(o.ceo_cut); runnerTotal += parseFloat(o.runner_cut); });

        sendTextMessage(psid, `📊 DAILY AUDIT REPORT:\n\n• Completed Orders: ${orders?.length || 0}\n• CEO Net Profit: ₱${ceoTotal.toFixed(2)}\n• Total Runner Pay: ₱${runnerTotal.toFixed(2)}`);

    } else if (payload.startsWith('ADMIN_APPROVE_')) {
        let orderId = payload.replace('ADMIN_APPROVE_', '');
        const { data: order } = await supabase.from('orders').update({ status: 'DISPATCHED', deposit_required: false }).eq('id', orderId).select().single();
        if (order) {
            sendTextMessage(psid, `✅ Deposit for #CMD-${order.order_number} approved! Order dispatched.`);
            sendTextMessage(order.client_fb_id, `✅ Deposit verified! Order #CMD-${order.order_number} is now dispatched.`);
            await broadcastOrderToRunners(order);
        }
    } else if (payload === 'ADMIN_BROADCAST_PROMPT') {
        await updateSession(psid, { current_step: 'ADMIN_WAITING_BROADCAST_TEXT' });
        sendTextMessage(psid, "💬 Type the message you want to broadcast to ALL active runners:");

    } else if (payload === 'ADMIN_PRICING_MENU') {
        let s = await getPricingSettings();
        sendQuickReplies(psid, `💰 CURRENT FEES:\n\n1. Small: ₱${s.fee_small}\n2. Medium: ₱${s.fee_medium}\n3. Large: ₱${s.fee_large}\n\nSelect a tier to edit:`, [
            { title: "Edit Small Fee", payload: "ADMIN_EDIT_FEE_SMALL" },
            { title: "Edit Medium Fee", payload: "ADMIN_EDIT_FEE_MEDIUM" },
            { title: "Edit Large Fee", payload: "ADMIN_EDIT_FEE_LARGE" }
        ]);

    } else if (payload === 'ADMIN_LIST_RUNNERS') {
        const { data: runners } = await supabase.from('runners').select('*');
        let list = "🛵 RUNNER TEAM STATUS:\n\n";
        runners?.forEach(r => { list += `• ${r.full_name} (${r.status}) - Float: ₱${r.active_float_balance}\n`; });
        sendTextMessage(psid, list);

    } else if (payload.startsWith('ADMIN_EDIT_FEE_')) {
        let tier = payload.replace('ADMIN_EDIT_FEE_', '').toLowerCase();
        await updateSession(psid, { current_step: `ADMIN_WAITING_PRICE_${tier}` });
        sendTextMessage(psid, `💵 Type the new fee for ${tier.toUpperCase()} errands in Pesos:`);
    }
}

async function handleAdminMessageStep(psid, session, text) {
    if (session.current_step === 'ADMIN_WAITING_BROADCAST_TEXT') {
        const { data: runners } = await supabase.from('runners').select('*').eq('status', 'ACTIVE');
        runners?.forEach(r => sendTextMessage(r.fb_user_id, `📢 CEO ANNOUNCEMENT:\n\n${text}`));
        await resetSession(psid);
        sendTextMessage(psid, `✅ Broadcast sent to ${runners?.length || 0} runners!`);

    } else if (session.current_step.startsWith('ADMIN_WAITING_PRICE_')) {
        let tierKey = 'fee_' + session.current_step.replace('ADMIN_WAITING_PRICE_', '');
        let newFee = parseFloat(text) || 30.00;
        await supabase.from('system_settings').update({ value: newFee }).eq('key', tierKey);
        await resetSession(psid);
        sendTextMessage(psid, `✅ Updated! New fee for ${tierKey} is ₱${newFee.toFixed(2)}.`);
    } else {
        showAdminMenu(psid);
    }
}

// -------------------------------------------------------------
// 10. BULLETPROOF SESSION HELPERS (PREVENTS NULL CRASH)
// -------------------------------------------------------------
async function getOrCreateSession(psid) {
    try {
        let { data } = await supabase.from('user_sessions').select('*').eq('psid', psid).single();
        if (data) return data;

        let { data: newSession } = await supabase
            .from('user_sessions')
            .insert([{ psid: psid, current_step: 'IDLE', role: 'CLIENT' }])
            .select()
            .single();

        if (newSession) return newSession;
    } catch (err) {
        console.error("Session fetch/create fallback:", err);
    }

    // FALLBACK OBJECT TO PREVENT NULL CRASH
    return { psid: psid, current_step: 'IDLE', role: 'CLIENT' };
}

async function getPricingSettings() {
    const { data } = await supabase.from('system_settings').select('*');
    let s = { fee_small: 30, fee_medium: 50, fee_large: 90, ceo_cut_small: 10, ceo_cut_medium: 15, ceo_cut_large: 25 };
    data?.forEach(r => { s[r.key] = parseFloat(r.value); });
    return s;
}

async function checkIfRunner(psid) {
    const { data } = await supabase.from('runners').select('id').eq('fb_user_id', psid).single();
    return !!data;
}

async function updateSession(psid, updates) { await supabase.from('user_sessions').update(updates).eq('psid', psid); }
async function resetSession(psid) {
    await supabase.from('user_sessions').upsert()
        current_step: 'IDLE', active_order_id: null, errand_tier: null,
        store_location: null, dropoff_location: null, item_description: null,
        estimated_item_cost: 0.00, payment_method: null
    }).eq('psid', psid);
}

function sendWelcomeMenu(psid) {
    sendQuickReplies(psid, "👋 Welcome to CampusDash PH!\nHow can we help you today?", [
        { title: "🛵 Order Errand", payload: "START_ORDER" },
        { title: "📋 Pricing Rates", payload: "VIEW_RATES" }
    ]);
}

function sendTextMessage(psid, text) { callSendAPI(psid, { text: text }); }
function sendImageMessage(psid, url) { callSendAPI(psid, { attachment: { type: "image", payload: { url: url } } }); }
function sendQuickReplies(psid, text, replies) {
    let qr = replies.map(r => ({ content_type: "text", title: r.title, payload: r.payload }));
    callSendAPI(psid, { text: text, quick_replies: qr });
}

function callSendAPI(psid, messageObj) {
    fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: psid }, message: messageObj })
    }).catch(err => console.error('Graph API Error:', err));
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`CampusDash Master Server running on port ${PORT}`));
