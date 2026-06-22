// ────────────────────────────────────────────────────────────────────
// Firebase config for FCM (Cloud Messaging) — Corpvex Authenticator.
//
// Push is OPTIONAL. The OTP always arrives via the GET poll in app.js, so the
// app is fully functional with these left empty. Fill them only if you want the
// phone to also get a system notification / wake when an OTP is issued.
//
// To enable push:
//   1. Create a Firebase project, add a Web app, copy its web config here.
//   2. Cloud Messaging → generate a Web Push (VAPID) key pair → paste the
//      PUBLIC key as vapidKey.
//   3. The server-side service-account JSON stays a Supabase Edge Function
//      secret (FIREBASE_SERVICE_ACCOUNT) — never put it in this file.
// ────────────────────────────────────────────────────────────────────
self.FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: 'corpvex',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: '',
  vapidKey: ''
};
