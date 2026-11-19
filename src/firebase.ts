import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { Auth, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, Firestore, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db: Firestore = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth: Auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
export { app };

let connectionTested = false;

export async function testFirestoreConnection(): Promise<{
  connected: boolean;
  exists?: boolean;
  errorCode?: string;
  errorMessage?: string;
}> {
  try {
    const snap = await getDocFromServer(doc(db, 'test', 'connection'));
    return { connected: true, exists: snap.exists() };
  } catch (error) {
    const errObj = error as { code?: string; message?: string };
    const message = errObj?.message || String(error);
    if (message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return { connected: false, errorCode: errObj?.code || 'unavailable', errorMessage: message };
    }
    return {
      connected: true,
      errorCode: errObj?.code,
      errorMessage: message,
    };
  }
}

if (typeof window !== 'undefined' && !connectionTested) {
  connectionTested = true;
  void testFirestoreConnection();
}
