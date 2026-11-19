import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  Activity,
  ActivityCategory,
  ActualExpenseItem,
  BudgetBreakdown,
  CommuteMode,
  DayPace,
  DayPlan,
  ExpenseBucket,
  HotelInfo,
  StayMode,
  TravelStyle,
  Trip,
} from '../types/trip';
import {
  BatchWriteOperation,
  clampInt,
  clampNumber,
  commitChunkedOperations,
  handleFirestoreError,
  OperationType,
  sanitizeGeoPoint,
  sanitizeNotesList,
  sanitizeTimeHHMM,
  stripUndefined,
  toIsoString,
  toValidFirestoreId,
} from './firestoreHelpers';

const VALID_STYLES: TravelStyle[] = ['Adventure', 'Relaxed', 'Balanced', 'Custom'];
const VALID_PACES: DayPace[] = ['Relaxed', 'Balanced', 'Activity-heavy'];
const VALID_STAY_MODES: StayMode[] = ['without-hotel', 'with-hotel'];
const VALID_COMMUTE_MODES: CommuteMode[] = ['DRIVING', 'TRANSIT', 'WALKING', 'TWO_WHEELER'];
const VALID_CATEGORIES: ActivityCategory[] = [
  'Food',
  'Attraction',
  'Transport',
  'Leisure',
  'Nature',
  'Culture',
];
const VALID_EXPENSE_BUCKETS: ExpenseBucket[] = ['Food', 'Attraction', 'Transport', 'Leisure'];

function sanitizeBudget(budget: Partial<BudgetBreakdown> | undefined, daysCount: number): BudgetBreakdown {
  const total = clampNumber(budget?.total, 0, 100000000, 15000);
  const daily = clampNumber(budget?.daily, 0, 100000000, Math.round(total / Math.max(1, daysCount)));
  const food = clampNumber(budget?.food, 0, 100000000, Math.round(total * 0.3));
  const transport = clampNumber(budget?.transport, 0, 100000000, Math.round(total * 0.2));
  const attraction = clampNumber(budget?.attraction, 0, 100000000, Math.round(total * 0.5));
  return { total, daily, food, transport, attraction };
}

function sanitizeHotel(hotel: HotelInfo | null | undefined): HotelInfo | null {
  if (!hotel) return null;
  const loc = sanitizeGeoPoint(hotel.location);
  if (!loc) return null;
  const name = (hotel.name || '').trim().slice(0, 200);
  const formattedAddress = (hotel.formattedAddress || name).trim().slice(0, 300);
  if (!name || !formattedAddress) return null;
  const out: HotelInfo = {
    name,
    formattedAddress,
    location: loc,
  };
  if (typeof hotel.placeId === 'string' && hotel.placeId.trim()) {
    out.placeId = hotel.placeId.trim().slice(0, 200);
  }
  if (typeof hotel.rating === 'number' && Number.isFinite(hotel.rating)) {
    out.rating = clampNumber(hotel.rating, 0, 5, 4);
  }
  return out;
}

function buildTripFields(uid: string, trip: Trip) {
  const daysCount = clampInt(trip.daysCount, 1, 14, 3);
  const stayMode: StayMode =
    trip.stayMode && VALID_STAY_MODES.includes(trip.stayMode) ? trip.stayMode : 'without-hotel';
  const commuteMode: CommuteMode =
    trip.commuteMode && VALID_COMMUTE_MODES.includes(trip.commuteMode)
      ? trip.commuteMode
      : 'DRIVING';
  const travelStyle: TravelStyle = VALID_STYLES.includes(trip.travelStyle)
    ? trip.travelStyle
    : 'Balanced';

  return stripUndefined({
    userId: uid,
    name: (trip.name || `${trip.destination} Trip`).trim().slice(0, 160) || 'TripMate Journey',
    origin: (trip.origin || 'Bengaluru').trim().slice(0, 120) || 'Bengaluru',
    destination: (trip.destination || 'Jaipur').trim().slice(0, 120) || 'Jaipur',
    daysCount,
    adults: clampInt(trip.adults, 1, 30, 1),
    children: clampInt(trip.children, 0, 30, 0),
    travelStyle,
    budget: sanitizeBudget(trip.budget, daysCount),
    generalNotes: sanitizeNotesList(trip.generalNotes, []),
    stayMode,
    hotel: sanitizeHotel(trip.hotel),
    commuteMode,
    maxHotelRadiusKm: clampNumber(trip.maxHotelRadiusKm, 1, 100, 10),
    waitingBufferMinutes: clampInt(trip.waitingBufferMinutes, 0, 180, 15),
  });
}

function buildPlannedBudgetFields(uid: string, tripId: string, budget: BudgetBreakdown, daysCount: number) {
  return {
    userId: uid,
    tripId,
    ...sanitizeBudget(budget, daysCount),
  };
}

