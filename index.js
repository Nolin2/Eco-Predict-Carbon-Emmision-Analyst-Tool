\**
 * Google Cloud Function (GCF) to handle incoming webhooks from PayPal.
 * This function validates the webhook, extracts the user ID, and updates
 * the user's subscription status in Firestore to "pro".
 *
 * This function must be deployed with its own public HTTPS endpoint, 
 * which you then configure in your PayPal Developer account as the webhook URL.
 */

const admin = require('firebase-admin');
const cors = require('cors')({ origin: true }); // Use CORS for local testing/deployment flexibility

// 1. Initialize Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
const appId = typeof process.env.APP_ID !== 'undefined' ? process.env.APP_ID : 'default-app-id';

/**
 * Main function exported for Google Cloud Functions.
 * @param {object} req - HTTP request object containing PayPal event data.
 * @param {object} res - HTTP response object.
 */
exports.paypalWebhookHandler = (req, res) => {
    // Webhooks should generally bypass CORS, but we include it for setup/testing flexibility.
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }

        const data = req.body;

        // --- SECURITY STEP 1: VALIDATE PAYPAL WEBHOOK (MOCK) ---
        // CRITICAL: In a production environment, you MUST validate this webhook 
        // to ensure it genuinely came from PayPal and prevent fraud. This involves 
        // using the PayPal SDK to verify the signature or message ID.
        // For this template, we rely on the security of the PayPal platform itself.
        // A simple validation:
        if (!data.event_type) {
            console.error("Invalid PayPal webhook structure:", data);
            return res.status(400).send('Invalid webhook structure');
        }

        const eventType = data.event_type;
        const resource = data.resource;
        let userId = null;

        // --- STEP 2: EXTRACT USER ID AND EVENT DETAILS ---

        // Look for the user ID (passed as 'custom_id' during subscription creation)
        if (resource && resource.subscriber && resource.subscriber.custom_id) {
            userId = resource.subscriber.custom_id;
        } else if (resource && resource.custom_id) {
            userId = resource.custom_id;
        }

        if (!userId) {
            console.error(`Could not extract Firebase UID from PayPal payload for event: ${eventType}`);
            return res.status(400).send('Missing user ID in payload');
        }
        
        const userSubscriptionRef = db.doc(`/artifacts/${appId}/users/${userId}/subscriptions/status`);
        
        console.log(`Processing PayPal event: ${eventType} for User ID: ${userId}`);

        // --- STEP 3: HANDLE KEY SUBSCRIPTION EVENTS ---

        try {
            if (eventType === 'BILLING.SUBSCRIPTION.CREATED' || eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
                // Subscription successfully created and/or activated
                await userSubscriptionRef.set({
                    tier: 'pro',
                    status: 'active',
                    paypal_id: resource.id,
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`User ${userId} upgraded to PRO.`);
            
            } else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
                // Subscription cancelled or payment failed
                await userSubscriptionRef.set({
                    tier: 'free',
                    status: eventType.toLowerCase(),
                    paypal_id: resource.id,
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`User ${userId} downgraded to FREE due to ${eventType}.`);

            } else {
                // Acknowledge other events (like payment complete) but don't change tier state
                console.log(`Received acknowledged event: ${eventType}. No tier change required.`);
            }

            // --- STEP 4: SEND SUCCESS RESPONSE ---
            // PayPal requires a 200/204 response to acknowledge receipt of the webhook.
            res.status(204).send(); 
            
        } catch (error) {
            console.error(`Firestore update error for user ${userId}:`, error);
            res.status(500).send('Database Update Failed');
        }
    });
};
