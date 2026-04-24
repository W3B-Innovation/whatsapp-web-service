const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // I'll assume it exists or use app-default

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function run() {
  const snapshot = await db.collection('business_conversations')
    .orderBy('lastTimestamp', 'desc')
    .limit(3)
    .get();

  snapshot.forEach(doc => {
    console.log(`\n\n=== DOC ID: ${doc.id} ===`);
    console.log(JSON.stringify(doc.data(), null, 2));
  });
  process.exit();
}

run();
