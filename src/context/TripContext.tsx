import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Unsubscribe } from 'firebase/firestore';
import { onAuthStateChanged, updateProfile as fbUpdateProfile } from 'firebase/auth';
import {
  Activity,
  ActualExpenseItem,
  AlternativeActivityOption,
  AppNotification,
  AppSettings,
  DayPace,
  ExpenseBucket,
  SavedAddress,
  Trip,
  TripMetrics,
  UserProfile,
  WizardDraft,
} from '../types/trip';
import {
  addMinutesToTime,
  autoResolveDayConflicts,
  calculateTripMetrics,
  findFirstAvailableSlot,
  findOverlappingActivities,
  formatINR,
  minutesToTime,
  parseTimeToMinutes,
  sortActivitiesByTime,
} from '../utils/scheduleUtils';
import {
  createSeededDefaultTrip,
  ItineraryGenerationRequest,
} from '../utils/itineraryGenerator';
import {
  computeHotelToPlaceMetrics,
  enrichAiTripWithHotelMaps,
} from '../utils/hotelItineraryService';
import { haversineDistanceKm } from '../utils/mapsConfig';
import {
  AiBudgetEstimateResponse,
  generateItineraryAi,
  refineActivityAi,
  regenerateDayAi,
  verifyPlaceWithPhoton,
} from '../services/aiService';
import { auth } from '../firebase';
import {
  AuthActionResult,
  isVerifiedFirebaseUser,
  mapFirebaseAuthError,
  resendVerificationForCredentials,
  sendPasswordReset,
  signInWithEmail,
  signInWithGooglePopup,
  signOutUser,
  signUpWithEmail,
} from '../services/authService';
import { ensureUserProfile, updateUserProfileDoc } from '../services/userProfileService';
import {
  DEFAULT_APP_SETTINGS,
  loadOrInitUserSettings,
  loadUserSavedAddress,
  saveActiveTripIdInFirestore,
  saveUserAddressInFirestore,
  saveUserSettings,
  subscribeToUserSavedAddress,
  subscribeToUserSettings,
  syncTravelPreferencesInFirestore,
} from '../services/settingsService';
import {
  addActivityInFirestore,
  addActualExpenseInFirestore,
  batchUpdateActivitiesInFirestore,
  createTripInFirestore,
  deleteActivityInFirestore,
  deleteActualExpenseInFirestore,
  deleteTripInFirestore,
  loadTripSubcollections,
  loadUserTripsWithDetails,
  replaceDayInFirestore,
  replaceTripItineraryInFirestore,
  subscribeToActiveTripSubcollections,
  subscribeToUserTripsList,
  updateActivityInFirestore,
  updateActualExpenseInFirestore,
  updateDayPlanPaceInFirestore,
  updateTripMetaInFirestore,
} from '../services/tripService';
import {
  dismissMigrationPrompt,
  getMigrationRecord,
  inspectLocalStorageMigrationCandidate,
  MigrationCandidate,
  MigrationExecutionResult,
  migrateLocalStorageToFirestore,
} from '../services/migrationService';

const LEGACY_USER_STORAGE_KEY = 'tripmate_user_v1';
const WIZARD_DRAFT_STORAGE_KEY = 'tripmate_wizard_draft_v1';
const ADDRESS_PROMPT_SESSION_KEY = 'tripmate_address_prompt_dismissed_session';

const DEFAULT_WIZARD_DRAFT: WizardDraft = {
  origin: 'Bengaluru',
  destination: 'Jaipur',
  daysCount: 3,
  startDate: '',
  endDate: '',
  adults: 2,
  children: 0,
  budget: {
    total: 15000,
    daily: 5000,
    food: 4500,
    transport: 3500,
    attraction: 7000,
  },
  travelStyle: 'Balanced',
  dayPlans: [
    { dayNumber: 1, title: 'Arrival & Relaxed Exploration', pace: 'Relaxed', notes: ['Local food experiences'] },
    { dayNumber: 2, title: 'Heritage & Landmarks', pace: 'Activity-heavy', notes: ['Nature and sightseeing'] },
    { dayNumber: 3, title: 'Markets & Departure', pace: 'Balanced', notes: ['Avoid crowded locations'] },
  ],
  generalNotes: ['Nature and sightseeing', 'Local food experiences'],
  accommodationPreference: '',
  transportPreference: '',
  accessibilityNeeds: '',
  stayMode: 'without-hotel',
  hotel: null,
  commuteMode: 'DRIVING',
  maxHotelRadiusKm: 10,
  waitingBufferMinutes: 15,
};

export type MigrationUiStatus = 'idle' | 'available' | 'migrating' | 'failed' | 'completed';

interface TripContextValue {
  user: UserProfile | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<AuthActionResult>;
  register: (name: string, email: string, password: string) => Promise<AuthActionResult>;
  loginWithGoogle: () => Promise<AuthActionResult>;
  resendVerificationEmail: (email: string, password: string) => Promise<AuthActionResult>;
  resetPassword: (email: string) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  updateProfile: (patch: Partial<UserProfile>) => Promise<AuthActionResult>;

  userAddress: SavedAddress | null;
  isAddressModalOpen: boolean;
  setIsAddressModalOpen: (open: boolean) => void;
  saveUserAddress: (address: SavedAddress) => void;
  dismissAddressPrompt: () => void;

  trips: Trip[];
  tripsLoading: boolean;
  tripsError: string | null;
  isSyncing: boolean;
  activeTrip: Trip | null;
  activeTripMetrics: TripMetrics | null;
  activeTripAiOverview: { overview: string; practicalNotes: string[]; model: string } | null;
  setActiveTripId: (id: string) => void;
  createTripAsync: (req: ItineraryGenerationRequest) => Promise<Trip>;
  regenerateActiveTrip: (styleOverride?: Trip['travelStyle']) => Promise<void>;
  regenerateDayWithAi: (
    dayNumber: number,
    instruction: string,
    paceOverride?: DayPace
  ) => Promise<{ ok: boolean; error?: string; dayTitle?: string }>;
  refineActivityWithAi: (
    activityId: string,
    instruction: string
  ) => Promise<{ ok: boolean; changeSummary?: string; verifiedWithMaps?: boolean; error?: string }>;
  applyAiBudgetEstimate: (estimate: AiBudgetEstimateResponse) => Promise<void>;
  duplicateTrip: (id: string) => Promise<Trip | null>;
  deleteTrip: (id: string) => Promise<void>;
  loadSampleTrip: () => Promise<Trip | null>;

  addActivity: (activity: Omit<Activity, 'id' | 'endTime'>) => void;
  updateActivity: (activityId: string, patch: Partial<Activity>) => void;
  deleteActivity: (activityId: string) => void;
  replaceActivityWithAlternative: (
    targetActivityId: string,
    alt: AlternativeActivityOption,
    options?: { preventOverlap?: boolean }
  ) => { ok: boolean; error?: string };
  moveOrReorderActivity: (activityId: string, targetDay: number, targetIndex?: number) => void;
  scheduleActivityAtSlot: (
    activityId: string,
    targetDay: number,
    startTime: string
  ) => { ok: boolean; error?: string };
  addRecommendedAtSlot: (
    alt: AlternativeActivityOption,
    targetDay: number,
    startTime?: string
  ) => { ok: boolean; error?: string };
  addActualExpense: (item: {
    name: string;
    amount: number;
    day?: number;
    category?: ExpenseBucket;
    notes?: string;
  }) => void;
  updateActualExpense: (id: string, patch: Partial<ActualExpenseItem>) => void;
  deleteActualExpense: (id: string) => void;
  autoResolveDay: (day: number) => void;
  updateDayPace: (dayNumber: number, pace: DayPace) => void;
  updateTripMeta: (patch: Partial<Pick<Trip, 'name' | 'budget' | 'travelStyle'>>) => void;

  wizardDraft: WizardDraft;
  setWizardDraft: React.Dispatch<React.SetStateAction<WizardDraft>>;
  selectedSwapActivityId: string | null;
  setSelectedSwapActivityId: (id: string | null) => void;

  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetDemoData: () => Promise<void>;

  migrationCandidate: MigrationCandidate | null;
  migrationStatus: MigrationUiStatus;
  migrationError: string | null;
  runLocalMigration: () => Promise<MigrationExecutionResult>;
  dismissLocalMigration: () => Promise<void>;

  notifications: AppNotification[];
  readNotificationIds: string[];
  markAllNotificationsRead: () => void;
  toastMessage: string | null;
  showToast: (msg: string) => void;
}

const TripContext = createContext<TripContextValue | undefined>(undefined);

function loadWizardDraft(): WizardDraft {
  try {
    const raw = localStorage.getItem(WIZARD_DRAFT_STORAGE_KEY);
    if (!raw) return DEFAULT_WIZARD_DRAFT;
    const loaded = JSON.parse(raw) as Partial<WizardDraft>;
    return { ...DEFAULT_WIZARD_DRAFT, ...loaded };
  } catch {
    return DEFAULT_WIZARD_DRAFT;
  }
}

function getFriendlyFirestoreError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as { error?: string };
      if (parsed?.error) return parsed.error;
    } catch {
      // plain error message
    }
    return err.message || fallback;
  }
  return fallback;
}

