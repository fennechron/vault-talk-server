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
  doc, updateDoc, increment, writeBatch, getDoc, setDoc
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manual .env loader
const envPath = path.resolve(__dirname, './.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split(/\r?\n/).forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      if (key && value) {
        process.env[key] = value;
        console.log(`[ENV] Loaded: ${key}`);
      }
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

// Debugging: Log partial config (masking sensitive bits)
console.log('Firebase Config Debug:');
console.log('- Project ID:', process.env.VITE_FIREBASE_PROJECT_ID);
console.log('- App ID:', process.env.VITE_FIREBASE_APP_ID ? 'Exists (starts with ' + process.env.VITE_FIREBASE_APP_ID.substring(0, 5) + '...)' : 'MISSING');

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const app = express();
const PORT = process.env.PORT || 3000;
const ENCRYPTION_KEY = process.env.VITE_ENCRYPTION_KEY || 'whisp-default-secret-key';

// Middleware
app.use(cors({
  origin: [
    'https://whisp.fennechron.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

/**
 * Hashes the sender ID using HMAC-SHA256 with the encryption key as salt.
 * Used for notification bucket identifiers.
 */
const hashSenderId = (id) => {
  if (!id || id === 'anonymous') return 'anonymous';
  return CryptoJS.HmacSHA256(id, ENCRYPTION_KEY).toString();
};

/**
 * Encrypts the sender ID using AES.
 */
const encryptSenderId = (id) => {
  if (!id || id === 'anonymous') return 'anonymous';
  return CryptoJS.AES.encrypt(id, ENCRYPTION_KEY).toString();
};

/**
 * Decrypts any AES encrypted string.
 */
const decrypt = (ciphertext) => {
  if (!ciphertext || ciphertext === 'anonymous') return ciphertext;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted || ciphertext;
  } catch (err) {
    return ciphertext;
  }
};

/**
 * Decrypts the sender ID using AES.
 * Fallbacks to original ciphertext if decryption fails (supports legacy data).
 */
const decryptSenderId = (ciphertext) => {
  return decrypt(ciphertext);
};

/**
 * Admin authentication middleware.
 */
const isAdmin = (req, res, next) => {
  const adminPassword = req.headers['authorization'];
  if (adminPassword === process.env.ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Admin access required' });
  }
};

/**
 * Checks if a user is blocked.
 */
const isUserBlocked = async (userId) => {
  if (!userId || userId === 'anonymous') return false;
  try {
    const decryptedId = decryptSenderId(userId);
    const infractionRef = doc(db, 'infractions', decryptedId);
    const infractionSnap = await getDoc(infractionRef);
    if (infractionSnap.exists()) {
      return infractionSnap.data().isBlocked === true;
    }
  } catch (error) {
    console.error('Error checking block status:', error);
  }
  return false;
};

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
      .map(doc => {
        const data = doc.data();
        // Remove senderId from the data returned to the receiver
        const { senderId, ...rest } = data;
        return { id: doc.id, ...rest };
      })
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

  // Check if sender is blocked
  if (await isUserBlocked(senderId)) {
    return res.status(403).json({ error: 'Your account has been disabled due to violations of community standards.' });
  }

  try {
    // Encrypt the message text
    const encryptedText = CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();

    const newMessage = {
      recipientId,
      senderId: encryptSenderId(senderId),
      text: encryptedText,
      replyToId: replyToId || null,
      createdAt: serverTimestamp(),
      isReported: false,
      isLiked: false,
      viewed: false,
      reaction: null
    };

    const docRef = await addDoc(collection(db, 'messages', recipientId, 'inbox'), newMessage);
    console.log(`[POST] New encrypted message stored in Firestore subcollection: ${docRef.id}`);

    // Removed reply tracking logic

    const { senderId: _, ...safeMessage } = newMessage;
    res.status(201).json({ id: docRef.id, ...safeMessage });
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
    // 1. Fetch the original message to get the true senderId
    const originalMsgRef = doc(db, 'messages', recipientId, 'inbox', messageId);
    const originalMsgSnap = await getDoc(originalMsgRef);

    if (!originalMsgSnap.exists()) {
      return res.status(404).json({ error: 'Original message not found' });
    }

    const { senderId: originalSenderId, "send id": altSenderId, text: originalEncryptedText } = originalMsgSnap.data();

    // Use 'send id' if senderId is missing, as per user's request
    const encryptedIdToDecrypt = originalSenderId || altSenderId;

    console.log(`[REPORT DEBUG] Original Message Data:`, originalMsgSnap.data());
    console.log(`[REPORT DEBUG] Found senderId: ${originalSenderId}, Found send id: ${altSenderId}`);

    const decryptedSenderId = decryptSenderId(encryptedIdToDecrypt);
    const decryptedText = decrypt(originalEncryptedText); // Decrypt from source of truth

    const reportDoc = {
      messageId,
      recipientId,
      senderId: decryptedSenderId || 'anonymous',
      text: decryptedText || 'encrypted',
      reportedAt: serverTimestamp(),
    };

    const docRef = await addDoc(collection(db, 'reported'), reportDoc);

    // Update original message to show it is reported
    try {
      await updateDoc(originalMsgRef, { isReported: true });
      console.log(`[POST] Marked message ${messageId} as reported in inbox of user ${recipientId}`);
    } catch (err) {
      console.error(`Failed to mark original message ${messageId} as reported:`, err);
    }

    console.log('\n--- URGENT: MESSAGE REPORTED ---');
    console.log(`Report ID: ${docRef.id}`);
    console.log(`Original Message ID: ${messageId}`);
    console.log(`Recipient: ${recipientId}`);
    console.log(`Sender (Decrypted): ${reportDoc.senderId}`);
    console.log(`Message Content (Decrypted): ${decryptedText}`);
    console.log('--------------------------------\n');

    res.status(201).json({ id: docRef.id, ...reportDoc });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages/report):', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

/**
 * GET /api/my-infractions
 * Allows a user to check their own warning/block status.
 * Query: ?userId={id} (email or tempId)
 */
app.get('/api/my-infractions', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const infractionRef = doc(db, 'infractions', userId);
    const docSnap = await getDoc(infractionRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      res.json({
        warnings: data.warnings || 0,
        isBlocked: data.isBlocked || false
      });
    } else {
      res.json({ warnings: 0, isBlocked: false });
    }
  } catch (error) {
    console.error('Error fetching my infractions:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

/**
 * GET /api/admin/reports
 * Fetches all reported messages for administrative review.
 */
app.get('/api/admin/reports', isAdmin, async (req, res) => {
  try {
    const q = query(
      collection(db, 'reported'),
      orderBy('reportedAt', 'desc')
    );

    const snapshot = await getDocs(q);
    const reports = await Promise.all(snapshot.docs.map(async (docSnap) => {
      const data = docSnap.data();
      let senderId = data.senderId;
      let text = data.text;

      // Try to fetch latest sender info from original message if current is anonymous or missing
      try {
        const originalMsgRef = doc(db, 'messages', data.recipientId, 'inbox', data.messageId);
        const originalMsgSnap = await getDoc(originalMsgRef);
        if (originalMsgSnap.exists()) {
          const msgData = originalMsgSnap.data();
          const encryptedId = msgData.senderId || msgData["send id"];
          if (encryptedId && encryptedId !== 'anonymous') {
            senderId = decryptSenderId(encryptedId);
          }
          const encryptedText = msgData.text;
          if (encryptedText) {
            text = decrypt(encryptedText);
          }
        }
      } catch (err) {
        console.error(`Error enriching report ${docSnap.id}:`, err);
      }

      return { id: docSnap.id, ...data, senderId, text };
    }));

    console.log(`[GET] Fetched and enriched ${reports.length} reports for admin review.`);
    res.json(reports);
  } catch (error) {
    console.error('Firestore Error (GET /api/admin/reports):', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

/**
 * POST /api/admin/warning
 * Increments the warning count for a user.
 */
app.post('/api/admin/warning', isAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const infractionRef = doc(db, 'infractions', userId);
    const infractionSnap = await getDoc(infractionRef);

    if (infractionSnap.exists()) {
      await updateDoc(infractionRef, {
        warnings: increment(1),
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(infractionRef, {
        warnings: 1,
        isBlocked: false,
        updatedAt: serverTimestamp()
      });
    }
    res.json({ success: true, message: 'Warning issued successfully' });
  } catch (error) {
    console.error('Error issuing warning:', error);
    res.status(500).json({ error: 'Failed to issue warning' });
  }
});

/**
 * POST /api/admin/block
 * Blocks a user from sending messages.
 */
app.post('/api/admin/block', isAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const infractionRef = doc(db, 'infractions', userId);
    await setDoc(infractionRef, {
      isBlocked: true,
      updatedAt: serverTimestamp()
    }, { merge: true });
    res.json({ success: true, message: 'User blocked successfully' });
  } catch (error) {
    console.error('Error blocking user:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

/**
 * GET /api/admin/infractions/:userId
 * Fetches infraction data for a specific user.
 */
app.get('/api/admin/infractions/:userId', isAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    const infractionRef = doc(db, 'infractions', userId);
    const docSnap = await getDoc(infractionRef);
    if (docSnap.exists()) {
      res.json(docSnap.data());
    } else {
      res.json({ warnings: 0, isBlocked: false });
    }
  } catch (error) {
    console.error('Error fetching infractions:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

/**
 * POST /api/messages/like
 * Increments the like count for a specific message.
 * Body: { recipientId, messageId }
 */
app.post('/api/messages/like', async (req, res) => {
  const { recipientId, messageId } = req.body;

  if (!recipientId || !messageId) {
    return res.status(400).json({ error: 'recipientId and messageId are required' });
  }

  try {
    const msgRef = doc(db, 'messages', recipientId, 'inbox', messageId);
    await updateDoc(msgRef, {
      isLiked: true
    });

    // Create notification for sender
    const msgSnap = await getDoc(msgRef);
    if (msgSnap.exists()) {
      const storedSenderId = msgSnap.data().senderId;
      const originalSenderId = decryptSenderId(storedSenderId);

      if (originalSenderId && originalSenderId !== 'anonymous') {
        const hashedId = hashSenderId(originalSenderId);
        const notifRef = doc(db, 'notifications', hashedId, 'items', messageId);
        await setDoc(notifRef, {
          type: 'like',
          recipientId,
          messageId,
          text: msgSnap.data().text,
          timestamp: serverTimestamp()
        }, { merge: true });
      }
    }

    console.log(`[POST] Message ${messageId} liked in inbox of user ${recipientId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages/like):', error);
    res.status(500).json({ error: 'Failed to like message' });
  }
});

/**
 * POST /api/messages/react
 * Sets an emoji reaction for a specific message.
 * Body: { recipientId, messageId, reaction }
 */
app.post('/api/messages/react', async (req, res) => {
  const { recipientId, messageId, reaction } = req.body;

  if (!recipientId || !messageId || reaction === undefined) {
    return res.status(400).json({ error: 'recipientId, messageId, and reaction are required' });
  }

  try {
    const msgRef = doc(db, 'messages', recipientId, 'inbox', messageId);
    await updateDoc(msgRef, {
      reaction: reaction
    });

    // Create notification for sender
    const msgSnap = await getDoc(msgRef);
    if (msgSnap.exists()) {
      const storedSenderId = msgSnap.data().senderId;
      const originalSenderId = decryptSenderId(storedSenderId);

      if (originalSenderId && originalSenderId !== 'anonymous') {
        const hashedId = hashSenderId(originalSenderId);
        const notifRef = doc(db, 'notifications', hashedId, 'items', messageId);
        await setDoc(notifRef, {
          type: 'reaction',
          reaction: reaction,
          recipientId,
          messageId,
          text: msgSnap.data().text,
          timestamp: serverTimestamp()
        }, { merge: true });
      }
    }

    console.log(`[POST] Message ${messageId} reacted with ${reaction} in inbox of user ${recipientId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages/react):', error);
    res.status(500).json({ error: 'Failed to react to message' });
  }
});

/**
 * POST /api/messages/read-all
 * Marks all messages for a specific recipient as read.
 * Body: { recipientId }
 */
app.post('/api/messages/read-all', async (req, res) => {
  const { recipientId } = req.body;

  if (!recipientId) {
    return res.status(400).json({ error: 'recipientId is required' });
  }

  try {
    const inboxRef = collection(db, 'messages', recipientId, 'inbox');
    const snapshot = await getDocs(inboxRef);

    // Filter for unread messages (missing field or viewed: false)
    const unreadDocs = snapshot.docs.filter(doc => doc.data().viewed !== true);

    if (unreadDocs.length === 0) {
      console.log(`[POST] No unread messages to mark as read for user ${recipientId}`);
      return res.json({ success: true, count: 0 });
    }

    const batch = writeBatch(db);
    unreadDocs.forEach(doc => {
      batch.update(doc.ref, { viewed: true });
    });

    await batch.commit();

    console.log(`[POST] Marked ${unreadDocs.length} messages as read for user ${recipientId}`);
    res.json({ success: true, count: unreadDocs.length });
  } catch (error) {
    console.error('Firestore Error (POST /api/messages/read-all):', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

/**
 * GET /api/notifications
 * Fetches all pending feedback notifications for a sender.
 */
app.get('/api/notifications', async (req, res) => {
  const { senderId } = req.query;

  if (!senderId) {
    return res.status(400).json({ error: 'senderId is required' });
  }

  try {
    const hashedId = hashSenderId(senderId);
    const notifsRef = collection(db, 'notifications', hashedId, 'items');
    const snapshot = await getDocs(notifsRef);
    const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    console.log(`[GET] Fetched ${notifications.length} notifications for sender (hashed) ${hashedId}`);
    res.json(notifications);
  } catch (error) {
    console.error('Firestore Error (GET /api/notifications):', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * DELETE /api/notifications
 * Clears all pending feedback notifications for a sender.
 */
app.delete('/api/notifications', async (req, res) => {
  const { senderId } = req.query;

  if (!senderId) {
    return res.status(400).json({ error: 'senderId is required' });
  }

  try {
    const hashedId = hashSenderId(senderId);
    const notifsRef = collection(db, 'notifications', hashedId, 'items');
    const snapshot = await getDocs(notifsRef);

    const batch = writeBatch(db);
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    console.log(`[DELETE] Cleared ${snapshot.size} notifications for sender (hashed) ${hashedId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Firestore Error (DELETE /api/notifications):', error);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Whisp Backend is running on http://localhost:${PORT}`);
  console.log(`Available Endpoints:
  - GET  /api/messages?recipientId={uid}
  - POST /api/messages
  - POST /api/messages/report
  - POST /api/messages/like
  - GET  /api/admin/reports
  `);
});