function buildDayPlanFields(uid: string, tripId: string, dp: DayPlan) {
  const dayNumber = clampInt(dp.dayNumber, 1, 14, 1);
  return {
    userId: uid,
    tripId,
    dayNumber,
    title: (dp.title || `Day ${dayNumber}`).trim().slice(0, 160) || `Day ${dayNumber}`,
    pace: VALID_PACES.includes(dp.pace) ? dp.pace : 'Balanced',
    notes: sanitizeNotesList(dp.notes, []),
  };
}

function buildActivityFields(uid: string, tripId: string, act: Activity, isUpdate = false) {
  const startTime = sanitizeTimeHHMM(act.startTime, '09:00');
  const endTime = sanitizeTimeHHMM(act.endTime, '10:00');
  const category: ActivityCategory = VALID_CATEGORIES.includes(act.category)
    ? act.category
    : 'Attraction';
  const coords = sanitizeGeoPoint(act.coordinates);
  const crowdLevel =
    act.crowdLevel && ['Low', 'Moderate', 'High'].includes(act.crowdLevel)
      ? act.crowdLevel
      : undefined;

  const optionalOrDelete = <T>(val: T | undefined): T | ReturnType<typeof deleteField> | undefined => {
    if (val !== undefined) return val;
    return isUpdate ? deleteField() : undefined;
  };

  return stripUndefined({
    userId: uid,
    tripId,
    title: (act.title || 'Activity').trim().slice(0, 180) || 'Activity',
    description: (act.description || '').trim().slice(0, 1000),
    category,
    location: (act.location || 'City Center').trim().slice(0, 300) || 'City Center',
    imageUrl: (act.imageUrl || '').trim().slice(0, 1000),
    startTime,
    endTime,
    durationMinutes: clampInt(act.durationMinutes, 15, 1440, 60),
    cost: clampNumber(act.cost, 0, 10000000, 0),
    day: clampInt(act.day, 1, 14, 1),
    isChildFriendly: typeof act.isChildFriendly === 'boolean' ? act.isChildFriendly : undefined,
    crowdLevel,
    notes:
      typeof act.notes === 'string'
        ? act.notes.trim().slice(0, 500)
        : isUpdate
        ? deleteField()
        : undefined,
    placeId:
      typeof act.placeId === 'string' && act.placeId.trim()
        ? act.placeId.trim().slice(0, 200)
        : isUpdate
        ? deleteField()
        : undefined,
    coordinates: optionalOrDelete(coords),
    travelFromHotelMinutes:
      act.travelFromHotelMinutes !== undefined
        ? clampNumber(act.travelFromHotelMinutes, 0, 1440, 0)
        : isUpdate
        ? deleteField()
        : undefined,
    travelFromPrevMinutes:
      act.travelFromPrevMinutes !== undefined
        ? clampNumber(act.travelFromPrevMinutes, 0, 1440, 0)
        : isUpdate
        ? deleteField()
        : undefined,
    waitingTimeMinutes:
      act.waitingTimeMinutes !== undefined
        ? clampNumber(act.waitingTimeMinutes, 0, 480, 0)
        : isUpdate
        ? deleteField()
        : undefined,
    distanceFromHotelKm:
      act.distanceFromHotelKm !== undefined
        ? clampNumber(act.distanceFromHotelKm, 0, 5000, 0)
        : isUpdate
        ? deleteField()
        : undefined,
    isFarFromHotel:
      typeof act.isFarFromHotel === 'boolean'
        ? act.isFarFromHotel
        : isUpdate
        ? deleteField()
        : undefined,
    departureFromHotelTime:
      typeof act.departureFromHotelTime === 'string' &&
      /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(act.departureFromHotelTime.trim())
        ? act.departureFromHotelTime.trim()
        : isUpdate
        ? deleteField()
        : undefined,
  });
}

function buildActualExpenseFields(uid: string, tripId: string, exp: ActualExpenseItem) {
  const category: ExpenseBucket = VALID_EXPENSE_BUCKETS.includes(exp.category)
    ? exp.category
    : 'Food';
  return stripUndefined({
    userId: uid,
    tripId,
    name: (exp.name || 'Expense').trim().slice(0, 160) || 'Expense',
    amount: clampNumber(exp.amount, 0, 10000000, 0),
    day: clampInt(exp.day, 1, 14, 1),
    category,
    notes: typeof exp.notes === 'string' ? exp.notes.trim().slice(0, 500) : '',
  });
}

