import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import CryptoJS from 'crypto-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, addDoc, getDocs, query, where, orderBy, serverTimestamp,
  doc, updateDoc 
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manual .env loader
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      process.env[key] = value;
    }
  });
}

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const app = express();
const PORT = process.env.PORT || 3000;
const ENCRYPTION_KEY = process.env.VITE_ENCRYPTION_KEY || 'vaulttalk-default-secret-key';

// Middleware
app.use(cors());
app.use(bodyParser.json());

/**
 * GET /api/messages
 * Fetches messages for a specific recipient.
 * Query: ?recipientId={uid}
 */
app.get('/api/messages', async (req, res) => {
  const { recipientId } = req.query;
  
  if (!recipientId) {
    return res.status(400).json({ error: 'recipientId query parameter is required' });
  }

  try {
    const q = query(
      collection(db, 'messages', recipientId, 'inbox')
      // orderBy removed to avoid index requirement; sorted manually above
    );
    
    const snapshot = await getDocs(q);
    const userMessages = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        // Manual sort to avoid Firestore index requirement for now
        const dateA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : new Date(a.createdAt || 0);
        const dateB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : new Date(b.createdAt || 0);
        return dateB - dateA;
      });

    console.log(`[GET] Fetched ${userMessages.length} messages from Firestore subcollection for user: ${recipientId}`);
    res.json(userMessages);
  } catch (error) {
    console.error('Firestore Error (GET /api/messages):', error);
    res.status(500).json({ error: 'Failed to fetch messages from database' });
  }
});

/**
 * POST /api/messages
 * Sends a new anonymous message.
 * Body: { recipientId, senderId, text, replyToId? }
 */
app.post('/api/messages', async (req, res) => {
  const { recipientId, senderId, text, replyToId } = req.body;

  if (!recipientId || !text) {
    return res.status(400).json({ error: 'recipientId and text are required' });
  }

  try {
    // Encrypt the message text
    const encryptedText = CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();

    const newMessage = {
      recipientId,
      senderId: senderId || 'anonymous',
      text: encryptedText,
      replyToId: replyToId || null,
      createdAt: serverTimestamp(),
    };

    const docRef = await addDoc(collection(db, 'messages', recipientId, 'inbox'), newMessage);
    console.log(`[POST] New encrypted message stored in Firestore subcollection: ${docRef.id}`);

    // Removed reply tracking logic
    
    res.status(201).json({ id: docRef.id, ...newMessage });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages):', error);
    res.status(500).json({ error: 'Failed to store message in database' });
  }
});

/**
 * POST /api/messages/report
 * Flags an existing message for administrative review.
 */
app.post('/api/messages/report', async (req, res) => {
  const { messageId, recipientId, text, senderId } = req.body;

  if (!messageId || !recipientId) {
    return res.status(400).json({ error: 'messageId and recipientId are required' });
  }

  try {
    const reportDoc = {
      messageId,
      recipientId,
      senderId: senderId || 'anonymous',
      text: text || 'encrypted', // The decrypted text sent from the client or the encrypted string if un-decrypted
      reportedAt: serverTimestamp(),
    };

    const docRef = await addDoc(collection(db, 'reported'), reportDoc);
    
    // Update original message to show it is reported
    try {
      const originalMsgRef = doc(db, 'messages', recipientId, 'inbox', messageId);
      await updateDoc(originalMsgRef, { isReported: true });
      console.log(`[POST] Marked message ${messageId} as reported in inbox of user ${recipientId}`);
    } catch (err) {
      console.error(`Failed to mark original message ${messageId} as reported:`, err);
    }
    
    console.log('\n--- URGENT: MESSAGE REPORTED ---');
    console.log(`Report ID: ${docRef.id}`);
    console.log(`Original Message ID: ${messageId}`);
    console.log(`Recipient: ${recipientId}`);
    console.log(`Sender: ${reportDoc.senderId}`);
    console.log(`Message Content: ${text}`);
    console.log('--------------------------------\n');

    res.status(201).json({ id: docRef.id, ...reportDoc });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages/report):', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

/**
 * GET /api/admin/reports
 * Fetches all reported messages for administrative review.
 */
app.get('/api/admin/reports', async (req, res) => {
  try {
    const q = query(
      collection(db, 'reported'),
      orderBy('reportedAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    const reports = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    console.log(`[GET] Fetched ${reports.length} reports for admin review.`);
    res.json(reports);
  } catch (error) {
    console.error('Firestore Error (GET /api/admin/reports):', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`VaultTalk Backend is running on http://localhost:${PORT}`);
  console.log(`Available Endpoints:
  - GET  /api/messages?recipientId={uid}
  - POST /api/messages
  - POST /api/messages/report
  - GET  /api/admin/reports
  `);
});
