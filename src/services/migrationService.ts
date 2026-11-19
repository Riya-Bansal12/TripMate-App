import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { AppSettings, SavedAddress, Trip } from '../types/trip';
import {
  handleFirestoreError,
  OperationType,
  toValidFirestoreId,
} from './firestoreHelpers';
import {
  loadUserSavedAddress,
  saveActiveTripIdInFirestore,
  saveUserAddressInFirestore,
  saveUserSettings,
} from './settingsService';
import { createTripInFirestore, loadTripSubcollections } from './tripService';

export const LEGACY_STORAGE_KEYS = {
  TRIPS: 'tripmate_trips_v1',
  ACTIVE_TRIP_ID: 'tripmate_active_trip_id_v1',
  SETTINGS: 'tripmate_settings_v1',
  USER_ADDRESS: 'tripmate_user_address_v1',
};

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface MigrationCounts {
  trips: number;
  activities: number;
  dayPlans: number;
  budgets: number;
  expenses: number;
  hasSettings: boolean;
  hasAddress: boolean;
}

export interface MigrationCandidate {
  trips: Trip[];
  activeTripId: string | null;
  settings: AppSettings | null;
  userAddress: SavedAddress | null;
  counts: MigrationCounts;
}

export interface MigrationRecord {
  status: 'completed' | 'dismissed';
  migratedTripsCount: number;
  migratedActivitiesCount: number;
  migratedDayPlansCount: number;
  migratedBudgetsCount: number;
  migratedExpensesCount: number;
}

export interface MigrationExecutionResult {
  ok: boolean;
  error?: string;
  skippedDuplicateTrips: number;
  verifiedCounts: MigrationCounts;
}

function getDefaultStorage(): StorageLike | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function inspectLocalStorageMigrationCandidate(
  storageOverride?: StorageLike | null
): MigrationCandidate | null {
  const storage = storageOverride ?? getDefaultStorage();
  if (!storage) return null;

  const rawTrips = safeParseJson<unknown>(storage.getItem(LEGACY_STORAGE_KEYS.TRIPS));
  const trips: Trip[] = Array.isArray(rawTrips)
    ? rawTrips.filter(
        (item): item is Trip =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as Trip).id === 'string' &&
          typeof (item as Trip).destination === 'string'
      )
    : [];

  const activeTripId = storage.getItem(LEGACY_STORAGE_KEYS.ACTIVE_TRIP_ID) || null;
  const rawSettings = safeParseJson<AppSettings>(
    storage.getItem(LEGACY_STORAGE_KEYS.SETTINGS)
  );
  const rawAddress = safeParseJson<SavedAddress>(
    storage.getItem(LEGACY_STORAGE_KEYS.USER_ADDRESS)
  );

  const hasSettings = Boolean(
    rawSettings && typeof rawSettings === 'object' && typeof rawSettings.budgetWarningThresholdPct === 'number'
  );
  const hasAddress = Boolean(
    rawAddress && typeof rawAddress === 'object' && typeof rawAddress.formattedAddress === 'string' && rawAddress.formattedAddress.trim()
  );

  if (trips.length === 0 && !hasSettings && !hasAddress) {
    return null;
  }

  const activities = trips.reduce(
    (sum, t) => sum + (Array.isArray(t.activities) ? t.activities.length : 0),
    0
  );
  const dayPlans = trips.reduce(
    (sum, t) => sum + (Array.isArray(t.dayPlans) ? t.dayPlans.length : 0),
    0
  );
  const expenses = trips.reduce(
    (sum, t) => sum + (Array.isArray(t.actualExpenses) ? t.actualExpenses.length : 0),
    0
  );

  return {
    trips,
    activeTripId,
    settings: hasSettings ? rawSettings : null,
    userAddress: hasAddress ? rawAddress : null,
    counts: {
      trips: trips.length,
      activities,
      dayPlans,
      budgets: trips.length,
      expenses,
      hasSettings,
      hasAddress,
    },
  };
}