function mapDocToActivity(id: string, data: Record<string, unknown>): Activity {
  const coords = sanitizeGeoPoint(data.coordinates);
  return {
    id,
    title: typeof data.title === 'string' ? data.title : 'Activity',
    description: typeof data.description === 'string' ? data.description : '',
    category: VALID_CATEGORIES.includes(data.category as ActivityCategory)
      ? (data.category as ActivityCategory)
      : 'Attraction',
    location: typeof data.location === 'string' ? data.location : '',
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
    startTime: sanitizeTimeHHMM(data.startTime, '09:00'),
    endTime: sanitizeTimeHHMM(data.endTime, '10:00'),
    durationMinutes: clampInt(data.durationMinutes, 15, 1440, 60),
    cost: clampNumber(data.cost, 0, 10000000, 0),
    day: clampInt(data.day, 1, 14, 1),
    isChildFriendly: typeof data.isChildFriendly === 'boolean' ? data.isChildFriendly : undefined,
    crowdLevel:
      data.crowdLevel && ['Low', 'Moderate', 'High'].includes(String(data.crowdLevel))
        ? (data.crowdLevel as Activity['crowdLevel'])
        : undefined,
    notes: typeof data.notes === 'string' ? data.notes : undefined,
    placeId: typeof data.placeId === 'string' ? data.placeId : undefined,
    coordinates: coords,
    travelFromHotelMinutes:
      typeof data.travelFromHotelMinutes === 'number' ? data.travelFromHotelMinutes : undefined,
    travelFromPrevMinutes:
      typeof data.travelFromPrevMinutes === 'number' ? data.travelFromPrevMinutes : undefined,
    waitingTimeMinutes:
      typeof data.waitingTimeMinutes === 'number' ? data.waitingTimeMinutes : undefined,
    distanceFromHotelKm:
      typeof data.distanceFromHotelKm === 'number' ? data.distanceFromHotelKm : undefined,
    isFarFromHotel: typeof data.isFarFromHotel === 'boolean' ? data.isFarFromHotel : undefined,
    departureFromHotelTime:
      typeof data.departureFromHotelTime === 'string' ? data.departureFromHotelTime : undefined,
  };
}

function mapDocToDayPlan(data: Record<string, unknown>): DayPlan {
  return {
    dayNumber: clampInt(data.dayNumber, 1, 14, 1),
    title: typeof data.title === 'string' ? data.title : 'Day Exploration',
    pace: VALID_PACES.includes(data.pace as DayPace) ? (data.pace as DayPace) : 'Balanced',
    notes: Array.isArray(data.notes) ? (data.notes as string[]) : [],
  };
}

function mapDocToActualExpense(id: string, data: Record<string, unknown>): ActualExpenseItem {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Expense',
    amount: clampNumber(data.amount, 0, 10000000, 0),
    day: clampInt(data.day, 1, 14, 1),
    category: VALID_EXPENSE_BUCKETS.includes(data.category as ExpenseBucket)
      ? (data.category as ExpenseBucket)
      : 'Food',
    notes: typeof data.notes === 'string' ? data.notes : '',
    createdAt: toIsoString(data.createdAt),
  };
}

