import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { AppSettings, SavedAddress, TravelStyle } from '../types/trip';
import {
  clampInt,
  clampNumber,
  OperationType,
  handleFirestoreError,
  sanitizeGeoPoint,
  sanitizeNotesList,
  sanitizeTimeHHMM,
  stripUndefined,
  toIsoString,
  toValidFirestoreId,
} from './firestoreHelpers';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  budgetWarningThresholdPct: 90,
  enableConflictDetection: true,
  autoSortByTime: true,
  defaultDayStartTime: '08:30',
};

const VALID_STYLES: TravelStyle[] = ['Adventure', 'Relaxed', 'Balanced', 'Custom'];

function sanitizeSettingsPayload(
  patch: Partial<AppSettings>,
  base: AppSettings = DEFAULT_APP_SETTINGS
): AppSettings {
  return {
    budgetWarningThresholdPct: clampNumber(
      patch.budgetWarningThresholdPct ?? base.budgetWarningThresholdPct,
      50,
      100,
      90
    ),
    enableConflictDetection:
      typeof patch.enableConflictDetection === 'boolean'
        ? patch.enableConflictDetection
        : base.enableConflictDetection,
    autoSortByTime:
      typeof patch.autoSortByTime === 'boolean'
        ? patch.autoSortByTime
        : base.autoSortByTime,
    defaultDayStartTime: sanitizeTimeHHMM(
      patch.defaultDayStartTime ?? base.defaultDayStartTime,
      '08:30'
    ),
  };
}

function mapDocToSettings(data: Record<string, unknown>): AppSettings {
  return sanitizeSettingsPayload({
    budgetWarningThresholdPct: Number(data.budgetWarningThresholdPct),
    enableConflictDetection: Boolean(data.enableConflictDetection),
    autoSortByTime: Boolean(data.autoSortByTime),
    defaultDayStartTime:
      typeof data.defaultDayStartTime === 'string' ? data.defaultDayStartTime : undefined,
  });
}

function mapDocToSavedAddress(data: Record<string, unknown>): SavedAddress | null {
  if (typeof data.label !== 'string' || typeof data.formattedAddress !== 'string') {
    return null;
  }
  const geo = sanitizeGeoPoint(data.location);
  return {
    label: data.label,
    formattedAddress: data.formattedAddress,
    city: typeof data.city === 'string' && data.city.trim() ? data.city : undefined,
    placeId: typeof data.placeId === 'string' && data.placeId.trim() ? data.placeId : undefined,
    location: geo,
    updatedAt: toIsoString(data.updatedAt),
  };
}

export async function loadOrInitUserSettings(uid: string): Promise<AppSettings> {
  const path = `users/${uid}/settings/preferences`;
  const ref = doc(db, 'users', uid, 'settings', 'preferences');

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    return mapDocToSettings(snap.data() as Record<string, unknown>);
  }

  const defaults = sanitizeSettingsPayload(DEFAULT_APP_SETTINGS);
  try {
    await setDoc(ref, {
      userId: uid,
      ...defaults,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return defaults;
}

export function subscribeToUserSettings(
  uid: string,
  onData: (settings: AppSettings) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${uid}/settings/preferences`;
  const ref = doc(db, 'users', uid, 'settings', 'preferences');

  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onData(DEFAULT_APP_SETTINGS);
        return;
      }
      onData(mapDocToSettings(snap.data() as Record<string, unknown>));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

export async function saveUserSettings(
  uid: string,
  nextSettings: AppSettings
): Promise<AppSettings> {
  const path = `users/${uid}/settings/preferences`;
  const ref = doc(db, 'users', uid, 'settings', 'preferences');
  const sanitized = sanitizeSettingsPayload(nextSettings);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    try {
      await updateDoc(ref, {
        ...sanitized,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(ref, {
        userId: uid,
        ...sanitized,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  return sanitized;
}

export async function loadUserSavedAddress(uid: string): Promise<SavedAddress | null> {
  const path = `users/${uid}/addresses/home`;
  const ref = doc(db, 'users', uid, 'addresses', 'home');

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return mapDocToSavedAddress(snap.data() as Record<string, unknown>);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export function subscribeToUserSavedAddress(
  uid: string,
  onData: (address: SavedAddress | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${uid}/addresses/home`;
  const ref = doc(db, 'users', uid, 'addresses', 'home');

  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      onData(mapDocToSavedAddress(snap.data() as Record<string, unknown>));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

export async function saveUserAddressInFirestore(
  uid: string,
  address: SavedAddress
): Promise<SavedAddress> {
  const path = `users/${uid}/addresses/home`;
  const ref = doc(db, 'users', uid, 'addresses', 'home');

  const label = (address.label || address.formattedAddress || 'Home').trim().slice(0, 160) || 'Home';
  const formattedAddress =
    (address.formattedAddress || address.label || 'Saved Address').trim().slice(0, 300) ||
    'Saved Address';
  const city = address.city?.trim().slice(0, 120) || undefined;
  const placeId = address.placeId?.trim().slice(0, 200) || undefined;
  const geo = sanitizeGeoPoint(address.location);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const fields = stripUndefined({
    label,
    formattedAddress,
    city: city || null,
    placeId: placeId || null,
    location: geo || null,
    updatedAt: serverTimestamp(),
  });

  if (snap.exists()) {
    try {
      await updateDoc(ref, fields);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(
        ref,
        stripUndefined({
          userId: uid,
          ...fields,
          createdAt: serverTimestamp(),
        })
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  return {
    label,
    formattedAddress,
    city,
    placeId,
    location: geo,
    updatedAt: new Date().toISOString(),
  };
}

export async function saveActiveTripIdInFirestore(
  uid: string,
  activeTripId: string | null
): Promise<void> {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);
  const cleanId = activeTripId ? toValidFirestoreId(activeTripId, 'trip') : null;

  try {
    await updateDoc(ref, {
      activeTripId: cleanId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function syncTravelPreferencesInFirestore(
  uid: string,
  prefs: {
    defaultTravelStyle?: TravelStyle;
    homeCity?: string;
    preferredNotes?: string[];
    maxHotelRadiusKm?: number;
    waitingBufferMinutes?: number;
  }
): Promise<void> {
  const path = `users/${uid}/preferences/default`;
  const ref = doc(db, 'users', uid, 'preferences', 'default');

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const style: TravelStyle =
    prefs.defaultTravelStyle && VALID_STYLES.includes(prefs.defaultTravelStyle)
      ? prefs.defaultTravelStyle
      : 'Balanced';
  const homeCity = (prefs.homeCity || 'Bengaluru').trim().slice(0, 120) || 'Bengaluru';
  const preferredNotes = sanitizeNotesList(prefs.preferredNotes, ['Local food experiences']);

  if (snap.exists()) {
    const updatePayload = stripUndefined({
      defaultTravelStyle: prefs.defaultTravelStyle ? style : undefined,
      homeCity: prefs.homeCity ? homeCity : undefined,
      preferredNotes: prefs.preferredNotes ? preferredNotes : undefined,
      maxHotelRadiusKm:
        prefs.maxHotelRadiusKm !== undefined
          ? clampNumber(prefs.maxHotelRadiusKm, 1, 100, 10)
          : undefined,
      waitingBufferMinutes:
        prefs.waitingBufferMinutes !== undefined
          ? clampInt(prefs.waitingBufferMinutes, 0, 180, 15)
          : undefined,
      updatedAt: serverTimestamp(),
    });
    try {
      await updateDoc(ref, updatePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(ref, {
        userId: uid,
        defaultTravelStyle: style,
        homeCity,
        preferredNotes,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}