export const TripProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [userAddress, setUserAddressState] = useState<SavedAddress | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState<boolean>(false);

  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoading, setTripsLoading] = useState<boolean>(false);
  const [tripsError, setTripsError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);

  const [activeTripId, setActiveTripIdState] = useState<string>('');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [wizardDraft, setWizardDraft] = useState<WizardDraft>(() => loadWizardDraft());
  const [selectedSwapActivityId, setSelectedSwapActivityId] = useState<string | null>(null);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [migrationCandidate, setMigrationCandidate] = useState<MigrationCandidate | null>(null);
  const [migrationStatus, setMigrationStatus] = useState<MigrationUiStatus>('idle');
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [aiOverviewByTripId, setAiOverviewByTripId] = useState<
    Record<string, { overview: string; practicalNotes: string[]; model: string }>
  >({});

  const tripsRef = useRef<Trip[]>(trips);
  tripsRef.current = trips;
  const activeTripIdRef = useRef<string>(activeTripId);
  activeTripIdRef.current = activeTripId;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const userRef = useRef<UserProfile | null>(user);
  userRef.current = user;

  const debounceTimersRef = useRef<Map<string, number>>(new Map());
  const subUnsubRef = useRef<Unsubscribe | null>(null);
  const loadedRemoteTripIdsRef = useRef<Set<string>>(new Set());
  const regeneratingDaysRef = useRef<Set<string>>(new Set());
  const refiningActivitiesRef = useRef<Set<string>>(new Set());

  const isSyncing = pendingSyncCount > 0;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  const clearPendingDebounces = useCallback(() => {
    debounceTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    debounceTimersRef.current.clear();
  }, []);

  const clearAllUserScopedState = useCallback(() => {
    clearPendingDebounces();
    if (subUnsubRef.current) {
      subUnsubRef.current();
      subUnsubRef.current = null;
    }
    loadedRemoteTripIdsRef.current.clear();
    setTrips([]);
    setActiveTripIdState('');
    setSettings(DEFAULT_APP_SETTINGS);
    setUserAddressState(null);
    setIsAddressModalOpen(false);
    setSelectedSwapActivityId(null);
    setReadNotificationIds([]);
    setTripsLoading(false);
    setTripsError(null);
    setPendingSyncCount(0);
    setMigrationCandidate(null);
    setMigrationStatus('idle');
    setMigrationError(null);
    setAiOverviewByTripId({});
    regeneratingDaysRef.current.clear();
    refiningActivitiesRef.current.clear();
  }, [clearPendingDebounces]);

  const runTrackedWrite = useCallback(
    async <T,>(fn: () => Promise<T>, errorLabel: string): Promise<T> => {
      setPendingSyncCount((c) => c + 1);
      try {
        const res = await fn();
        setTripsError(null);
        return res;
      } catch (err) {
        const msg = getFriendlyFirestoreError(err, errorLabel);
        setTripsError(msg);
        showToast(msg);
        throw err;
      } finally {
        setPendingSyncCount((c) => Math.max(0, c - 1));
      }
    },
    [showToast]
  );

  const scheduleDebouncedWrite = useCallback(
    (key: string, fn: () => Promise<void>, delayMs = 400) => {
      const existingTimer = debounceTimersRef.current.get(key);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      const timerId = window.setTimeout(() => {
        debounceTimersRef.current.delete(key);
        void runTrackedWrite(fn, 'Unable to sync latest changes to Cloud Firestore').catch(
          (err) => {
            console.error(`Debounced Firestore write failed [${key}]:`, err);
          }
        );
      }, delayMs);
      debounceTimersRef.current.set(key, timerId);
    },
    [runTrackedWrite]
  );

  const getCurrentVerifiedUid = (): string | null => {
    const fbUser = auth.currentUser;
    if (!fbUser || !isVerifiedFirebaseUser(fbUser)) return null;
    return fbUser.uid;
  };

  // Persist wizard UI draft locally (form state only, never DB entities)
  useEffect(() => {
    try {
      localStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, JSON.stringify(wizardDraft));
    } catch {
      // ignore storage errors
    }
  }, [wizardDraft]);

  // Auth listener & Firestore workspace hydration
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_USER_STORAGE_KEY);
    } catch {
      // ignore storage cleanup errors
    }

    let isMounted = true;
    let unsubTripsList: Unsubscribe | null = null;
    let unsubSettings: Unsubscribe | null = null;
    let unsubAddress: Unsubscribe | null = null;

    const cleanupWorkspaceListeners = () => {
      if (unsubTripsList) {
        unsubTripsList();
        unsubTripsList = null;
      }
      if (unsubSettings) {
        unsubSettings();
        unsubSettings = null;
      }
      if (unsubAddress) {
        unsubAddress();
        unsubAddress = null;
      }
    };

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!isMounted) return;
      cleanupWorkspaceListeners();

      if (!firebaseUser || !isVerifiedFirebaseUser(firebaseUser)) {
        setUser(null);
        clearAllUserScopedState();
        setAuthLoading(false);
        return;
      }

      const uid = firebaseUser.uid;
      // Clear any previous account's in-memory state immediately before hydrating this UID
      clearAllUserScopedState();
      setTripsLoading(true);
      setTripsError(null);

      try {
        const [profile, loadedTrips, loadedSettings, loadedAddress] = await Promise.all([
          ensureUserProfile(firebaseUser, { homeCity: 'Bengaluru' }),
          loadUserTripsWithDetails(uid),
          loadOrInitUserSettings(uid),
          loadUserSavedAddress(uid),
        ]);

        if (!isMounted || auth.currentUser?.uid !== uid) return;

        setUser(profile);
        setSettings(loadedSettings);
        setUserAddressState(loadedAddress);

        loadedRemoteTripIdsRef.current = new Set(loadedTrips.map((t) => t.id));
        setTrips(loadedTrips);

        const preferredActiveId =
          profile.activeTripId && loadedTrips.some((t) => t.id === profile.activeTripId)
            ? profile.activeTripId
            : loadedTrips[0]?.id || '';
        setActiveTripIdState(preferredActiveId);

        const originLabel =
          loadedAddress?.city || loadedAddress?.label || profile.homeCity || 'Bengaluru';
        setWizardDraft((prev) => ({
          ...prev,
          origin: originLabel,
        }));

        // Address prompt check only after Firestore address state is known
        if (!loadedAddress) {
          try {
            if (sessionStorage.getItem(ADDRESS_PROMPT_SESSION_KEY) !== '1') {
              setIsAddressModalOpen(true);
            }
          } catch {
            setIsAddressModalOpen(true);
          }
        } else {
          setIsAddressModalOpen(false);
        }

        // Inspect legacy localStorage for safe migration option
        const candidate = inspectLocalStorageMigrationCandidate();
        setMigrationCandidate(candidate);
        if (candidate) {
          const migRecord = await getMigrationRecord(uid);
          if (!isMounted || auth.currentUser?.uid !== uid) return;
          if (!migRecord) {
            setMigrationStatus('available');
          } else if (migRecord.status === 'completed') {
            setMigrationStatus('completed');
          } else {
            setMigrationStatus('idle');
          }
        } else {
          setMigrationStatus('idle');
        }

        // Subscribe to top-level user trips list for multi-tab/multi-device sync
        unsubTripsList = subscribeToUserTripsList(
          uid,
          (remoteList) => {
            if (!isMounted || auth.currentUser?.uid !== uid) return;
            setTrips((prev) => {
              const prevMap = new Map(prev.map((t) => [t.id, t]));
              const next: Trip[] = remoteList.map(({ id, skeleton }) => {
                const existing = prevMap.get(id);
                if (existing) {
                  return {
                    ...skeleton,
                    dayPlans: existing.dayPlans.length > 0 ? existing.dayPlans : skeleton.dayPlans,
                    activities: existing.activities,
                    actualExpenses: existing.actualExpenses || [],
                  };
                }
                return skeleton;
              });
              return next;
            });

            // Hydrate subcollections for any newly observed remote trip ID
            for (const { id } of remoteList) {
              if (!loadedRemoteTripIdsRef.current.has(id)) {
                loadedRemoteTripIdsRef.current.add(id);
                void loadTripSubcollections(uid, id)
                  .then((sub) => {
                    if (!isMounted || auth.currentUser?.uid !== uid) return;
                    setTrips((prev) =>
                      prev.map((t) =>
                        t.id === id
                          ? {
                              ...t,
                              activities: sub.activities,
                              dayPlans: sub.dayPlans.length > 0 ? sub.dayPlans : t.dayPlans,
                              budget: sub.budget || t.budget,
                              actualExpenses: sub.actualExpenses,
                            }
                          : t
                      )
                    );
                  })
                  .catch((err) => {
                    console.error(`Failed to hydrate remote trip ${id}:`, err);
                  });
              }
            }
          },
          (err) => {
            console.error('Trips list subscription error:', err);
          }
        );

        unsubSettings = subscribeToUserSettings(
          uid,
          (remoteSettings) => {
            if (isMounted && auth.currentUser?.uid === uid) {
              setSettings(remoteSettings);
            }
          },
          (err) => console.error('Settings subscription error:', err)
        );

        unsubAddress = subscribeToUserSavedAddress(
          uid,
          (remoteAddr) => {
            if (isMounted && auth.currentUser?.uid === uid) {
              setUserAddressState(remoteAddr);
            }
          },
          (err) => console.error('Address subscription error:', err)
        );
      } catch (err) {
        console.error('Failed to hydrate TripMate Firestore workspace:', err);
        if (isMounted) {
          setTripsError(
            getFriendlyFirestoreError(err, 'Could not load your trips from Cloud Firestore.')
          );
        }
      } finally {
        if (isMounted) {
          setAuthLoading(false);
          setTripsLoading(false);
        }
      }
    });

    return () => {
      isMounted = false;
      cleanupWorkspaceListeners();
      unsubscribeAuth();
      clearPendingDebounces();
    };
  }, [clearAllUserScopedState, clearPendingDebounces]);

  // Subscribe to the active trip's subcollections for real-time updates across tabs/devices
  useEffect(() => {
    if (subUnsubRef.current) {
      subUnsubRef.current();
      subUnsubRef.current = null;
    }

    const uid = user?.uid;
    if (!uid || !activeTripId || !loadedRemoteTripIdsRef.current.has(activeTripId)) {
      return;
    }

    const unsub = subscribeToActiveTripSubcollections(uid, activeTripId, {
      onActivities: (activities) => {
        setTrips((prev) =>
          prev.map((t) =>
            t.id === activeTripId
              ? {
                  ...t,
                  activities: settingsRef.current.autoSortByTime
                    ? sortActivitiesByTime(activities)
                    : activities,
                }
              : t
          )
        );
      },
      onDayPlans: (dayPlans) => {
        if (dayPlans.length === 0) return;
        setTrips((prev) =>
          prev.map((t) => (t.id === activeTripId ? { ...t, dayPlans } : t))
        );
      },
      onBudget: (budget) => {
        setTrips((prev) =>
          prev.map((t) => (t.id === activeTripId ? { ...t, budget } : t))
        );
      },
      onActualExpenses: (actualExpenses) => {
        setTrips((prev) =>
          prev.map((t) => (t.id === activeTripId ? { ...t, actualExpenses } : t))
        );
      },
      onError: (err) => {
        console.error(`Active trip subcollection listener error [${activeTripId}]:`, err);
      },
    });

    subUnsubRef.current = unsub;
    return () => {
      unsub();
      if (subUnsubRef.current === unsub) {
        subUnsubRef.current = null;
      }
    };
  }, [user?.uid, activeTripId]);

  const activeTrip = useMemo(() => {
    if (trips.length === 0) return null;
    return trips.find((t) => t.id === activeTripId) || trips[0] || null;
  }, [trips, activeTripId]);

  const activeTripMetrics = useMemo(() => {
    return activeTrip ? calculateTripMetrics(activeTrip) : null;
  }, [activeTrip]);

  const setActiveTripId = (id: string) => {
    setActiveTripIdState(id);
    const uid = getCurrentVerifiedUid();
    if (uid) {
      void saveActiveTripIdInFirestore(uid, id).catch((err) => {
        console.error('Failed to persist activeTripId:', err);
      });
    }
  };

  const saveUserAddress = (address: SavedAddress) => {
    setUserAddressState(address);
    const originLabel = address.city || address.label || address.formattedAddress;
    if (originLabel) {
      setWizardDraft((prev) => ({ ...prev, origin: originLabel }));
      setUser((prev) => (prev ? { ...prev, homeCity: originLabel } : prev));
    }
    setIsAddressModalOpen(false);
    showToast(`Saved your starting address: ${originLabel}`);

    const uid = getCurrentVerifiedUid();
    if (uid) {
      void runTrackedWrite(async () => {
        await saveUserAddressInFirestore(uid, address);
        if (originLabel) {
          await updateUserProfileDoc(uid, { homeCity: originLabel });
          await syncTravelPreferencesInFirestore(uid, { homeCity: originLabel });
        }
      }, 'Failed to save address to Cloud Firestore').catch((err) => {
        console.error('Failed to save address:', err);
      });
    }
  };

  const dismissAddressPrompt = () => {
    try {
      sessionStorage.setItem(ADDRESS_PROMPT_SESSION_KEY, '1');
    } catch {
      // ignore storage errors
    }
    setIsAddressModalOpen(false);
  };

  const login = async (
    email: string,
    password: string,
    rememberMe = true
  ): Promise<AuthActionResult> => {
    const { result, user: firebaseUser } = await signInWithEmail(email, password, rememberMe);
    if (!result.ok || !firebaseUser) {
      return result;
    }

    try {
      const profile = await ensureUserProfile(firebaseUser, {
        rememberMe,
        homeCity: 'Bengaluru',
      });
      setUser(profile);
      showToast(`Welcome back, ${profile.name}`);
      return { ok: true, email: profile.email };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Signed in, but could not load your traveler profile.',
      };
    }
  };

  const register = async (
    name: string,
    email: string,
    password: string
  ): Promise<AuthActionResult> => {
    const result = await signUpWithEmail(name, email, password);
    if (result.ok) {
      showToast(`Verification email sent to ${result.email || email}`);
    }
    return result;
  };

  const loginWithGoogle = async (): Promise<AuthActionResult> => {
    const { result, user: firebaseUser } = await signInWithGooglePopup();
    if (!result.ok || !firebaseUser) {
      return result;
    }

    try {
      const profile = await ensureUserProfile(firebaseUser, {
        rememberMe: true,
        homeCity: 'Bengaluru',
      });
      setUser(profile);
      showToast(`Welcome, ${profile.name}`);
      return { ok: true, email: profile.email };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Google authentication succeeded, but profile sync failed.',
      };
    }
  };

  const resendVerificationEmail = async (
    email: string,
    password: string
  ): Promise<AuthActionResult> => {
    const result = await resendVerificationForCredentials(email, password);
    if (result.ok && result.needsVerification) {
      showToast(`Verification email re-sent to ${result.email || email}`);
    }
    return result;
  };

  const resetPassword = async (email: string): Promise<AuthActionResult> => {
    const result = await sendPasswordReset(email);
    if (result.ok) {
      showToast(`Password reset email sent to ${result.email || email}`);
    }
    return result;
  };

  const logout = async (): Promise<void> => {
    clearAllUserScopedState();
    try {
      await signOutUser();
    } finally {
      setUser(null);
      showToast('Signed out of TripMate');
    }
  };

  const updateProfile = async (patch: Partial<UserProfile>): Promise<AuthActionResult> => {
    const currentUser = auth.currentUser;
    if (!currentUser || !isVerifiedFirebaseUser(currentUser)) {
      return { ok: false, error: 'You must be signed in to update your profile.' };
    }

    try {
      if (patch.name !== undefined && patch.name.trim()) {
        await fbUpdateProfile(currentUser, { displayName: patch.name.trim().slice(0, 120) });
      }
      await updateUserProfileDoc(currentUser.uid, {
        name: patch.name,
        homeCity: patch.homeCity,
        defaultTravelStyle: patch.defaultTravelStyle,
        preferredNotes: patch.preferredNotes,
        photoURL: patch.photoURL,
      });
      await syncTravelPreferencesInFirestore(currentUser.uid, {
        homeCity: patch.homeCity,
        defaultTravelStyle: patch.defaultTravelStyle,
        preferredNotes: patch.preferredNotes,
      });
      setUser((prev) =>
        prev
          ? {
              ...prev,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : prev
      );
      showToast('Profile preferences saved');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: mapFirebaseAuthError(error) };
    }
  };

  const updateActiveTripRecord = (updater: (trip: Trip) => Trip): Trip | null => {
    const currentActive =
      tripsRef.current.find((t) => t.id === activeTripIdRef.current) ||
      tripsRef.current[0] ||
      null;
    if (!currentActive) return null;
    const updated = { ...updater(currentActive), updatedAt: new Date().toISOString() };
    setTrips((prev) => prev.map((t) => (t.id === currentActive.id ? updated : t)));
    return updated;
  };

  const buildTripNotesWithContext = (
    req: ItineraryGenerationRequest,
    practicalNotes: string[]
  ): string[] => {
    const merged: string[] = [];
    const seen = new Set<string>();
    const pushNote = (val?: string) => {
      const clean = (val || '').trim().slice(0, 200);
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key) || merged.length >= 20) return;
      seen.add(key);
      merged.push(clean);
    };

    if (req.startDate && req.endDate) {
      pushNote(`Dates: ${req.startDate} to ${req.endDate}`);
    } else if (req.startDate) {
      pushNote(`Start date: ${req.startDate}`);
    }
    if (req.accommodationPreference?.trim()) {
      pushNote(`Stay pref: ${req.accommodationPreference.trim()}`);
    }
    if (req.transportPreference?.trim()) {
      pushNote(`Transport pref: ${req.transportPreference.trim()}`);
    }
    if (req.accessibilityNeeds?.trim()) {
      pushNote(`Accessibility: ${req.accessibilityNeeds.trim()}`);
    }
    req.generalNotes.forEach(pushNote);
    practicalNotes.forEach(pushNote);
    return merged;
  };

  const createTripAsync = async (req: ItineraryGenerationRequest): Promise<Trip> => {
    const { data: aiData, model } = await generateItineraryAi({
      origin: req.origin.trim() || 'Bengaluru',
      destination: req.destination.trim(),
      daysCount: req.daysCount,
      startDate: req.startDate || undefined,
      endDate: req.endDate || undefined,
      adults: req.adults,
      children: req.children,
      budget: req.budget,
      travelStyle: req.travelStyle,
      dayPlans: req.dayPlans,
      generalNotes: req.generalNotes,
      stayMode: req.stayMode || 'without-hotel',
      hotel: req.stayMode === 'with-hotel' ? req.hotel || null : null,
      commuteMode: req.commuteMode || 'DRIVING',
      accommodationPreference: req.accommodationPreference || undefined,
      transportPreference: req.transportPreference || undefined,
      accessibilityNeeds: req.accessibilityNeeds || undefined,
    });

    const stamp = Date.now();
    const now = new Date().toISOString();
    const mappedActivities: Activity[] = aiData.activities.map((a, idx) => ({
      id: `act-${stamp}-${idx}`,
      title: a.title,
      description: a.description,
      category: a.category,
      location: a.location,
      imageUrl: a.imageUrl,
      startTime: a.startTime,
      endTime: a.endTime,
      durationMinutes: a.durationMinutes,
      cost: a.cost,
      day: a.day,
      isChildFriendly: a.isChildFriendly,
      crowdLevel: a.crowdLevel,
      notes: a.notes ? `${a.notes} · AI-suggested (verify hours)` : 'AI-suggested (verify hours)',
    }));

    const baseTrip: Trip = {
      id: `trip-${stamp}`,
      name: aiData.tripTitle || `${req.destination.trim()} ${req.daysCount}-Day Journey`,
      origin: req.origin.trim() || 'Bengaluru',
      destination: req.destination.trim(),
      daysCount: req.daysCount,
      adults: req.adults,
      children: req.children,
      budget: { ...req.budget },
      travelStyle: req.travelStyle,
      dayPlans: aiData.dayPlans,
      activities: mappedActivities,
      actualExpenses: [],
      generalNotes: buildTripNotesWithContext(req, aiData.practicalNotes || []),
      stayMode: req.stayMode || 'without-hotel',
      hotel: req.stayMode === 'with-hotel' ? req.hotel || null : null,
      commuteMode: req.commuteMode || 'DRIVING',
      maxHotelRadiusKm: req.maxHotelRadiusKm || 10,
      waitingBufferMinutes: req.waitingBufferMinutes ?? 15,
      createdAt: now,
      updatedAt: now,
    };

    const generated =
      req.stayMode === 'with-hotel' && req.hotel
        ? await enrichAiTripWithHotelMaps(baseTrip)
        : baseTrip;

    const uid = getCurrentVerifiedUid();
    let persisted = generated;
    if (uid) {
      persisted = await runTrackedWrite(async () => {
        const saved = await createTripInFirestore(uid, generated);
        await saveActiveTripIdInFirestore(uid, saved.id);
        return saved;
      }, 'Failed to save itinerary to Cloud Firestore');
    }

    loadedRemoteTripIdsRef.current.add(persisted.id);
    setTrips((prev) => [persisted, ...prev]);
    setActiveTripIdState(persisted.id);
    setAiOverviewByTripId((prev) => ({
      ...prev,
      [persisted.id]: {
        overview: aiData.overview,
        practicalNotes: aiData.practicalNotes || [],
        model,
      },
    }));
    showToast(
      req.stayMode === 'with-hotel' && req.hotel
        ? `Generated AI hotel-anchored ${persisted.daysCount}-day plan around ${req.hotel.name}`
        : `Generated AI ${persisted.daysCount}-day ${persisted.destination} itinerary`
    );
    return persisted;
  };

  const regenerateActiveTrip = async (styleOverride?: Trip['travelStyle']) => {
    if (!activeTrip) return;
    const effectiveStyle = styleOverride || activeTrip.travelStyle;

    const { data: aiData, model } = await generateItineraryAi({
      origin: activeTrip.origin,
      destination: activeTrip.destination,
      daysCount: activeTrip.daysCount,
      adults: activeTrip.adults,
      children: activeTrip.children,
      budget: activeTrip.budget,
      travelStyle: effectiveStyle,
      dayPlans: activeTrip.dayPlans,
      generalNotes: activeTrip.generalNotes,
      stayMode: activeTrip.stayMode || 'without-hotel',
      hotel: activeTrip.hotel || null,
      commuteMode: activeTrip.commuteMode || 'DRIVING',
    });

    const stamp = Date.now();
    const mappedActivities: Activity[] = aiData.activities.map((a, idx) => ({
      id: `act-regen-${stamp}-${idx}`,
      title: a.title,
      description: a.description,
      category: a.category,
      location: a.location,
      imageUrl: a.imageUrl,
      startTime: a.startTime,
      endTime: a.endTime,
      durationMinutes: a.durationMinutes,
      cost: a.cost,
      day: a.day,
      isChildFriendly: a.isChildFriendly,
      crowdLevel: a.crowdLevel,
      notes: a.notes ? `${a.notes} · AI-suggested` : 'AI-suggested',
    }));

    const baseRegenTrip: Trip = {
      ...activeTrip,
      travelStyle: effectiveStyle,
      dayPlans: aiData.dayPlans,
      activities: mappedActivities,
      actualExpenses: activeTrip.actualExpenses || [],
      updatedAt: new Date().toISOString(),
    };

    const updatedTrip =
      baseRegenTrip.stayMode === 'with-hotel' && baseRegenTrip.hotel
        ? await enrichAiTripWithHotelMaps(baseRegenTrip)
        : baseRegenTrip;

    const uid = getCurrentVerifiedUid();
    if (uid) {
      await runTrackedWrite(
        () => replaceTripItineraryInFirestore(uid, updatedTrip),
        'Failed to save regenerated itinerary to Cloud Firestore'
      );
    }

    setTrips((prev) => prev.map((t) => (t.id === activeTrip.id ? updatedTrip : t)));
    setAiOverviewByTripId((prev) => ({
      ...prev,
      [activeTrip.id]: {
        overview: aiData.overview,
        practicalNotes: aiData.practicalNotes || [],
        model,
      },
    }));
    showToast(`Regenerated AI itinerary for ${activeTrip.destination}`);
  };

  const regenerateDayWithAi = async (
    dayNumber: number,
    instruction: string,
    paceOverride?: DayPace
  ): Promise<{ ok: boolean; error?: string; dayTitle?: string }> => {
    const trip = activeTrip;
    if (!trip) return { ok: false, error: 'No active trip selected.' };
    const cleanInstruction = instruction.trim();
    if (cleanInstruction.length < 3) {
      return { ok: false, error: 'Please describe how you would like this day refreshed.' };
    }

    const lockKey = `${trip.id}:day-${dayNumber}`;
    if (regeneratingDaysRef.current.has(lockKey)) {
      return { ok: false, error: `Day ${dayNumber} regeneration is already in progress.` };
    }
    regeneratingDaysRef.current.add(lockKey);

    try {
      const currentPlan = trip.dayPlans.find((d) => d.dayNumber === dayNumber) || {
        dayNumber,
        title: `Day ${dayNumber}`,
        pace: 'Balanced' as DayPace,
        notes: [],
      };
      const effectivePlan = paceOverride ? { ...currentPlan, pace: paceOverride } : currentPlan;
      const existingDayActivities = trip.activities.filter((a) => a.day === dayNumber);
      const otherDaysHighlights = trip.activities
        .filter((a) => a.day !== dayNumber)
        .map((a) => a.title)
        .slice(0, 30);

      const { data } = await regenerateDayAi({
        destination: trip.destination,
        origin: trip.origin,
        daysCount: trip.daysCount,
        dayNumber,
        adults: trip.adults,
        children: trip.children,
        travelStyle: trip.travelStyle,
        budgetTotal: trip.budget.total,
        dailyBudget: trip.budget.daily,
        dayPlan: effectivePlan,
        instruction: cleanInstruction,
        generalNotes: trip.generalNotes,
        stayMode: trip.stayMode || 'without-hotel',
        hotel: trip.hotel || null,
        commuteMode: trip.commuteMode || 'DRIVING',
        existingDayActivities: existingDayActivities.map((a) => ({
          title: a.title,
          category: a.category,
          startTime: a.startTime,
          durationMinutes: a.durationMinutes,
          cost: a.cost,
        })),
        otherDaysHighlights,
      });

      const stamp = Date.now();
      const rawDayActivities: Activity[] = data.activities.map((a, idx) => ({
        id: `act-d${dayNumber}-${stamp}-${idx}`,
        title: a.title,
        description: a.description,
        category: a.category,
        location: a.location,
        imageUrl: a.imageUrl,
        startTime: a.startTime,
        endTime: a.endTime,
        durationMinutes: a.durationMinutes,
        cost: a.cost,
        day: dayNumber,
        isChildFriendly: a.isChildFriendly,
        crowdLevel: a.crowdLevel,
        notes: a.notes ? `${a.notes} · AI-suggested` : 'AI-suggested',
      }));

      let finalDayActivities = rawDayActivities;
      if (trip.stayMode === 'with-hotel' && trip.hotel) {
        const enrichedSlice = await enrichAiTripWithHotelMaps({
          ...trip,
          activities: rawDayActivities,
        });
        finalDayActivities = enrichedSlice.activities;
      }

      const oldActivityIds = existingDayActivities.map((a) => a.id);
      const uid = getCurrentVerifiedUid();
      if (uid) {
        await runTrackedWrite(
          () =>
            replaceDayInFirestore(
              uid,
              trip.id,
              data.dayPlan,
              oldActivityIds,
              finalDayActivities
            ),
          `Failed to save regenerated Day ${dayNumber} to Cloud Firestore`
        );
      }

      setTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip.id) return t;
          const otherActivities = t.activities.filter((a) => a.day !== dayNumber);
          const nextActivities = [...otherActivities, ...finalDayActivities];
          const hasPlan = t.dayPlans.some((dp) => dp.dayNumber === dayNumber);
          const nextDayPlans = hasPlan
            ? t.dayPlans.map((dp) => (dp.dayNumber === dayNumber ? data.dayPlan : dp))
            : [...t.dayPlans, data.dayPlan].sort((a, b) => a.dayNumber - b.dayNumber);
          return {
            ...t,
            dayPlans: nextDayPlans,
            activities: settingsRef.current.autoSortByTime
              ? sortActivitiesByTime(nextActivities)
              : nextActivities,
            updatedAt: new Date().toISOString(),
          };
        })
      );

      showToast(`Day ${dayNumber} refreshed: ${data.dayPlan.title}`);
      return { ok: true, dayTitle: data.dayPlan.title };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : `Could not regenerate Day ${dayNumber}. Please retry.`;
      showToast(msg);
      return { ok: false, error: msg };
    } finally {
      regeneratingDaysRef.current.delete(lockKey);
    }
  };

  const refineActivityWithAi = async (
    activityId: string,
    instruction: string
  ): Promise<{ ok: boolean; changeSummary?: string; verifiedWithMaps?: boolean; error?: string }> => {
    const trip = activeTrip;
    if (!trip) return { ok: false, error: 'No active trip selected.' };
    const existingAct = trip.activities.find((a) => a.id === activityId);
    if (!existingAct) return { ok: false, error: 'Activity not found in active trip.' };

    const cleanInstruction = instruction.trim();
    if (cleanInstruction.length < 2) {
      return { ok: false, error: 'Please choose a refinement preset or type an instruction.' };
    }

    if (refiningActivitiesRef.current.has(activityId)) {
      return { ok: false, error: 'This activity is already being refined.' };
    }
    refiningActivitiesRef.current.add(activityId);

    try {
      const dayScheduleSummary = trip.activities
        .filter((a) => a.day === existingAct.day)
        .map((a) => ({
          title: a.title,
          startTime: a.startTime,
          endTime: a.endTime,
          category: a.category,
        }));

      const { data } = await refineActivityAi({
        destination: trip.destination,
        daysCount: trip.daysCount,
        dayNumber: existingAct.day,
        adults: trip.adults,
        children: trip.children,
        travelStyle: trip.travelStyle,
        instruction: cleanInstruction,
        activity: existingAct,
        dayScheduleSummary,
        stayMode: trip.stayMode || 'without-hotel',
        hotel: trip.hotel || null,
      });

      const refined = data.activity;
      let nextPlaceId = refined.locationChanged ? undefined : existingAct.placeId;
      let nextCoords = refined.locationChanged ? undefined : existingAct.coordinates;
      let nextLocation = refined.location;
      let nextDistanceKm = refined.locationChanged ? undefined : existingAct.distanceFromHotelKm;
      let nextTravelHotel = refined.locationChanged ? undefined : existingAct.travelFromHotelMinutes;
      let nextTravelPrev = refined.locationChanged ? undefined : existingAct.travelFromPrevMinutes;
      let nextIsFar = refined.locationChanged ? undefined : existingAct.isFarFromHotel;
      let verifiedWithMaps = Boolean(nextPlaceId && nextCoords);

      if (refined.locationChanged) {
        const verification = await verifyPlaceWithPhoton(
          `${refined.title} ${refined.location}`,
          trip.destination,
          trip.hotel?.location
        );
        if (verification.verified && verification.placeId && verification.coordinates) {
          verifiedWithMaps = true;
          nextPlaceId = verification.placeId;
          nextCoords = verification.coordinates;
          nextLocation = verification.formattedAddress || refined.location;
          if (trip.stayMode === 'with-hotel' && trip.hotel) {
            const metrics = await computeHotelToPlaceMetrics(
              trip.hotel.location,
              verification.coordinates,
              trip.commuteMode || 'DRIVING',
              trip.maxHotelRadiusKm || 10
            );
            nextDistanceKm = metrics.distanceKm;
            nextTravelHotel = metrics.travelMinutes;
            nextTravelPrev = metrics.travelMinutes;
            nextIsFar = metrics.isFarFromHotel;
          }
        }
      }

      const updatedAct: Activity = {
        ...existingAct,
        id: existingAct.id,
        day: existingAct.day,
        title: refined.title,
        description: refined.description,
        category: refined.category,
        location: nextLocation,
        startTime: refined.startTime,
        endTime: refined.endTime,
        durationMinutes: refined.durationMinutes,
        cost: refined.cost,
        isChildFriendly: refined.isChildFriendly,
        crowdLevel: refined.crowdLevel,
        notes: refined.notes || existingAct.notes,
        placeId: nextPlaceId,
        coordinates: nextCoords,
        distanceFromHotelKm: nextDistanceKm,
        travelFromHotelMinutes: nextTravelHotel,
        travelFromPrevMinutes: nextTravelPrev,
        isFarFromHotel: nextIsFar,
      };

      const uid = getCurrentVerifiedUid();
      if (uid) {
        await runTrackedWrite(
          () => updateActivityInFirestore(uid, trip.id, updatedAct),
          'Failed to save refined activity to Cloud Firestore'
        );
      }

      setTrips((prev) =>
        prev.map((t) => {
          if (t.id !== trip.id) return t;
          const nextActs = t.activities.map((a) => (a.id === activityId ? updatedAct : a));
          return {
            ...t,
            activities: settingsRef.current.autoSortByTime ? sortActivitiesByTime(nextActs) : nextActs,
            updatedAt: new Date().toISOString(),
          };
        })
      );

      showToast(data.changeSummary || `Refined "${updatedAct.title}"`);
      return {
        ok: true,
        changeSummary: data.changeSummary,
        verifiedWithMaps,
      };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to refine activity with AI right now.';
      showToast(msg);
      return { ok: false, error: msg };
    } finally {
      refiningActivitiesRef.current.delete(activityId);
    }
  };

  const applyAiBudgetEstimate = async (estimate: AiBudgetEstimateResponse): Promise<void> => {
    const trip = activeTrip;
    if (!trip) return;

    const nextBudget = {
      total: estimate.estimatedTotal,
      daily: estimate.perDayEstimate,
      food: estimate.categories.food,
      transport: estimate.categories.localTransport + estimate.categories.intercityTransport,
      attraction: estimate.categories.activitiesAndAttractions,
    };

    const uid = getCurrentVerifiedUid();
    if (uid) {
      await runTrackedWrite(
        () =>
          updateTripMetaInFirestore(
            uid,
            trip.id,
            {
              name: trip.name,
              budget: nextBudget,
              travelStyle: trip.travelStyle,
            },
            trip.daysCount
          ),
        'Failed to save AI budget estimate to Cloud Firestore'
      );
    }

    setTrips((prev) =>
      prev.map((t) =>
        t.id === trip.id
          ? {
              ...t,
              budget: nextBudget,
              updatedAt: new Date().toISOString(),
            }
          : t
      )
    );
    showToast(`Applied AI budget estimate (${formatINR(nextBudget.total)}) to ${trip.name}`);
  };

  const duplicateTrip = async (id: string): Promise<Trip | null> => {
    const found = tripsRef.current.find((t) => t.id === id);
    if (!found) return null;
    const now = new Date().toISOString();
    const stamp = Date.now();
    const copy: Trip = {
      ...found,
      id: `trip-${stamp}`,
      name: `${found.name} (Copy)`,
      activities: found.activities.map((a, idx) => ({ ...a, id: `act-${stamp}-${idx}` })),
      actualExpenses: (found.actualExpenses || []).map((e, idx) => ({
        ...e,
        id: `exp-${stamp}-${idx}`,
      })),
      createdAt: now,
      updatedAt: now,
    };

    const uid = getCurrentVerifiedUid();
    let persisted = copy;
    if (uid) {
      persisted = await runTrackedWrite(async () => {
        const saved = await createTripInFirestore(uid, copy);
        await saveActiveTripIdInFirestore(uid, saved.id);
        return saved;
      }, 'Failed to duplicate trip in Cloud Firestore');
    }

    loadedRemoteTripIdsRef.current.add(persisted.id);
    setTrips((prev) => [persisted, ...prev]);
    setActiveTripIdState(persisted.id);
    showToast(`Duplicated "${found.name}"`);
    return persisted;
  };

  const deleteTrip = async (id: string): Promise<void> => {
    debounceTimersRef.current.forEach((timerId, key) => {
      if (
        key.startsWith(`act:${id}:`) ||
        key.startsWith(`exp:${id}:`) ||
        key === `tripMeta:${id}`
      ) {
        window.clearTimeout(timerId);
        debounceTimersRef.current.delete(key);
      }
    });

    const prevTrips = tripsRef.current;
    const prevActive = activeTripIdRef.current;
    const next = prevTrips.filter((t) => t.id !== id);
    const nextActiveId = prevActive === id ? next[0]?.id || '' : prevActive;

    loadedRemoteTripIdsRef.current.delete(id);
    setTrips(next);
    setActiveTripIdState(nextActiveId);

    const uid = getCurrentVerifiedUid();
    if (uid) {
      try {
        await runTrackedWrite(async () => {
          await deleteTripInFirestore(uid, id);
          if (prevActive === id) {
            await saveActiveTripIdInFirestore(uid, nextActiveId || null);
          }
        }, 'Failed to delete trip from Cloud Firestore');
      } catch (err) {
        loadedRemoteTripIdsRef.current.add(id);
        setTrips(prevTrips);
        setActiveTripIdState(prevActive);
        throw err;
      }
    }

    showToast('Trip removed');
  };

  const loadSampleTrip = async (): Promise<Trip | null> => {
    const existingSample = tripsRef.current.find((t) => t.id === 'trip-udaipur-demo');
    if (existingSample) {
      setActiveTripId(existingSample.id);
      return existingSample;
    }

    const seeded = createSeededDefaultTrip();
    const uid = getCurrentVerifiedUid();
    let persisted = seeded;
    if (uid) {
      persisted = await runTrackedWrite(async () => {
        const saved = await createTripInFirestore(uid, seeded);
        await saveActiveTripIdInFirestore(uid, saved.id);
        return saved;
      }, 'Failed to load sample trip into Cloud Firestore');
    }

    loadedRemoteTripIdsRef.current.add(persisted.id);
    setTrips((prev) => [persisted, ...prev]);
    setActiveTripIdState(persisted.id);
    showToast('Loaded Udaipur sample itinerary');
    return persisted;
  };

  const addActivity = (activityInput: Omit<Activity, 'id' | 'endTime'>) => {
    const duration = Math.max(15, Math.round(Number(activityInput.durationMinutes) || 60));
    const endTime = addMinutesToTime(activityInput.startTime, duration);
    const newAct: Activity = {
      ...activityInput,
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      durationMinutes: duration,
      endTime,
    };

    const updatedTrip = updateActiveTripRecord((trip) => {
      const nextActs = [...trip.activities, newAct];
      return {
        ...trip,
        activities: settingsRef.current.autoSortByTime ? sortActivitiesByTime(nextActs) : nextActs,
      };
    });

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => addActivityInFirestore(uid, updatedTrip.id, newAct),
          'Failed to add activity in Cloud Firestore'
        ).catch((err) => console.error('addActivity Firestore error:', err));
      }
    }

    showToast(`Added "${newAct.title}" to Day ${newAct.day}`);
  };

  const updateActivity = (activityId: string, patch: Partial<Activity>) => {
    const updatedTrip = updateActiveTripRecord((trip) => {
      const nextActs = trip.activities.map((act) => {
        if (act.id !== activityId) return act;
        const startTime = patch.startTime ?? act.startTime;
        const durationMinutes =
          patch.durationMinutes !== undefined
            ? Math.max(15, Math.round(Number(patch.durationMinutes) || 60))
            : act.durationMinutes;
        const endTime = addMinutesToTime(startTime, durationMinutes);
        return {
          ...act,
          ...patch,
          startTime,
          durationMinutes,
          endTime,
        };
      });
      return {
        ...trip,
        activities: settingsRef.current.autoSortByTime ? sortActivitiesByTime(nextActs) : nextActs,
      };
    });

    if (!updatedTrip) return;
    const uid = getCurrentVerifiedUid();
    if (!uid) return;
    const targetTripId = updatedTrip.id;

    scheduleDebouncedWrite(`act:${targetTripId}:${activityId}`, async () => {
      const latestTrip = tripsRef.current.find((t) => t.id === targetTripId);
      const latestAct = latestTrip?.activities.find((a) => a.id === activityId);
      if (!latestAct) return;
      if (!latestAct.title.trim() || !latestAct.location.trim()) return;
      await updateActivityInFirestore(uid, targetTripId, latestAct);
    });
  };

  const deleteActivity = (activityId: string) => {
    const timerKey = activeTrip ? `act:${activeTrip.id}:${activityId}` : '';
    if (timerKey && debounceTimersRef.current.has(timerKey)) {
      window.clearTimeout(debounceTimersRef.current.get(timerKey));
      debounceTimersRef.current.delete(timerKey);
    }

    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      activities: trip.activities.filter((a) => a.id !== activityId),
    }));

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => deleteActivityInFirestore(uid, updatedTrip.id, activityId),
          'Failed to delete activity from Cloud Firestore'
        ).catch((err) => console.error('deleteActivity Firestore error:', err));
      }
    }

    showToast('Activity removed from itinerary');
  };

  const replaceActivityWithAlternative = (
    targetActivityId: string,
    alt: AlternativeActivityOption,
    options?: { preventOverlap?: boolean }
  ): { ok: boolean; error?: string } => {
    if (!activeTrip) return { ok: false, error: 'No active trip' };
    const targetAct = activeTrip.activities.find((a) => a.id === targetActivityId);
    if (!targetAct) return { ok: false, error: 'Activity not found' };

    const startMin = parseTimeToMinutes(targetAct.startTime);
    const endMin = startMin + Math.max(15, alt.durationMinutes);
    if (options?.preventOverlap) {
      if (endMin > 24 * 60) {
        const msg = `Cannot replace: "${alt.title}" extends past midnight.`;
        showToast(msg);
        return { ok: false, error: msg };
      }
      const dayActs = activeTrip.activities.filter((a) => a.day === targetAct.day);
      const conflicts = findOverlappingActivities(dayActs, startMin, endMin, targetAct.id);
      if (conflicts.length > 0) {
        const msg = `Cannot replace: "${alt.title}" (${targetAct.startTime}–${minutesToTime(endMin)}) overlaps with "${conflicts[0].title}" (${conflicts[0].startTime}–${conflicts[0].endTime}).`;
        showToast(msg);
        return { ok: false, error: msg };
      }
    }

    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      activities: trip.activities.map((act) => {
        if (act.id !== targetActivityId) return act;
        const endTime = addMinutesToTime(act.startTime, alt.durationMinutes);
        const hotelLoc = trip.stayMode === 'with-hotel' ? trip.hotel?.location : undefined;
        const distKm =
          hotelLoc && alt.coordinates
            ? haversineDistanceKm(hotelLoc, alt.coordinates)
            : undefined;
        const maxRadius = trip.maxHotelRadiusKm || 10;
        const estTravelMin =
          distKm !== undefined
            ? Math.max(5, Math.round((distKm / (trip.commuteMode === 'WALKING' ? 4.5 : 22)) * 60))
            : undefined;
        return {
          ...act,
          title: alt.title,
          description: alt.description,
          category: alt.category,
          location: alt.location,
          imageUrl: alt.imageUrl,
          durationMinutes: alt.durationMinutes,
          endTime,
          cost: alt.cost,
          isChildFriendly: alt.isChildFriendly,
          crowdLevel: alt.crowdLevel,
          coordinates: alt.coordinates,
          placeId: alt.placeId,
          distanceFromHotelKm: distKm,
          travelFromHotelMinutes: estTravelMin,
          travelFromPrevMinutes: estTravelMin,
          waitingTimeMinutes:
            trip.stayMode === 'with-hotel'
              ? act.waitingTimeMinutes ?? trip.waitingBufferMinutes ?? 15
              : undefined,
          isFarFromHotel: distKm !== undefined ? distKm > maxRadius : undefined,
        };
      }),
    }));

    const swappedAct = updatedTrip?.activities.find((a) => a.id === targetActivityId);
    if (updatedTrip && swappedAct) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => updateActivityInFirestore(uid, updatedTrip.id, swappedAct),
          'Failed to save activity replacement to Cloud Firestore'
        ).catch((err) => console.error('replaceActivity Firestore error:', err));
      }
    }

    showToast(`Replaced "${targetAct.title}" with "${alt.title}"`);
    return { ok: true };
  };

  const moveOrReorderActivity = (activityId: string, targetDay: number, targetIndex?: number) => {
    if (!activeTrip) return;
    const movingOrig = activeTrip.activities.find((a) => a.id === activityId);
    if (!movingOrig) return;
    const movedAcrossDays = movingOrig.day !== targetDay;

    let sequencedActs: Activity[] = [];

    const updatedTrip = updateActiveTripRecord((trip) => {
      const moving = trip.activities.find((a) => a.id === activityId);
      if (!moving) return trip;

      const remaining = trip.activities.filter((a) => a.id !== activityId);
      const targetDayActs = sortActivitiesByTime(remaining.filter((a) => a.day === targetDay));
      const otherDaysActs = remaining.filter((a) => a.day !== targetDay);

      const updatedMoving: Activity = {
        ...moving,
        day: targetDay,
      };

      const insertIdx =
        targetIndex !== undefined
          ? Math.max(0, Math.min(targetDayActs.length, targetIndex))
          : targetDayActs.length;

      targetDayActs.splice(insertIdx, 0, updatedMoving);

      const isWithHotel = trip.stayMode === 'with-hotel';
      let cursor = 8 * 60 + 30;
      const sequencedTargetDay = targetDayActs.map((act, idx) => {
        const dur = Math.max(30, act.durationMinutes || 60);
        if (isWithHotel) {
          const travelGap = act.travelFromPrevMinutes ?? act.travelFromHotelMinutes ?? 15;
          const waitGap = act.waitingTimeMinutes ?? trip.waitingBufferMinutes ?? 10;
          const departureTime = idx === 0 ? minutesToTime(cursor) : undefined;
          const startMin =
            idx === 0
              ? Math.min(10 * 60, cursor + travelGap + waitGap)
              : Math.min(23 * 60, cursor + Math.max(15, travelGap + waitGap));
          const startTime = minutesToTime(startMin);
          const endTime = addMinutesToTime(startTime, dur);
          cursor = Math.min(23 * 60 + 30, startMin + dur);
          return {
            ...act,
            startTime,
            endTime,
            departureFromHotelTime: departureTime,
          };
        }

        const startMin = idx === 0 ? Math.min(cursor, 9 * 60) : Math.min(23 * 60, cursor + 30);
        const startTime = minutesToTime(startMin);
        const endTime = addMinutesToTime(startTime, dur);
        cursor = Math.min(23 * 60 + 30, startMin + dur);
        return {
          ...act,
          startTime,
          endTime,
        };
      });

      sequencedActs = sequencedTargetDay;
      return {
        ...trip,
        activities: [...otherDaysActs, ...sequencedTargetDay],
      };
    });

    if (updatedTrip && sequencedActs.length > 0) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => batchUpdateActivitiesInFirestore(uid, updatedTrip.id, sequencedActs),
          'Failed to save reordered schedule to Cloud Firestore'
        ).catch((err) => console.error('moveOrReorderActivity Firestore error:', err));
      }
    }

    if (movedAcrossDays) {
      showToast(`Moved "${movingOrig.title}" to Day ${targetDay}`);
    }
  };

  const scheduleActivityAtSlot = (
    activityId: string,
    targetDay: number,
    startTime: string
  ): { ok: boolean; error?: string } => {
    if (!activeTrip) return { ok: false, error: 'No active trip' };
    const moving = activeTrip.activities.find((a) => a.id === activityId);
    if (!moving) return { ok: false, error: 'Activity not found' };

    const duration = Math.max(15, moving.durationMinutes || 60);
    const startMin = parseTimeToMinutes(startTime);
    const endMin = startMin + duration;

    if (endMin > 24 * 60) {
      const msg = `"${moving.title}" (${duration}m) cannot extend past 24:00 on Day ${targetDay}.`;
      showToast(msg);
      return { ok: false, error: msg };
    }

    const dayActs = activeTrip.activities.filter((a) => a.day === targetDay);
    const conflicts = findOverlappingActivities(dayActs, startMin, endMin, activityId);
    if (conflicts.length > 0) {
      const msg = `Overlap blocked: ${startTime}–${minutesToTime(endMin)} conflicts with "${conflicts[0].title}" (${conflicts[0].startTime}–${conflicts[0].endTime}).`;
      showToast(msg);
      return { ok: false, error: msg };
    }

    const endTime = minutesToTime(endMin);
    const updatedTrip = updateActiveTripRecord((trip) => {
      const nextActs = trip.activities.map((a) =>
        a.id === activityId ? { ...a, day: targetDay, startTime, endTime } : a
      );
      return {
        ...trip,
        activities: settingsRef.current.autoSortByTime ? sortActivitiesByTime(nextActs) : nextActs,
      };
    });

    const updatedAct = updatedTrip?.activities.find((a) => a.id === activityId);
    if (updatedTrip && updatedAct) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => updateActivityInFirestore(uid, updatedTrip.id, updatedAct),
          'Failed to save scheduled time slot to Cloud Firestore'
        ).catch((err) => console.error('scheduleActivityAtSlot Firestore error:', err));
      }
    }

    showToast(`Scheduled "${moving.title}" on Day ${targetDay} (${startTime}–${endTime})`);
    return { ok: true };
  };

  const addRecommendedAtSlot = (
    alt: AlternativeActivityOption,
    targetDay: number,
    startTime?: string
  ): { ok: boolean; error?: string } => {
    if (!activeTrip) return { ok: false, error: 'No active trip' };
    const duration = Math.max(15, alt.durationMinutes || 60);
    const dayActs = activeTrip.activities.filter((a) => a.day === targetDay);

    let chosenStart = startTime;
    if (chosenStart) {
      const startMin = parseTimeToMinutes(chosenStart);
      const endMin = startMin + duration;
      if (endMin > 24 * 60) {
        const msg = `"${alt.title}" extends past 24:00 on Day ${targetDay}.`;
        showToast(msg);
        return { ok: false, error: msg };
      }
      const conflicts = findOverlappingActivities(dayActs, startMin, endMin);
      if (conflicts.length > 0) {
        const msg = `Cannot add "${alt.title}" at ${chosenStart}–${minutesToTime(endMin)}: overlaps with "${conflicts[0].title}" (${conflicts[0].startTime}–${conflicts[0].endTime}).`;
        showToast(msg);
        return { ok: false, error: msg };
      }
    } else {
      const available = findFirstAvailableSlot(dayActs, duration, 9 * 60);
      if (!available) {
        const msg = `No free ${duration}-minute slot left on Day ${targetDay}.`;
        showToast(msg);
        return { ok: false, error: msg };
      }
      chosenStart = available;
    }

    const endTime = addMinutesToTime(chosenStart, duration);
    const hotelLoc = activeTrip.stayMode === 'with-hotel' ? activeTrip.hotel?.location : undefined;
    const distKm =
      hotelLoc && alt.coordinates ? haversineDistanceKm(hotelLoc, alt.coordinates) : undefined;
    const maxRadius = activeTrip.maxHotelRadiusKm || 10;
    const estTravelMin =
      distKm !== undefined
        ? Math.max(5, Math.round((distKm / (activeTrip.commuteMode === 'WALKING' ? 4.5 : 22)) * 60))
        : undefined;
    const newAct: Activity = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: alt.title,
      description: alt.description,
      category: alt.category,
      location: alt.location,
      imageUrl: alt.imageUrl,
      startTime: chosenStart,
      endTime,
      durationMinutes: duration,
      cost: alt.cost,
      day: targetDay,
      isChildFriendly: alt.isChildFriendly,
      crowdLevel: alt.crowdLevel,
      coordinates: alt.coordinates,
      placeId: alt.placeId,
      distanceFromHotelKm: distKm,
      travelFromHotelMinutes: estTravelMin,
      travelFromPrevMinutes: estTravelMin,
      waitingTimeMinutes:
        activeTrip.stayMode === 'with-hotel' ? activeTrip.waitingBufferMinutes ?? 15 : undefined,
      isFarFromHotel: distKm !== undefined ? distKm > maxRadius : undefined,
    };

    const updatedTrip = updateActiveTripRecord((trip) => {
      const nextActs = [...trip.activities, newAct];
      return {
        ...trip,
        activities: settingsRef.current.autoSortByTime ? sortActivitiesByTime(nextActs) : nextActs,
      };
    });

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => addActivityInFirestore(uid, updatedTrip.id, newAct),
          'Failed to save recommended stop to Cloud Firestore'
        ).catch((err) => console.error('addRecommendedAtSlot Firestore error:', err));
      }
    }

    showToast(`Added "${alt.title}" to Day ${targetDay} (${chosenStart}–${endTime}) · +${formatINR(alt.cost)}`);
    return { ok: true };
  };

  const addActualExpense = (item: {
    name: string;
    amount: number;
    day?: number;
    category?: ExpenseBucket;
    notes?: string;
  }) => {
    const newItem: ActualExpenseItem = {
      id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: item.name.trim(),
      amount: Math.max(0, Number(item.amount) || 0),
      day: item.day || 1,
      category: item.category || 'Food',
      notes: item.notes?.trim() || '',
      createdAt: new Date().toISOString(),
    };

    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      actualExpenses: [...(trip.actualExpenses || []), newItem],
    }));

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => addActualExpenseInFirestore(uid, updatedTrip.id, newItem),
          'Failed to log expense to Cloud Firestore'
        ).catch((err) => console.error('addActualExpense Firestore error:', err));
      }
    }

    showToast(`Logged "${newItem.name}" (${formatINR(newItem.amount)})`);
  };

  const updateActualExpense = (id: string, patch: Partial<ActualExpenseItem>) => {
    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      actualExpenses: (trip.actualExpenses || []).map((exp) =>
        exp.id === id
          ? {
              ...exp,
              ...patch,
              amount: patch.amount !== undefined ? Math.max(0, Number(patch.amount) || 0) : exp.amount,
            }
          : exp
      ),
    }));

    if (!updatedTrip) return;
    const uid = getCurrentVerifiedUid();
    if (!uid) return;
    const targetTripId = updatedTrip.id;

    scheduleDebouncedWrite(`exp:${targetTripId}:${id}`, async () => {
      const latestTrip = tripsRef.current.find((t) => t.id === targetTripId);
      const latestExp = (latestTrip?.actualExpenses || []).find((e) => e.id === id);
      if (!latestExp || latestExp.name.trim().length < 1) return;
      await updateActualExpenseInFirestore(uid, targetTripId, latestExp);
    });
  };

  const deleteActualExpense = (id: string) => {
    const timerKey = activeTrip ? `exp:${activeTrip.id}:${id}` : '';
    if (timerKey && debounceTimersRef.current.has(timerKey)) {
      window.clearTimeout(debounceTimersRef.current.get(timerKey));
      debounceTimersRef.current.delete(timerKey);
    }

    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      actualExpenses: (trip.actualExpenses || []).filter((exp) => exp.id !== id),
    }));

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => deleteActualExpenseInFirestore(uid, updatedTrip.id, id),
          'Failed to delete expense from Cloud Firestore'
        ).catch((err) => console.error('deleteActualExpense Firestore error:', err));
      }
    }

    showToast('Expense entry removed');
  };

  const autoResolveDay = (day: number) => {
    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      activities: autoResolveDayConflicts(trip.activities, day),
    }));

    if (updatedTrip) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        const dayActs = updatedTrip.activities.filter((a) => a.day === day);
        void runTrackedWrite(
          () => batchUpdateActivitiesInFirestore(uid, updatedTrip.id, dayActs),
          'Failed to save resolved day schedule to Cloud Firestore'
        ).catch((err) => console.error('autoResolveDay Firestore error:', err));
      }
    }

    showToast(`Adjusted Day ${day} times to resolve schedule overlaps`);
  };

  const updateDayPace = (dayNumber: number, pace: DayPace) => {
    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      dayPlans: trip.dayPlans.map((dp) =>
        dp.dayNumber === dayNumber ? { ...dp, pace } : dp
      ),
    }));

    const targetPlan = updatedTrip?.dayPlans.find((dp) => dp.dayNumber === dayNumber);
    if (updatedTrip && targetPlan) {
      const uid = getCurrentVerifiedUid();
      if (uid) {
        void runTrackedWrite(
          () => updateDayPlanPaceInFirestore(uid, updatedTrip.id, targetPlan),
          'Failed to save day pace to Cloud Firestore'
        ).catch((err) => console.error('updateDayPace Firestore error:', err));
      }
    }
  };

  const updateTripMeta = (patch: Partial<Pick<Trip, 'name' | 'budget' | 'travelStyle'>>) => {
    const updatedTrip = updateActiveTripRecord((trip) => ({
      ...trip,
      ...patch,
    }));

    if (!updatedTrip) return;
    const uid = getCurrentVerifiedUid();
    if (!uid) return;
    const targetTripId = updatedTrip.id;

    scheduleDebouncedWrite(`tripMeta:${targetTripId}`, async () => {
      const latestTrip = tripsRef.current.find((t) => t.id === targetTripId);
      if (!latestTrip) return;
      if (!latestTrip.name.trim()) return;
      await updateTripMetaInFirestore(
        uid,
        targetTripId,
        {
          name: latestTrip.name,
          budget: latestTrip.budget,
          travelStyle: latestTrip.travelStyle,
        },
        latestTrip.daysCount
      );
    });
  };

  const updateSettings = (patch: Partial<AppSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    showToast('Application settings updated');

    const uid = getCurrentVerifiedUid();
    if (uid) {
      scheduleDebouncedWrite(`settings:${uid}`, async () => {
        await saveUserSettings(uid, settingsRef.current);
      }, 250);
    }
  };

  const resetDemoData = async () => {
    const seeded = createSeededDefaultTrip();
    const uid = getCurrentVerifiedUid();

    if (uid) {
      await runTrackedWrite(async () => {
        const hasSampleAlready = tripsRef.current.some((t) => t.id === seeded.id);
        if (hasSampleAlready) {
          await deleteTripInFirestore(uid, seeded.id);
        }
        await createTripInFirestore(uid, seeded);
        await saveActiveTripIdInFirestore(uid, seeded.id);
        await saveUserSettings(uid, DEFAULT_APP_SETTINGS);
      }, 'Failed to restore sample itinerary in Cloud Firestore');
    }

    loadedRemoteTripIdsRef.current.add(seeded.id);
    setTrips((prev) => {
      const others = prev.filter((t) => t.id !== seeded.id);
      return [seeded, ...others];
    });
    setActiveTripIdState(seeded.id);
    setSettings(DEFAULT_APP_SETTINGS);
    setWizardDraft(DEFAULT_WIZARD_DRAFT);
    showToast('Restored default Udaipur sample itinerary');
  };

  const runLocalMigration = async (): Promise<MigrationExecutionResult> => {
    const uid = getCurrentVerifiedUid();
    if (!uid) {
      return {
        ok: false,
        error: 'You must be signed in with a verified account to migrate trips.',
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

    setMigrationStatus('migrating');
    setMigrationError(null);

    const res = await migrateLocalStorageToFirestore(uid);
    if (!res.ok) {
      setMigrationStatus('failed');
      setMigrationError(res.error || 'Migration failed. Please retry.');
      return res;
    }

    // Re-hydrate full trips, settings, and address from Firestore after verified migration
    try {
      const [freshTrips, freshSettings, freshAddr] = await Promise.all([
        loadUserTripsWithDetails(uid),
        loadOrInitUserSettings(uid),
        loadUserSavedAddress(uid),
      ]);
      loadedRemoteTripIdsRef.current = new Set(freshTrips.map((t) => t.id));
      setTrips(freshTrips);
      setSettings(freshSettings);
      setUserAddressState(freshAddr);
      if (freshTrips.length > 0 && !freshTrips.some((t) => t.id === activeTripIdRef.current)) {
        setActiveTripIdState(freshTrips[0].id);
      }
    } catch (err) {
      console.error('Post-migration refresh warning:', err);
    }

    setMigrationCandidate(null);
    setMigrationStatus('completed');
    showToast(
      `Migrated ${res.verifiedCounts.trips} trip${res.verifiedCounts.trips === 1 ? '' : 's'} to Cloud Firestore`
    );
    return res;
  };

  const dismissLocalMigration = async (): Promise<void> => {
    const uid = getCurrentVerifiedUid();
    if (uid) {
      try {
        await dismissMigrationPrompt(uid);
      } catch (err) {
        console.error('Failed to persist migration dismissal:', err);
      }
    }
    setMigrationStatus('idle');
  };

  const notifications = useMemo<AppNotification[]>(() => {
    const list: AppNotification[] = [];
    if (activeTrip && activeTripMetrics) {
      if (activeTripMetrics.isOverBudget) {
        const id = `notif-overbudget-${activeTrip.id}-${activeTripMetrics.totalEstimatedExpense}`;
        list.push({
          id,
          title: 'Budget Exceeded',
          message: `${activeTrip.name} is ${formatINR(Math.abs(activeTripMetrics.remainingBudget))} over your ${formatINR(activeTrip.budget.total)} budget.`,
          type: 'warning',
          read: readNotificationIds.includes(id),
          createdAt: 'Just now',
          actionRoute: '/expenses',
        });
      } else if (activeTripMetrics.budgetUtilizationPct >= settings.budgetWarningThresholdPct) {
        const id = `notif-nearbudget-${activeTrip.id}-${activeTripMetrics.budgetUtilizationPct}`;
        list.push({
          id,
          title: 'Approaching Budget Limit',
          message: `You have allocated ${activeTripMetrics.budgetUtilizationPct}% of your ${formatINR(activeTrip.budget.total)} trip budget.`,
          type: 'info',
          read: readNotificationIds.includes(id),
          createdAt: 'Active',
          actionRoute: '/expenses',
        });
      }

      if (settings.enableConflictDetection && activeTripMetrics.totalConflictsCount > 0) {
        const id = `notif-conflict-${activeTrip.id}-${activeTripMetrics.totalConflictsCount}`;
        list.push({
          id,
          title: 'Schedule Overlap Detected',
          message: `${activeTripMetrics.totalConflictsCount} time conflict${activeTripMetrics.totalConflictsCount > 1 ? 's' : ''} found in ${activeTrip.destination}. Review in the planner.`,
          type: 'warning',
          read: readNotificationIds.includes(id),
          createdAt: 'Schedule check',
          actionRoute: '/planner',
        });
      }

      const idSaved = `notif-saved-${activeTrip.id}`;
      list.push({
        id: idSaved,
        title: 'Itinerary Synced to Cloud',
        message: `${activeTrip.activities.length} activities across ${activeTrip.daysCount} days are saved in your TripMate cloud account.`,
        type: 'success',
        read: readNotificationIds.includes(idSaved),
        createdAt: isSyncing ? 'Syncing…' : 'Cloud Firestore',
        actionRoute: '/dashboard',
      });
    }
    return list;
  }, [activeTrip, activeTripMetrics, readNotificationIds, settings, isSyncing]);

  const markAllNotificationsRead = () => {
    setReadNotificationIds(notifications.map((n) => n.id));
  };

  return (
    <TripContext.Provider
      value={{
        user,
        isAuthenticated: Boolean(user),
        authLoading,
        login,
        register,
        loginWithGoogle,
        resendVerificationEmail,
        resetPassword,
        logout,
        updateProfile,
        userAddress,
        isAddressModalOpen,
        setIsAddressModalOpen,
        saveUserAddress,
        dismissAddressPrompt,
        trips,
        tripsLoading,
        tripsError,
        isSyncing,
        activeTrip,
        activeTripMetrics,
        activeTripAiOverview: activeTrip ? aiOverviewByTripId[activeTrip.id] || null : null,
        setActiveTripId,
        createTripAsync,
        regenerateActiveTrip,
        regenerateDayWithAi,
        refineActivityWithAi,
        applyAiBudgetEstimate,
        duplicateTrip,
        deleteTrip,
        loadSampleTrip,
        addActivity,
        updateActivity,
        deleteActivity,
        replaceActivityWithAlternative,
        moveOrReorderActivity,
        scheduleActivityAtSlot,
        addRecommendedAtSlot,
        addActualExpense,
        updateActualExpense,
        deleteActualExpense,
        autoResolveDay,
        updateDayPace,
        updateTripMeta,
        wizardDraft,
        setWizardDraft,
        selectedSwapActivityId,
        setSelectedSwapActivityId,
        settings,
        updateSettings,
        resetDemoData,
        migrationCandidate,
        migrationStatus,
        migrationError,
        runLocalMigration,
        dismissLocalMigration,
        notifications,
        readNotificationIds,
        markAllNotificationsRead,
        toastMessage,
        showToast,
      }}
    >
      {children}
    </TripContext.Provider>
  );
};

export function useTripContext(): TripContextValue {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error('useTripContext must be used inside TripProvider');
  return ctx;
}