function mapDocToTripSkeleton(
  id: string,
  data: Record<string, unknown>,
  subcollections?: {
    activities?: Activity[];
    dayPlans?: DayPlan[];
    budgetOverride?: BudgetBreakdown;
    actualExpenses?: ActualExpenseItem[];
  }
): Trip {
  const daysCount = clampInt(data.daysCount, 1, 14, 3);
  const rawBudget = (data.budget as Partial<BudgetBreakdown>) || {};
  const budget = subcollections?.budgetOverride || sanitizeBudget(rawBudget, daysCount);
  const hotel = sanitizeHotel((data.hotel as HotelInfo | null) || null);
  const fallbackDayPlans: DayPlan[] = Array.from({ length: daysCount }, (_, i) => ({
    dayNumber: i + 1,
    title: `Day ${i + 1}`,
    pace: 'Balanced',
    notes: [],
  }));

  const dayPlans =
    subcollections?.dayPlans && subcollections.dayPlans.length > 0
      ? [...subcollections.dayPlans].sort((a, b) => a.dayNumber - b.dayNumber)
      : fallbackDayPlans;

  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Trip',
    origin: typeof data.origin === 'string' ? data.origin : 'Bengaluru',
    destination: typeof data.destination === 'string' ? data.destination : 'Jaipur',
    daysCount,
    adults: clampInt(data.adults, 1, 30, 1),
    children: clampInt(data.children, 0, 30, 0),
    budget,
    travelStyle: VALID_STYLES.includes(data.travelStyle as TravelStyle)
      ? (data.travelStyle as TravelStyle)
      : 'Balanced',
    dayPlans,
    activities: subcollections?.activities || [],
    actualExpenses: subcollections?.actualExpenses || [],
    generalNotes: Array.isArray(data.generalNotes) ? (data.generalNotes as string[]) : [],
    stayMode: VALID_STAY_MODES.includes(data.stayMode as StayMode)
      ? (data.stayMode as StayMode)
      : 'without-hotel',
    hotel,
    commuteMode: VALID_COMMUTE_MODES.includes(data.commuteMode as CommuteMode)
      ? (data.commuteMode as CommuteMode)
      : 'DRIVING',
    maxHotelRadiusKm:
      typeof data.maxHotelRadiusKm === 'number' ? data.maxHotelRadiusKm : 10,
    waitingBufferMinutes:
      typeof data.waitingBufferMinutes === 'number' ? data.waitingBufferMinutes : 15,
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export async function loadTripSubcollections(
  uid: string,
  tripId: string
): Promise<{
  activities: Activity[];
  dayPlans: DayPlan[];
  budget?: BudgetBreakdown;
  actualExpenses: ActualExpenseItem[];
}> {
  const basePath = `users/${uid}/trips/${tripId}`;
  const actQuery = query(
    collection(db, 'users', uid, 'trips', tripId, 'activities'),
    where('userId', '==', uid)
  );
  const dayPlanQuery = query(
    collection(db, 'users', uid, 'trips', tripId, 'dayPlans'),
    where('userId', '==', uid)
  );
  const budgetQuery = query(
    collection(db, 'users', uid, 'trips', tripId, 'budgets'),
    where('userId', '==', uid)
  );
  const expQuery = query(
    collection(db, 'users', uid, 'trips', tripId, 'actualExpenses'),
    where('userId', '==', uid)
  );

  try {
    const [actSnap, dpSnap, budgetSnap, expSnap] = await Promise.all([
      getDocs(actQuery),
      getDocs(dayPlanQuery),
      getDocs(budgetQuery),
      getDocs(expQuery),
    ]);

    const activities = actSnap.docs.map((d) =>
      mapDocToActivity(d.id, d.data() as Record<string, unknown>)
    );
    const dayPlans = dpSnap.docs
      .map((d) => mapDocToDayPlan(d.data() as Record<string, unknown>))
      .sort((a, b) => a.dayNumber - b.dayNumber);
    const plannedDoc = budgetSnap.docs.find((d) => d.id === 'planned') || budgetSnap.docs[0];
    const budget = plannedDoc
      ? sanitizeBudget(plannedDoc.data() as Partial<BudgetBreakdown>, Math.max(1, dayPlans.length))
      : undefined;
    const actualExpenses = expSnap.docs
      .map((d) => mapDocToActualExpense(d.id, d.data() as Record<string, unknown>))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { activities, dayPlans, budget, actualExpenses };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, basePath);
  }
}

