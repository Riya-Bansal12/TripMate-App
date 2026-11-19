import { User } from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { TravelStyle, UserProfile } from '../types/trip';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const VALID_STYLES: TravelStyle[] = ['Adventure', 'Relaxed', 'Balanced', 'Custom'];

function sanitizeNotesList(notes?: string[]): string[] {
  if (!Array.isArray(notes) || notes.length === 0) {
    return ['Local food experiences'];
  }
  const cleaned = notes
    .map((n) => (typeof n === 'string' ? n.trim().slice(0, 200) : ''))
    .filter((n) => n.length >= 1)
    .slice(0, 20);
  return cleaned.length > 0 ? cleaned : ['Local food experiences'];
}

function formatTimestamp(val: unknown): string | undefined {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') return val;
  return undefined;
}

function mapDocToUserProfile(
  uid: string,
  data: Record<string, unknown>,
  firebaseUser: User,
  rememberMe: boolean
): UserProfile {
  const rawStyle = data.defaultTravelStyle as TravelStyle;
  const style: TravelStyle = VALID_STYLES.includes(rawStyle) ? rawStyle : 'Balanced';
  return {
    id: uid,
    uid,
    name:
      (typeof data.name === 'string' && data.name.trim()) ||
      firebaseUser.displayName ||
      firebaseUser.email?.split('@')[0] ||
      'Traveler',
    email:
      (typeof data.email === 'string' && data.email.trim()) ||
      firebaseUser.email ||
      '',
    homeCity:
      (typeof data.homeCity === 'string' && data.homeCity.trim()) || 'Bengaluru',
    defaultTravelStyle: style,
    preferredNotes: Array.isArray(data.preferredNotes)
      ? (data.preferredNotes as string[])
      : ['Local food experiences'],
    activeTripId:
      typeof data.activeTripId === 'string' && data.activeTripId.trim()
        ? data.activeTripId
        : null,
    photoURL:
      typeof data.photoURL === 'string'
        ? data.photoURL
        : firebaseUser.photoURL || null,
    authProvider:
      (typeof data.authProvider === 'string' && data.authProvider) ||
      firebaseUser.providerData?.[0]?.providerId ||
      'password',
    rememberMe,
    createdAt: formatTimestamp(data.createdAt),
    updatedAt: formatTimestamp(data.updatedAt),
  };
}

export async function ensureUserProfile(
  firebaseUser: User,
  options?: { rememberMe?: boolean; homeCity?: string }
): Promise<UserProfile> {
  const uid = firebaseUser.uid;
  const path = `users/${uid}`;
  const docRef = doc(db, 'users', uid);
  const rememberMe = options?.rememberMe ?? true;

  let snap;
  try {
    snap = await getDoc(docRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    return mapDocToUserProfile(
      uid,
      snap.data() as Record<string, unknown>,
      firebaseUser,
      rememberMe
    );
  }

  const fallbackName =
    firebaseUser.email?.split('@')[0]?.replace(/[._-]/g, ' ') || 'Traveler';
  const safeName = (firebaseUser.displayName || fallbackName).trim().slice(0, 120) || 'Traveler';
  const safeEmail = (firebaseUser.email || '').trim().slice(0, 254);
  const safeHomeCity =
    (options?.homeCity?.trim() || 'Bengaluru').slice(0, 120) || 'Bengaluru';
  const safeProvider = (
    firebaseUser.providerData?.[0]?.providerId || 'password'
  )
    .trim()
    .slice(0, 64) || 'password';

  const payload: Record<string, unknown> = {
    uid,
    name: safeName,
    email: safeEmail,
    homeCity: safeHomeCity,
    defaultTravelStyle: 'Balanced',
    preferredNotes: ['Local food experiences'],
    authProvider: safeProvider,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (firebaseUser.photoURL) {
    payload.photoURL = firebaseUser.photoURL.slice(0, 1000);
  }

  try {
    await setDoc(docRef, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return {
    id: uid,
    uid,
    name: safeName,
    email: safeEmail,
    homeCity: safeHomeCity,
    defaultTravelStyle: 'Balanced',
    preferredNotes: ['Local food experiences'],
    photoURL: firebaseUser.photoURL || null,
    authProvider: safeProvider,
    rememberMe,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateUserProfileDoc(
  uid: string,
  patch: Partial<
    Pick<
      UserProfile,
      'name' | 'email' | 'homeCity' | 'defaultTravelStyle' | 'preferredNotes' | 'photoURL'
    >
  >
): Promise<void> {
  const path = `users/${uid}`;
  const docRef = doc(db, 'users', uid);

  const sanitized: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (patch.name !== undefined) {
    const cleanName = patch.name.trim().slice(0, 120);
    if (cleanName.length >= 1) sanitized.name = cleanName;
  }
  if (patch.email !== undefined) {
    const cleanEmail = patch.email.trim().slice(0, 254);
    if (cleanEmail.length >= 3) sanitized.email = cleanEmail;
  }
  if (patch.homeCity !== undefined) {
    const cleanCity = patch.homeCity.trim().slice(0, 120);
    if (cleanCity.length >= 1) sanitized.homeCity = cleanCity;
  }
  if (patch.defaultTravelStyle !== undefined && VALID_STYLES.includes(patch.defaultTravelStyle)) {
    sanitized.defaultTravelStyle = patch.defaultTravelStyle;
  }
  if (patch.preferredNotes !== undefined) {
    sanitized.preferredNotes = sanitizeNotesList(patch.preferredNotes);
  }
  if (patch.photoURL !== undefined) {
    sanitized.photoURL = patch.photoURL ? patch.photoURL.slice(0, 1000) : null;
  }

  try {
    await updateDoc(docRef, sanitized);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
