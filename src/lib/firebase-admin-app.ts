/**
 * Shared Firebase Admin bootstrap for push + owner reconnect (ID token verify).
 * Requires ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS)
 * for the same Firebase project the Admin app signs into (route47-admin).
 */

let firebaseAdmin: typeof import("firebase-admin") | null = null;
let firebaseInitAttempted = false;

export async function getFirebaseAdminApp() {
  if (firebaseInitAttempted) return firebaseAdmin;
  firebaseInitAttempted = true;

  const json = process.env.ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!json && !path) {
    return null;
  }

  try {
    const admin = await import("firebase-admin");
    if (admin.apps.length === 0) {
      if (json) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(json) as import("firebase-admin").ServiceAccount),
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
      }
    }
    firebaseAdmin = admin;
    return admin;
  } catch (error) {
    console.warn("Firebase Admin SDK unavailable.", error);
    return null;
  }
}

export async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  name: string;
} | null> {
  const token = idToken.trim();
  if (!token || token.split(".").length !== 3) return null;

  const admin = await getFirebaseAdminApp();
  if (!admin) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: (decoded.email ?? "").trim(),
      name: (decoded.name ?? decoded.email ?? "Owner").trim() || "Owner",
    };
  } catch (error) {
    console.warn("Firebase ID token verification failed.", error);
    return null;
  }
}

export function isFirebaseAdminConfigured(): boolean {
  return Boolean(
    process.env.ROUTE47_FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim(),
  );
}