export async function loadUserTripsWithDetails(uid: string): Promise<Trip[]> {
  const path = `users/${uid}/trips`;
  const tripsQuery = query(collection(db, 'users', uid, 'trips'), where('userId', '==', uid));

  let tripSnap;
  try {
    tripSnap = await getDocs(tripsQuery);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }

  const trips = await Promise.all(
    tripSnap.docs.map(async (tripDoc) => {
      const sub = await loadTripSubcollections(uid, tripDoc.id);
      return mapDocToTripSkeleton(tripDoc.id, tripDoc.data() as Record<string, unknown>, {
        activities: sub.activities,
        dayPlans: sub.dayPlans,
        budgetOverride: sub.budget,
        actualExpenses: sub.actualExpenses,
      });
    })
  );

  return trips.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function subscribeToUserTripsList(
  uid: string,
  onTripsUpdate: (trips: { id: string; skeleton: Trip }[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${uid}/trips`;
  const tripsQuery = query(collection(db, 'users', uid, 'trips'), where('userId', '==', uid));

  return onSnapshot(
    tripsQuery,
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({
          id: d.id,
          skeleton: mapDocToTripSkeleton(d.id, d.data() as Record<string, unknown>),
        }))
        .sort((a, b) => b.skeleton.updatedAt.localeCompare(a.skeleton.updatedAt));
      onTripsUpdate(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

export function subscribeToActiveTripSubcollections(
  uid: string,
  tripId: string,
  callbacks: {
    onActivities: (activities: Activity[]) => void;
    onDayPlans: (dayPlans: DayPlan[]) => void;
    onBudget: (budget: BudgetBreakdown) => void;
    onActualExpenses: (expenses: ActualExpenseItem[]) => void;
    onError?: (err: Error) => void;
  }
): Unsubscribe {
  const handleErr = (path: string, error: unknown) => {
    try {
      handleFirestoreError(error, OperationType.LIST, path);
    } catch (wrapped) {
      callbacks.onError?.(wrapped as Error);
    }
  };

  const actPath = `users/${uid}/trips/${tripId}/activities`;
  const unsubAct = onSnapshot(
    query(collection(db, 'users', uid, 'trips', tripId, 'activities'), where('userId', '==', uid)),
    (snap) => {
      callbacks.onActivities(
        snap.docs.map((d) => mapDocToActivity(d.id, d.data() as Record<string, unknown>))
      );
    },
    (err) => handleErr(actPath, err)
  );

  const dpPath = `users/${uid}/trips/${tripId}/dayPlans`;
  const unsubDp = onSnapshot(
    query(collection(db, 'users', uid, 'trips', tripId, 'dayPlans'), where('userId', '==', uid)),
    (snap) => {
      callbacks.onDayPlans(
        snap.docs
          .map((d) => mapDocToDayPlan(d.data() as Record<string, unknown>))
          .sort((a, b) => a.dayNumber - b.dayNumber)
      );
    },
    (err) => handleErr(dpPath, err)
  );

  const budgetPath = `users/${uid}/trips/${tripId}/budgets/planned`;
  const unsubBudget = onSnapshot(
    doc(db, 'users', uid, 'trips', tripId, 'budgets', 'planned'),
    (snap) => {
      if (snap.exists()) {
        callbacks.onBudget(sanitizeBudget(snap.data() as Partial<BudgetBreakdown>, 1));
      }
    },
    (err) => handleErr(budgetPath, err)
  );

  const expPath = `users/${uid}/trips/${tripId}/actualExpenses`;
  const unsubExp = onSnapshot(
    query(
      collection(db, 'users', uid, 'trips', tripId, 'actualExpenses'),
      where('userId', '==', uid)
    ),
    (snap) => {
      callbacks.onActualExpenses(
        snap.docs
          .map((d) => mapDocToActualExpense(d.id, d.data() as Record<string, unknown>))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      );
    },
    (err) => handleErr(expPath, err)
  );

  return () => {
    unsubAct();
    unsubDp();
    unsubBudget();
    unsubExp();
  };
}

export async function createTripInFirestore(uid: string, rawTrip: Trip): Promise<Trip> {
  const tripId = toValidFirestoreId(rawTrip.id, 'trip');
  const tripRef = doc(db, 'users', uid, 'trips', tripId);
  const tripPath = `users/${uid}/trips/${tripId}`;

  const cleanActivities: Activity[] = rawTrip.activities.map((a, idx) => ({
    ...a,
    id: toValidFirestoreId(a.id, `act-${idx + 1}`),
  }));
  const cleanExpenses: ActualExpenseItem[] = (rawTrip.actualExpenses || []).map((e, idx) => ({
    ...e,
    id: toValidFirestoreId(e.id, `exp-${idx + 1}`),
  }));
  const cleanDayPlans: DayPlan[] =
    rawTrip.dayPlans.length > 0
      ? rawTrip.dayPlans.slice(0, 14)
      : Array.from({ length: clampInt(rawTrip.daysCount, 1, 14, 3) }, (_, i) => ({
          dayNumber: i + 1,
          title: `Day ${i + 1}`,
          pace: 'Balanced' as DayPace,
          notes: [],
        }));

  const normalizedTrip: Trip = {
    ...rawTrip,
    id: tripId,
    dayPlans: cleanDayPlans,
    activities: cleanActivities,
    actualExpenses: cleanExpenses,
  };

  const ops: BatchWriteOperation[] = [];
  ops.push({
    type: 'set',
    ref: tripRef,
    path: tripPath,
    data: {
      ...buildTripFields(uid, normalizedTrip),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  });

  ops.push({
    type: 'set',
    ref: doc(db, 'users', uid, 'trips', tripId, 'budgets', 'planned'),
    path: `${tripPath}/budgets/planned`,
    data: {
      ...buildPlannedBudgetFields(uid, tripId, normalizedTrip.budget, normalizedTrip.daysCount),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  });

  for (const dp of cleanDayPlans) {
    const dpId = `day-${clampInt(dp.dayNumber, 1, 14, 1)}`;
    ops.push({
      type: 'set',
      ref: doc(db, 'users', uid, 'trips', tripId, 'dayPlans', dpId),
      path: `${tripPath}/dayPlans/${dpId}`,
      data: {
        ...buildDayPlanFields(uid, tripId, dp),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const act of cleanActivities) {
    ops.push({
      type: 'set',
      ref: doc(db, 'users', uid, 'trips', tripId, 'activities', act.id),
      path: `${tripPath}/activities/${act.id}`,
      data: {
        ...buildActivityFields(uid, tripId, act, false),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const exp of cleanExpenses) {
    ops.push({
      type: 'set',
      ref: doc(db, 'users', uid, 'trips', tripId, 'actualExpenses', exp.id),
      path: `${tripPath}/actualExpenses/${exp.id}`,
      data: {
        ...buildActualExpenseFields(uid, tripId, exp),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  await commitChunkedOperations(ops, OperationType.CREATE);
  return normalizedTrip;
}

export async function updateTripMetaInFirestore(
  uid: string,
  tripId: string,
  patch: Partial<Pick<Trip, 'name' | 'budget' | 'travelStyle'>>,
  daysCount: number
): Promise<void> {
  const tripPath = `users/${uid}/trips/${tripId}`;
  const tripRef = doc(db, 'users', uid, 'trips', tripId);

  const ops: BatchWriteOperation[] = [];
  const tripPatch: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (patch.name !== undefined) {
    const cleanName = patch.name.trim().slice(0, 160);
    if (cleanName.length >= 1) tripPatch.name = cleanName;
  }
  if (patch.travelStyle !== undefined && VALID_STYLES.includes(patch.travelStyle)) {
    tripPatch.travelStyle = patch.travelStyle;
  }
  if (patch.budget !== undefined) {
    const cleanBudget = sanitizeBudget(patch.budget, daysCount);
    tripPatch.budget = cleanBudget;
    const budgetRef = doc(db, 'users', uid, 'trips', tripId, 'budgets', 'planned');
    const budgetSnap = await getDoc(budgetRef).catch((err) =>
      handleFirestoreError(err, OperationType.GET, `${tripPath}/budgets/planned`)
    );
    if (budgetSnap.exists()) {
      ops.push({
        type: 'update',
        ref: budgetRef,
        path: `${tripPath}/budgets/planned`,
        data: {
          ...cleanBudget,
          updatedAt: serverTimestamp(),
        },
      });
    } else {
      ops.push({
        type: 'set',
        ref: budgetRef,
        path: `${tripPath}/budgets/planned`,
        data: {
          userId: uid,
          tripId,
          ...cleanBudget,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }
  }

  ops.unshift({
    type: 'update',
    ref: tripRef,
    path: tripPath,
    data: tripPatch,
  });

  await commitChunkedOperations(ops, OperationType.UPDATE);
}

export async function replaceTripItineraryInFirestore(
  uid: string,
  updatedTrip: Trip
): Promise<void> {
  const tripId = updatedTrip.id;
  const tripPath = `users/${uid}/trips/${tripId}`;
  const tripRef = doc(db, 'users', uid, 'trips', tripId);

  let oldActSnap;
  let oldDpSnap;
  try {
    [oldActSnap, oldDpSnap] = await Promise.all([
      getDocs(
        query(collection(db, 'users', uid, 'trips', tripId, 'activities'), where('userId', '==', uid))
      ),
      getDocs(
        query(collection(db, 'users', uid, 'trips', tripId, 'dayPlans'), where('userId', '==', uid))
      ),
    ]);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, tripPath);
  }

  const deleteOps: BatchWriteOperation[] = [];
  for (const d of oldActSnap.docs) {
    deleteOps.push({
      type: 'delete',
      ref: d.ref,
      path: `${tripPath}/activities/${d.id}`,
    });
  }
  const existingDayPlanIds = new Set<string>();
  for (const d of oldDpSnap.docs) {
    existingDayPlanIds.add(d.id);
  }
  const desiredDayPlanIds = new Set(
    updatedTrip.dayPlans.map((dp) => `day-${clampInt(dp.dayNumber, 1, 14, 1)}`)
  );
  for (const existingId of existingDayPlanIds) {
    if (!desiredDayPlanIds.has(existingId)) {
      deleteOps.push({
        type: 'delete',
        ref: doc(db, 'users', uid, 'trips', tripId, 'dayPlans', existingId),
        path: `${tripPath}/dayPlans/${existingId}`,
      });
    }
  }
  await commitChunkedOperations(deleteOps, OperationType.DELETE);

  const writeOps: BatchWriteOperation[] = [];
  const tripFields = buildTripFields(uid, updatedTrip);
  // Keep only updatable trip fields (never overwrite userId or createdAt)
  const { userId: _omitUserId, ...updatableTripFields } = tripFields;
  void _omitUserId;

  writeOps.push({
    type: 'update',
    ref: tripRef,
    path: tripPath,
    data: {
      ...updatableTripFields,
      updatedAt: serverTimestamp(),
    },
  });

  const budgetRef = doc(db, 'users', uid, 'trips', tripId, 'budgets', 'planned');
  const budgetSnap = await getDoc(budgetRef).catch((err) =>
    handleFirestoreError(err, OperationType.GET, `${tripPath}/budgets/planned`)
  );
  if (budgetSnap.exists()) {
    writeOps.push({
      type: 'update',
      ref: budgetRef,
      path: `${tripPath}/budgets/planned`,
      data: {
        ...sanitizeBudget(updatedTrip.budget, updatedTrip.daysCount),
        updatedAt: serverTimestamp(),
      },
    });
  } else {
    writeOps.push({
      type: 'set',
      ref: budgetRef,
      path: `${tripPath}/budgets/planned`,
      data: {
        ...buildPlannedBudgetFields(uid, tripId, updatedTrip.budget, updatedTrip.daysCount),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const dp of updatedTrip.dayPlans) {
    const dpId = `day-${clampInt(dp.dayNumber, 1, 14, 1)}`;
    const dpRef = doc(db, 'users', uid, 'trips', tripId, 'dayPlans', dpId);
    const dpFields = buildDayPlanFields(uid, tripId, dp);
    if (existingDayPlanIds.has(dpId)) {
      writeOps.push({
        type: 'update',
        ref: dpRef,
        path: `${tripPath}/dayPlans/${dpId}`,
        data: {
          title: dpFields.title,
          pace: dpFields.pace,
          notes: dpFields.notes,
          updatedAt: serverTimestamp(),
        },
      });
    } else {
      writeOps.push({
        type: 'set',
        ref: dpRef,
        path: `${tripPath}/dayPlans/${dpId}`,
        data: {
          ...dpFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }
  }

  for (const act of updatedTrip.activities) {
    const cleanId = toValidFirestoreId(act.id, 'act');
    writeOps.push({
      type: 'set',
      ref: doc(db, 'users', uid, 'trips', tripId, 'activities', cleanId),
      path: `${tripPath}/activities/${cleanId}`,
      data: {
        ...buildActivityFields(uid, tripId, { ...act, id: cleanId }, false),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  await commitChunkedOperations(writeOps, OperationType.WRITE);
}

/**
 * Replaces ONLY a single day's DayPlan metadata and activities in Firestore.
 * Leaves all other days, trip metadata, planned budgets, and actualExpenses untouched.
 */
export async function replaceDayInFirestore(
  uid: string,
  tripId: string,
  dayPlan: DayPlan,
  oldActivityIds: string[],
  newActivities: Activity[]
): Promise<void> {
  const tripPath = `users/${uid}/trips/${tripId}`;
  const dayNumber = clampInt(dayPlan.dayNumber, 1, 14, 1);
  const dpId = `day-${dayNumber}`;
  const dpRef = doc(db, 'users', uid, 'trips', tripId, 'dayPlans', dpId);
  const dpPath = `${tripPath}/dayPlans/${dpId}`;

  const deleteOps: BatchWriteOperation[] = oldActivityIds
    .filter((id) => typeof id === 'string' && id.trim().length > 0)
    .map((actId) => ({
      type: 'delete',
      ref: doc(db, 'users', uid, 'trips', tripId, 'activities', actId),
      path: `${tripPath}/activities/${actId}`,
    }));

  if (deleteOps.length > 0) {
    await commitChunkedOperations(deleteOps, OperationType.DELETE);
  }

  let dpExists = false;
  try {
    const snap = await getDoc(dpRef);
    dpExists = snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, dpPath);
  }

  const dpFields = buildDayPlanFields(uid, tripId, { ...dayPlan, dayNumber });
  const writeOps: BatchWriteOperation[] = [];

  if (dpExists) {
    writeOps.push({
      type: 'update',
      ref: dpRef,
      path: dpPath,
      data: {
        title: dpFields.title,
        pace: dpFields.pace,
        notes: dpFields.notes,
        updatedAt: serverTimestamp(),
      },
    });
  } else {
    writeOps.push({
      type: 'set',
      ref: dpRef,
      path: dpPath,
      data: {
        ...dpFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  for (const act of newActivities) {
    const cleanId = toValidFirestoreId(act.id, `act-d${dayNumber}`);
    writeOps.push({
      type: 'set',
      ref: doc(db, 'users', uid, 'trips', tripId, 'activities', cleanId),
      path: `${tripPath}/activities/${cleanId}`,
      data: {
        ...buildActivityFields(uid, tripId, { ...act, id: cleanId, day: dayNumber }, false),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
  }

  await commitChunkedOperations(writeOps, OperationType.WRITE);
}

export async function deleteTripInFirestore(uid: string, tripId: string): Promise<void> {
  const tripPath = `users/${uid}/trips/${tripId}`;
  const tripRef = doc(db, 'users', uid, 'trips', tripId);

  let actSnap;
  let dpSnap;
  let budgetSnap;
  let expSnap;
  try {
    [actSnap, dpSnap, budgetSnap, expSnap] = await Promise.all([
      getDocs(
        query(collection(db, 'users', uid, 'trips', tripId, 'activities'), where('userId', '==', uid))
      ),
      getDocs(
        query(collection(db, 'users', uid, 'trips', tripId, 'dayPlans'), where('userId', '==', uid))
      ),
      getDocs(
        query(collection(db, 'users', uid, 'trips', tripId, 'budgets'), where('userId', '==', uid))
      ),
      getDocs(
        query(
          collection(db, 'users', uid, 'trips', tripId, 'actualExpenses'),
          where('userId', '==', uid)
        )
      ),
    ]);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, tripPath);
  }

  // Delete all subcollections BEFORE deleting the parent trip doc (so isTripOwner() passes)
  const subDeleteOps: BatchWriteOperation[] = [
    ...actSnap.docs.map((d) => ({
      type: 'delete' as const,
      ref: d.ref,
      path: `${tripPath}/activities/${d.id}`,
    })),
    ...dpSnap.docs.map((d) => ({
      type: 'delete' as const,
      ref: d.ref,
      path: `${tripPath}/dayPlans/${d.id}`,
    })),
    ...budgetSnap.docs.map((d) => ({
      type: 'delete' as const,
      ref: d.ref,
      path: `${tripPath}/budgets/${d.id}`,
    })),
    ...expSnap.docs.map((d) => ({
      type: 'delete' as const,
      ref: d.ref,
      path: `${tripPath}/actualExpenses/${d.id}`,
    })),
  ];

  await commitChunkedOperations(subDeleteOps, OperationType.DELETE);

  try {
    await deleteDoc(tripRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, tripPath);
  }
}

export async function addActivityInFirestore(
  uid: string,
  tripId: string,
  activity: Activity
): Promise<void> {
  const actId = toValidFirestoreId(activity.id, 'act');
  const path = `users/${uid}/trips/${tripId}/activities/${actId}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'activities', actId);

  try {
    await setDoc(ref, {
      ...buildActivityFields(uid, tripId, { ...activity, id: actId }, false),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateActivityInFirestore(
  uid: string,
  tripId: string,
  activity: Activity
): Promise<void> {
  const path = `users/${uid}/trips/${tripId}/activities/${activity.id}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'activities', activity.id);

  const fields = buildActivityFields(uid, tripId, activity, true);
  const { userId: _u, tripId: _t, ...updatable } = fields;
  void _u;
  void _t;

  try {
    await updateDoc(ref, {
      ...updatable,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function batchUpdateActivitiesInFirestore(
  uid: string,
  tripId: string,
  activities: Activity[]
): Promise<void> {
  const ops: BatchWriteOperation[] = activities.map((act) => {
    const path = `users/${uid}/trips/${tripId}/activities/${act.id}`;
    const fields = buildActivityFields(uid, tripId, act, true);
    const { userId: _u, tripId: _t, ...updatable } = fields;
    void _u;
    void _t;
    return {
      type: 'update',
      ref: doc(db, 'users', uid, 'trips', tripId, 'activities', act.id),
      path,
      data: {
        ...updatable,
        updatedAt: serverTimestamp(),
      },
    };
  });
  await commitChunkedOperations(ops, OperationType.UPDATE);
}

export async function deleteActivityInFirestore(
  uid: string,
  tripId: string,
  activityId: string
): Promise<void> {
  const path = `users/${uid}/trips/${tripId}/activities/${activityId}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'activities', activityId);

  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function updateDayPlanPaceInFirestore(
  uid: string,
  tripId: string,
  dayPlan: DayPlan
): Promise<void> {
  const dayNumber = clampInt(dayPlan.dayNumber, 1, 14, 1);
  const dpId = `day-${dayNumber}`;
  const path = `users/${uid}/trips/${tripId}/dayPlans/${dpId}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'dayPlans', dpId);
  const safePace: DayPace = VALID_PACES.includes(dayPlan.pace) ? dayPlan.pace : 'Balanced';

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (snap.exists()) {
    try {
      await updateDoc(ref, {
        pace: safePace,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(ref, {
        ...buildDayPlanFields(uid, tripId, { ...dayPlan, pace: safePace }),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }
}

export async function addActualExpenseInFirestore(
  uid: string,
  tripId: string,
  expense: ActualExpenseItem
): Promise<void> {
  const expId = toValidFirestoreId(expense.id, 'exp');
  const path = `users/${uid}/trips/${tripId}/actualExpenses/${expId}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'actualExpenses', expId);

  try {
    await setDoc(ref, {
      ...buildActualExpenseFields(uid, tripId, { ...expense, id: expId }),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateActualExpenseInFirestore(
  uid: string,
  tripId: string,
  expense: ActualExpenseItem
): Promise<void> {
  const path = `users/${uid}/trips/${tripId}/actualExpenses/${expense.id}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'actualExpenses', expense.id);

  const fields = buildActualExpenseFields(uid, tripId, expense);
  const { userId: _u, tripId: _t, ...updatable } = fields;
  void _u;
  void _t;

  try {
    await updateDoc(ref, {
      ...updatable,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteActualExpenseInFirestore(
  uid: string,
  tripId: string,
  expenseId: string
): Promise<void> {
  const path = `users/${uid}/trips/${tripId}/actualExpenses/${expenseId}`;
  const ref = doc(db, 'users', uid, 'trips', tripId, 'actualExpenses', expenseId);

  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