export async function getMigrationRecord(uid: string): Promise<MigrationRecord | null> {
  const path = `users/${uid}/migrations/localStorage_v1`;
  const ref = doc(db, 'users', uid, 'migrations', 'localStorage_v1');

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    return {
      status: data.status === 'dismissed' ? 'dismissed' : 'completed',
      migratedTripsCount: Number(data.migratedTripsCount) || 0,
      migratedActivitiesCount: Number(data.migratedActivitiesCount) || 0,
      migratedDayPlansCount: Number(data.migratedDayPlansCount) || 0,
      migratedBudgetsCount: Number(data.migratedBudgetsCount) || 0,
      migratedExpensesCount: Number(data.migratedExpensesCount) || 0,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

async function saveMigrationRecord(uid: string, record: MigrationRecord): Promise<void> {
  const path = `users/${uid}/migrations/localStorage_v1`;
  const ref = doc(db, 'users', uid, 'migrations', 'localStorage_v1');

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    try {
      await updateDoc(ref, {
        ...record,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(ref, {
        userId: uid,
        ...record,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}

export async function dismissMigrationPrompt(uid: string): Promise<void> {
  await saveMigrationRecord(uid, {
    status: 'dismissed',
    migratedTripsCount: 0,
    migratedActivitiesCount: 0,
    migratedDayPlansCount: 0,
    migratedBudgetsCount: 0,
    migratedExpensesCount: 0,
  });
}

export function clearMigratedLocalStorageKeys(storageOverride?: StorageLike | null): void {
  const storage = storageOverride ?? getDefaultStorage();
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_STORAGE_KEYS.TRIPS);
    storage.removeItem(LEGACY_STORAGE_KEYS.ACTIVE_TRIP_ID);
    storage.removeItem(LEGACY_STORAGE_KEYS.SETTINGS);
    storage.removeItem(LEGACY_STORAGE_KEYS.USER_ADDRESS);
  } catch {
    // ignore storage removal errors
  }
}

export async function migrateLocalStorageToFirestore(
  uid: string,
  options?: { storage?: StorageLike | null }
): Promise<MigrationExecutionResult> {
  const storage = options?.storage ?? getDefaultStorage();
  const candidate = inspectLocalStorageMigrationCandidate(storage);

  if (!candidate) {
    return {
      ok: true,
      skippedDuplicateTrips: 0,
      verifiedCounts: {
        trips: 0,
        activities: 0,
        dayPlans: 0,
        budgets: 0,
        expenses: 0,
        hasSettings: false,
        hasAddress: false,
      },
    };
  }

  try {
    // 1. Check existing Firestore trips so re-running migration never duplicates data
    const existingTripsSnap = await getDocs(
      query(collection(db, 'users', uid, 'trips'), where('userId', '==', uid))
    ).catch((err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/trips`));

    const existingTripIds = new Set(existingTripsSnap.docs.map((d) => d.id));
    let skippedDuplicateTrips = 0;

    const newlyMigratedExpectations: {
      tripId: string;
      expectedActivities: number;
      expectedDayPlans: number;
      expectedExpenses: number;
    }[] = [];

    for (const localTrip of candidate.trips) {
      const sanitizedTripId = toValidFirestoreId(localTrip.id, 'trip');
      if (existingTripIds.has(sanitizedTripId)) {
        skippedDuplicateTrips += 1;
        continue;
      }

      const created = await createTripInFirestore(uid, {
        ...localTrip,
        id: sanitizedTripId,
      });

      existingTripIds.add(created.id);
      newlyMigratedExpectations.push({
        tripId: created.id,
        expectedActivities: created.activities.length,
        expectedDayPlans: created.dayPlans.length,
        expectedExpenses: (created.actualExpenses || []).length,
      });
    }

    // 2. Migrate settings & saved address (preserve existing cloud address if already saved)
    if (candidate.settings) {
      await saveUserSettings(uid, candidate.settings);
    }
    if (candidate.userAddress) {
      const existingAddr = await loadUserSavedAddress(uid);
      if (!existingAddr) {
        await saveUserAddressInFirestore(uid, candidate.userAddress);
      }
    }

    // 3. Migrate activeTripId if user profile doesn't have one yet
    if (candidate.activeTripId) {
      const userRef = doc(db, 'users', uid);
      const userSnap = await getDoc(userRef).catch((err) =>
        handleFirestoreError(err, OperationType.GET, `users/${uid}`)
      );
      const currentActive = userSnap.exists() ? userSnap.data()?.activeTripId : null;
      const cleanLocalActive = toValidFirestoreId(candidate.activeTripId, 'trip');
      if (!currentActive && existingTripIds.has(cleanLocalActive)) {
        await saveActiveTripIdInFirestore(uid, cleanLocalActive);
      }
    }

    // 4. Verify every newly migrated trip + subcollections exist in Firestore before deleting localStorage
    let verifiedTrips = 0;
    let verifiedActivities = 0;
    let verifiedDayPlans = 0;
    let verifiedBudgets = 0;
    let verifiedExpenses = 0;

    for (const exp of newlyMigratedExpectations) {
      const tripSnap = await getDoc(doc(db, 'users', uid, 'trips', exp.tripId)).catch((err) =>
        handleFirestoreError(err, OperationType.GET, `users/${uid}/trips/${exp.tripId}`)
      );
      if (!tripSnap.exists()) {
        throw new Error(`Migration verification failed: trip ${exp.tripId} was not persisted.`);
      }

      const sub = await loadTripSubcollections(uid, exp.tripId);
      if (
        sub.activities.length < exp.expectedActivities ||
        sub.dayPlans.length < exp.expectedDayPlans ||
        !sub.budget ||
        sub.actualExpenses.length < exp.expectedExpenses
      ) {
        throw new Error(
          `Migration verification failed: incomplete subcollections for trip ${exp.tripId}.`
        );
      }

      verifiedTrips += 1;
      verifiedActivities += sub.activities.length;
      verifiedDayPlans += sub.dayPlans.length;
      verifiedBudgets += 1;
      verifiedExpenses += sub.actualExpenses.length;
    }

    // 5. Record verified completion & ONLY NOW clear migrated localStorage keys
    await saveMigrationRecord(uid, {
      status: 'completed',
      migratedTripsCount: verifiedTrips,
      migratedActivitiesCount: verifiedActivities,
      migratedDayPlansCount: verifiedDayPlans,
      migratedBudgetsCount: verifiedBudgets,
      migratedExpensesCount: verifiedExpenses,
    });

    clearMigratedLocalStorageKeys(storage);

    return {
      ok: true,
      skippedDuplicateTrips,
      verifiedCounts: {
        trips: verifiedTrips,
        activities: verifiedActivities,
        dayPlans: verifiedDayPlans,
        budgets: verifiedBudgets,
        expenses: verifiedExpenses,
        hasSettings: candidate.counts.hasSettings,
        hasAddress: candidate.counts.hasAddress,
      },
    };
  } catch (error) {
    // CRITICAL: Do NOT clear localStorage on failure!
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Migration failed. Your local browser data remains safely intact.',
      skippedDuplicateTrips: 0,
      verifiedCounts: {
        trips: 0,
        activities: 0,
        dayPlans: 0,
        budgets: 0,
        expenses: 0,
        hasSettings: false,
        hasAddress: false,
      },
    };
  }
}
