import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile as firebaseUpdateProfile,
  User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

export interface AuthActionResult {
  ok: boolean;
  error?: string;
  needsVerification?: boolean;
  email?: string;
}

export function isVerifiedFirebaseUser(firebaseUser: User | null): boolean {
  if (!firebaseUser) return false;
  if (firebaseUser.emailVerified) return true;
  return firebaseUser.providerData.some((p) => p.providerId === 'google.com');
}

export function mapFirebaseAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email address already exists. Please sign in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password must be at least 6 characters long.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return 'Incorrect email or password. Please check your details and try again.';
    case 'auth/user-not-found':
      return 'No traveler account was found with that email address.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact support.';
    case 'auth/too-many-requests':
      return 'Too many attempts detected. Please wait a few minutes and try again.';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in popup was closed before signing in.';
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled because another popup was opened.';
    case 'auth/popup-blocked':
      return 'Google sign-in popup was blocked by your browser. Please allow popups for this site.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with this email using a different sign-in method.';
    case 'auth/network-request-failed':
      return 'Network error while contacting Firebase. Please check your connection.';
    case 'auth/missing-email':
      return 'Please enter your email address.';
    default: {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg && !msg.startsWith('Firebase:')) return msg;
      return 'Authentication failed. Please try again.';
    }
  }
}

export async function signUpWithEmail(
  name: string,
  email: string,
  password: string
): Promise<AuthActionResult> {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();

  if (trimmedName.length < 2) {
    return { ok: false, error: 'Please enter your full name (at least 2 characters).' };
  }
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (password.length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters.' };
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
    await firebaseUpdateProfile(cred.user, { displayName: trimmedName });
    await sendEmailVerification(cred.user);
    await signOut(auth);
    return {
      ok: true,
      needsVerification: true,
      email: trimmedEmail,
    };
  } catch (error) {
    return { ok: false, error: mapFirebaseAuthError(error) };
  }
}

export async function signInWithEmail(
  email: string,
  password: string,
  rememberMe = true
): Promise<{ result: AuthActionResult; user?: User }> {
  const trimmedEmail = email.trim();

  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { result: { ok: false, error: 'Please enter a valid email address.' } };
  }
  if (password.length < 6) {
    return { result: { ok: false, error: 'Password must be at least 6 characters.' } };
  }

  try {
    await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
    const cred = await signInWithEmailAndPassword(auth, trimmedEmail, password);

    if (!cred.user.emailVerified) {
      await signOut(auth);
      return {
        result: {
          ok: false,
          needsVerification: true,
          email: trimmedEmail,
          error:
            'Your email address is not verified yet. Please click the verification link sent to your inbox, or resend the verification email below.',
        },
      };
    }

    return { result: { ok: true, email: trimmedEmail }, user: cred.user };
  } catch (error) {
    return { result: { ok: false, error: mapFirebaseAuthError(error) } };
  }
}

export async function resendVerificationForCredentials(
  email: string,
  password: string
): Promise<AuthActionResult> {
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { ok: false, error: 'Please enter your registered email address.' };
  }
  if (!password || password.length < 6) {
    return {
      ok: false,
      error: 'Please enter your password in the Sign In form to resend the verification email.',
    };
  }

  try {
    const cred = await signInWithEmailAndPassword(auth, trimmedEmail, password);
    if (cred.user.emailVerified) {
      return { ok: true, email: trimmedEmail };
    }
    await sendEmailVerification(cred.user);
    await signOut(auth);
    return { ok: true, needsVerification: true, email: trimmedEmail };
  } catch (error) {
    return { ok: false, error: mapFirebaseAuthError(error) };
  }
}

export async function signInWithGooglePopup(): Promise<{ result: AuthActionResult; user?: User }> {
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithPopup(auth, googleProvider);
    return { result: { ok: true, email: cred.user.email || undefined }, user: cred.user };
  } catch (error) {
    return { result: { ok: false, error: mapFirebaseAuthError(error) } };
  }
}

export async function sendPasswordReset(email: string): Promise<AuthActionResult> {
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { ok: false, error: 'Please enter a valid registered email address.' };
  }

  try {
    await sendPasswordResetEmail(auth, trimmedEmail);
    return { ok: true, email: trimmedEmail };
  } catch (error) {
    return { ok: false, error: mapFirebaseAuthError(error) };
  }
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}
