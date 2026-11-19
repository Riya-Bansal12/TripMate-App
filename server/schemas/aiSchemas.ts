import { Type, type Schema } from '@google/genai';

export type TravelStyle = 'Adventure' | 'Relaxed' | 'Balanced' | 'Custom';
export type DayPace = 'Relaxed' | 'Balanced' | 'Activity-heavy';
export type StayMode = 'without-hotel' | 'with-hotel';
export type CommuteMode = 'DRIVING' | 'TRANSIT' | 'WALKING' | 'TWO_WHEELER';
export type ActivityCategory = 'Food' | 'Attraction' | 'Transport' | 'Leisure' | 'Nature' | 'Culture';
export type RecommendationCategory =
  | 'places_to_visit'
  | 'activities'
  | 'food_dining'
  | 'accommodation'
  | 'local_experiences'
  | 'alternatives';

export interface ValidatedHotelContext {
  name: string;
  formattedAddress: string;
  placeId?: string;
}

export interface GenerateItineraryInput {
  origin: string;
  destination: string;
  daysCount: number;
  startDate?: string;
  endDate?: string;
  adults: number;
  children: number;
  budget: {
    total: number;
    daily: number;
    food: number;
    transport: number;
    attraction: number;
  };
  travelStyle: TravelStyle;
  dayPlans: { dayNumber: number; title: string; pace: DayPace; notes: string[] }[];
  generalNotes: string[];
  stayMode: StayMode;
  hotel?: ValidatedHotelContext | null;
  commuteMode: CommuteMode;
  accommodationPreference?: string;
  transportPreference?: string;
  accessibilityNeeds?: string;
  interests?: string[];
}

export interface RegenerateDayInput {
  destination: string;
  origin: string;
  daysCount: number;
  dayNumber: number;
  date?: string;
  adults: number;
  children: number;
  travelStyle: TravelStyle;
  budgetTotal: number;
  dailyBudget: number;
  dayPlan: {
    dayNumber: number;
    title: string;
    pace: DayPace;
    notes: string[];
  };
  instruction: string;
  generalNotes: string[];
  stayMode: StayMode;
  hotel?: ValidatedHotelContext | null;
  commuteMode: CommuteMode;
  existingDayActivities: {
    title: string;
    category: ActivityCategory;
    startTime: string;
    durationMinutes: number;
    cost: number;
  }[];
  otherDaysHighlights: string[];
}

export interface RecommendationsInput {
  destination: string;
  category: RecommendationCategory;
  daysCount: number;
  startDate?: string;
  endDate?: string;
  adults: number;
  children: number;
  travelStyle: TravelStyle;
  budgetTotal: number;
  interests: string[];
  existingTitles: string[];
  excludeTitles: string[];
  stayMode: StayMode;
  hotel?: ValidatedHotelContext | null;
  targetActivity?: {
    id: string;
    title: string;
    category: ActivityCategory;
    location: string;
    durationMinutes: number;
    cost: number;
  };
  instruction?: string;
}

export interface EstimateBudgetInput {
  destination: string;
  origin: string;
  daysCount: number;
  adults: number;
  children: number;
  travelStyle: TravelStyle;
  accommodationPreference: string;
  currency: string;
  userBudgetTotal?: number;
  plannedActivities: {
    title: string;
    category: ActivityCategory;
    cost: number;
    day: number;
  }[];
  notes?: string;
}

export interface RefineActivityInput {
  destination: string;
  daysCount: number;
  dayNumber: number;
  adults: number;
  children: number;
  travelStyle: TravelStyle;
  instruction: string;
  activity: {
    id: string;
    title: string;
    description: string;
    category: ActivityCategory;
    location: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    cost: number;
    day: number;
    isChildFriendly?: boolean;
    crowdLevel?: 'Low' | 'Moderate' | 'High';
    notes?: string;
  };
  dayScheduleSummary: {
    title: string;
    startTime: string;
    endTime: string;
    category: ActivityCategory;
  }[];
  stayMode: StayMode;
  hotel?: ValidatedHotelContext | null;
}

export class RequestValidationError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

const VALID_STYLES: TravelStyle[] = ['Adventure', 'Relaxed', 'Balanced', 'Custom'];
const VALID_PACES: DayPace[] = ['Relaxed', 'Balanced', 'Activity-heavy'];
const VALID_STAY_MODES: StayMode[] = ['without-hotel', 'with-hotel'];
const VALID_COMMUTE: CommuteMode[] = ['DRIVING', 'TRANSIT', 'WALKING', 'TWO_WHEELER'];
const VALID_CATEGORIES: ActivityCategory[] = [
  'Food',
  'Attraction',
  'Transport',
  'Leisure',
  'Nature',
  'Culture',
];
const VALID_REC_CATEGORIES: RecommendationCategory[] = [
  'places_to_visit',
  'activities',
  'food_dining',
  'accommodation',
  'local_experiences',
  'alternatives',
];

function cleanString(val: unknown, maxLen: number, fieldName: string, required = false): string {
  if (typeof val !== 'string') {
    if (required) throw new RequestValidationError(`${fieldName} is required.`);
    return '';
  }
  const trimmed = val.trim().slice(0, maxLen);
  if (required && trimmed.length === 0) {
    throw new RequestValidationError(`${fieldName} cannot be empty.`);
  }
  return trimmed;
}

function cleanOptionalDate(val: unknown, fieldName: string): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
    throw new RequestValidationError(`${fieldName} must use YYYY-MM-DD format.`);
  }
  const trimmed = val.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new RequestValidationError(`${fieldName} is not a valid calendar date.`);
  }
  return trimmed;
}

function cleanInt(val: unknown, min: number, max: number, fallback: number, fieldName: string): number {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) {
    throw new RequestValidationError(`${fieldName} must be a valid number.`);
  }
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) {
    throw new RequestValidationError(`${fieldName} must be between ${min} and ${max}.`);
  }
  return rounded;
}

function cleanNonNegativeNumber(val: unknown, max: number, fallback: number, fieldName: string): number {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new RequestValidationError(`${fieldName} must be between 0 and ${max}.`);
  }
  return Math.round(n);
}

function cleanStringList(val: unknown, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => (typeof item === 'string' ? item.trim().slice(0, maxItemLen) : ''))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

function cleanHotel(val: unknown): ValidatedHotelContext | null {
  if (!val || typeof val !== 'object') return null;
  const h = val as Record<string, unknown>;
  const name = cleanString(h.name, 200, 'hotel.name', false);
  const formattedAddress = cleanString(h.formattedAddress, 300, 'hotel.formattedAddress', false);
  if (!name) return null;
  const placeId = cleanString(h.placeId, 200, 'hotel.placeId', false) || undefined;
  return {
    name,
    formattedAddress: formattedAddress || name,
    ...(placeId ? { placeId } : {}),
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function validateGenerateItineraryInput(rawBody: unknown): GenerateItineraryInput {
  const b = asObject(rawBody);
  const origin = cleanString(b.origin, 120, 'origin', true);
  const destination = cleanString(b.destination, 120, 'destination', true);
  const startDate = cleanOptionalDate(b.startDate, 'startDate');
  const endDate = cleanOptionalDate(b.endDate, 'endDate');

  let daysCount = cleanInt(b.daysCount, 1, 14, 3, 'daysCount');
  if (startDate && endDate) {
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T00:00:00Z`);
    if (endMs < startMs) {
      throw new RequestValidationError('endDate cannot be earlier than startDate.');
    }
    const diffDays = Math.round((endMs - startMs) / 86400000) + 1;
    if (diffDays < 1 || diffDays > 14) {
      throw new RequestValidationError('Trip date range must be between 1 and 14 days.');
    }
    daysCount = diffDays;
  }

  const adults = cleanInt(b.adults, 1, 30, 2, 'adults');
  const children = cleanInt(b.children, 0, 30, 0, 'children');
  const travelStyle: TravelStyle = VALID_STYLES.includes(b.travelStyle as TravelStyle)
    ? (b.travelStyle as TravelStyle)
    : 'Balanced';

  const rawBudget = b.budget && typeof b.budget === 'object' ? (b.budget as Record<string, unknown>) : {};
  const total = cleanNonNegativeNumber(rawBudget.total, 100000000, 15000, 'budget.total');
  const daily = cleanNonNegativeNumber(
    rawBudget.daily,
    100000000,
    Math.round(total / daysCount),
    'budget.daily'
  );
  const food = cleanNonNegativeNumber(rawBudget.food, 100000000, Math.round(total * 0.3), 'budget.food');
  const transport = cleanNonNegativeNumber(
    rawBudget.transport,
    100000000,
    Math.round(total * 0.2),
    'budget.transport'
  );
  const attraction = cleanNonNegativeNumber(
    rawBudget.attraction,
    100000000,
    Math.round(total * 0.5),
    'budget.attraction'
  );

  const rawDayPlans = Array.isArray(b.dayPlans) ? b.dayPlans.slice(0, 14) : [];
  const dayPlans = rawDayPlans
    .map((dp, idx) => {
      if (!dp || typeof dp !== 'object') return null;
      const obj = dp as Record<string, unknown>;
      return {
        dayNumber: cleanInt(obj.dayNumber, 1, 14, idx + 1, 'dayPlans.dayNumber'),
        title: cleanString(obj.title, 160, 'dayPlans.title', false) || `Day ${idx + 1}`,
        pace: VALID_PACES.includes(obj.pace as DayPace) ? (obj.pace as DayPace) : 'Balanced',
        notes: cleanStringList(obj.notes, 10, 200),
      };
    })
    .filter((dp): dp is NonNullable<typeof dp> => dp !== null);

  const stayMode: StayMode = VALID_STAY_MODES.includes(b.stayMode as StayMode)
    ? (b.stayMode as StayMode)
    : 'without-hotel';
  const commuteMode: CommuteMode = VALID_COMMUTE.includes(b.commuteMode as CommuteMode)
    ? (b.commuteMode as CommuteMode)
    : 'DRIVING';

  return {
    origin,
    destination,
    daysCount,
    startDate,
    endDate,
    adults,
    children,
    budget: { total, daily, food, transport, attraction },
    travelStyle,
    dayPlans,
    generalNotes: cleanStringList(b.generalNotes, 20, 200),
    stayMode,
    hotel: stayMode === 'with-hotel' ? cleanHotel(b.hotel) : null,
    commuteMode,
    accommodationPreference: cleanString(b.accommodationPreference, 200, 'accommodationPreference') || undefined,
    transportPreference: cleanString(b.transportPreference, 200, 'transportPreference') || undefined,
    accessibilityNeeds: cleanString(b.accessibilityNeeds, 300, 'accessibilityNeeds') || undefined,
    interests: cleanStringList(b.interests, 20, 100),
  };
}

export function validateRegenerateDayInput(rawBody: unknown): RegenerateDayInput {
  const b = asObject(rawBody);
  const destination = cleanString(b.destination, 120, 'destination', true);
  const origin = cleanString(b.origin, 120, 'origin', false) || 'Bengaluru';
  const daysCount = cleanInt(b.daysCount, 1, 14, 3, 'daysCount');
  const dayNumber = cleanInt(b.dayNumber, 1, daysCount, 1, 'dayNumber');
  const date = cleanOptionalDate(b.date, 'date');
  const adults = cleanInt(b.adults, 1, 30, 2, 'adults');
  const children = cleanInt(b.children, 0, 30, 0, 'children');
  const travelStyle: TravelStyle = VALID_STYLES.includes(b.travelStyle as TravelStyle)
    ? (b.travelStyle as TravelStyle)
    : 'Balanced';
  const budgetTotal = cleanNonNegativeNumber(b.budgetTotal, 100000000, 15000, 'budgetTotal');
  const dailyBudget = cleanNonNegativeNumber(
    b.dailyBudget,
    100000000,
    Math.round(budgetTotal / daysCount),
    'dailyBudget'
  );
  const instruction =
    cleanString(b.instruction, 500, 'instruction', false) ||
    'Refresh this day with a balanced, well-paced schedule.';

  const rawDp = b.dayPlan && typeof b.dayPlan === 'object' ? (b.dayPlan as Record<string, unknown>) : {};
  const dayPlan = {
    dayNumber,
    title: cleanString(rawDp.title, 160, 'dayPlan.title', false) || `Day ${dayNumber}`,
    pace: VALID_PACES.includes(rawDp.pace as DayPace) ? (rawDp.pace as DayPace) : 'Balanced',
    notes: cleanStringList(rawDp.notes, 10, 200),
  };

  const stayMode: StayMode = VALID_STAY_MODES.includes(b.stayMode as StayMode)
    ? (b.stayMode as StayMode)
    : 'without-hotel';
  const commuteMode: CommuteMode = VALID_COMMUTE.includes(b.commuteMode as CommuteMode)
    ? (b.commuteMode as CommuteMode)
    : 'DRIVING';

  const existingDayActivities = Array.isArray(b.existingDayActivities)
    ? b.existingDayActivities.slice(0, 20).map((item) => {
        const a = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return {
          title: cleanString(a.title, 180, 'existingDayActivities.title', false) || 'Activity',
          category: VALID_CATEGORIES.includes(a.category as ActivityCategory)
            ? (a.category as ActivityCategory)
            : 'Attraction',
          startTime: cleanString(a.startTime, 10, 'existingDayActivities.startTime', false) || '09:00',
          durationMinutes: cleanInt(a.durationMinutes, 15, 720, 60, 'existingDayActivities.durationMinutes'),
          cost: cleanNonNegativeNumber(a.cost, 10000000, 0, 'existingDayActivities.cost'),
        };
      })
    : [];

  return {
    destination,
    origin,
    daysCount,
    dayNumber,
    date,
    adults,
    children,
    travelStyle,
    budgetTotal,
    dailyBudget,
    dayPlan,
    instruction,
    generalNotes: cleanStringList(b.generalNotes, 20, 200),
    stayMode,
    hotel: stayMode === 'with-hotel' ? cleanHotel(b.hotel) : null,
    commuteMode,
    existingDayActivities,
    otherDaysHighlights: cleanStringList(b.otherDaysHighlights, 40, 180),
  };
}

export function validateRecommendationsInput(rawBody: unknown): RecommendationsInput {
  const b = asObject(rawBody);
  const destination = cleanString(b.destination, 120, 'destination', true);
  if (!VALID_REC_CATEGORIES.includes(b.category as RecommendationCategory)) {
    throw new RequestValidationError(
      `category must be one of: ${VALID_REC_CATEGORIES.join(', ')}`
    );
  }
  const category = b.category as RecommendationCategory;
  const daysCount = cleanInt(b.daysCount, 1, 14, 3, 'daysCount');
  const startDate = cleanOptionalDate(b.startDate, 'startDate');
  const endDate = cleanOptionalDate(b.endDate, 'endDate');
  if (startDate && endDate && Date.parse(`${endDate}T00:00:00Z`) < Date.parse(`${startDate}T00:00:00Z`)) {
    throw new RequestValidationError('endDate cannot be earlier than startDate.');
  }
  const adults = cleanInt(b.adults, 1, 30, 2, 'adults');
  const children = cleanInt(b.children, 0, 30, 0, 'children');
  const travelStyle: TravelStyle = VALID_STYLES.includes(b.travelStyle as TravelStyle)
    ? (b.travelStyle as TravelStyle)
    : 'Balanced';
  const budgetTotal = cleanNonNegativeNumber(b.budgetTotal, 100000000, 15000, 'budgetTotal');
  const stayMode: StayMode = VALID_STAY_MODES.includes(b.stayMode as StayMode)
    ? (b.stayMode as StayMode)
    : 'without-hotel';

  let targetActivity: RecommendationsInput['targetActivity'];
  if (b.targetActivity && typeof b.targetActivity === 'object') {
    const ta = b.targetActivity as Record<string, unknown>;
    targetActivity = {
      id: cleanString(ta.id, 128, 'targetActivity.id', false) || 'target',
      title: cleanString(ta.title, 180, 'targetActivity.title', true),
      category: VALID_CATEGORIES.includes(ta.category as ActivityCategory)
        ? (ta.category as ActivityCategory)
        : 'Attraction',
      location: cleanString(ta.location, 300, 'targetActivity.location', false) || destination,
      durationMinutes: cleanInt(ta.durationMinutes, 15, 720, 90, 'targetActivity.durationMinutes'),
      cost: cleanNonNegativeNumber(ta.cost, 10000000, 0, 'targetActivity.cost'),
    };
  }

  return {
    destination,
    category,
    daysCount,
    startDate,
    endDate,
    adults,
    children,
    travelStyle,
    budgetTotal,
    interests: cleanStringList(b.interests, 20, 120),
    existingTitles: cleanStringList(b.existingTitles, 60, 180),
    excludeTitles: cleanStringList(b.excludeTitles, 60, 180),
    stayMode,
    hotel: stayMode === 'with-hotel' ? cleanHotel(b.hotel) : null,
    targetActivity,
    instruction: cleanString(b.instruction, 400, 'instruction', false) || undefined,
  };
}

export function validateEstimateBudgetInput(rawBody: unknown): EstimateBudgetInput {
  const b = asObject(rawBody);
  const destination = cleanString(b.destination, 120, 'destination', true);
  const origin = cleanString(b.origin, 120, 'origin', false) || 'Bengaluru';
  const daysCount = cleanInt(b.daysCount, 1, 14, 3, 'daysCount');
  const adults = cleanInt(b.adults, 1, 30, 2, 'adults');
  const children = cleanInt(b.children, 0, 30, 0, 'children');
  const travelStyle: TravelStyle = VALID_STYLES.includes(b.travelStyle as TravelStyle)
    ? (b.travelStyle as TravelStyle)
    : 'Balanced';
  const accommodationPreference =
    cleanString(b.accommodationPreference, 120, 'accommodationPreference', false) || 'Mid-range hotel';
  const currency = cleanString(b.currency, 10, 'currency', false).toUpperCase() || 'INR';
  const userBudgetTotal =
    b.userBudgetTotal !== undefined && b.userBudgetTotal !== null
      ? cleanNonNegativeNumber(b.userBudgetTotal, 100000000, 0, 'userBudgetTotal')
      : undefined;

  const plannedActivities = Array.isArray(b.plannedActivities)
    ? b.plannedActivities.slice(0, 80).map((item) => {
        const a = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return {
          title: cleanString(a.title, 180, 'plannedActivities.title', false) || 'Activity',
          category: VALID_CATEGORIES.includes(a.category as ActivityCategory)
            ? (a.category as ActivityCategory)
            : 'Attraction',
          cost: cleanNonNegativeNumber(a.cost, 10000000, 0, 'plannedActivities.cost'),
          day: cleanInt(a.day, 1, 14, 1, 'plannedActivities.day'),
        };
      })
    : [];

  return {
    destination,
    origin,
    daysCount,
    adults,
    children,
    travelStyle,
    accommodationPreference,
    currency,
    userBudgetTotal,
    plannedActivities,
    notes: cleanString(b.notes, 400, 'notes', false) || undefined,
  };
}

export function validateRefineActivityInput(rawBody: unknown): RefineActivityInput {
  const b = asObject(rawBody);
  const destination = cleanString(b.destination, 120, 'destination', true);
  const daysCount = cleanInt(b.daysCount, 1, 14, 3, 'daysCount');
  const dayNumber = cleanInt(b.dayNumber, 1, daysCount, 1, 'dayNumber');
  const adults = cleanInt(b.adults, 1, 30, 2, 'adults');
  const children = cleanInt(b.children, 0, 30, 0, 'children');
  const travelStyle: TravelStyle = VALID_STYLES.includes(b.travelStyle as TravelStyle)
    ? (b.travelStyle as TravelStyle)
    : 'Balanced';
  const instruction = cleanString(b.instruction, 500, 'instruction', true);
  if (instruction.length < 3) {
    throw new RequestValidationError('instruction must be at least 3 characters.');
  }

  if (!b.activity || typeof b.activity !== 'object') {
    throw new RequestValidationError('activity object is required.');
  }
  const act = b.activity as Record<string, unknown>;
  const id = cleanString(act.id, 128, 'activity.id', true);
  const title = cleanString(act.title, 180, 'activity.title', true);
  const description = cleanString(act.description, 1000, 'activity.description', false);
  const category: ActivityCategory = VALID_CATEGORIES.includes(act.category as ActivityCategory)
    ? (act.category as ActivityCategory)
    : 'Attraction';
  const location = cleanString(act.location, 300, 'activity.location', true);
  const startTime = cleanString(act.startTime, 10, 'activity.startTime', false) || '09:00';
  const endTime = cleanString(act.endTime, 10, 'activity.endTime', false) || '10:00';
  const durationMinutes = cleanInt(act.durationMinutes, 15, 720, 60, 'activity.durationMinutes');
  const cost = cleanNonNegativeNumber(act.cost, 10000000, 0, 'activity.cost');
  const day = cleanInt(act.day, 1, daysCount, dayNumber, 'activity.day');
  const crowdLevel =
    act.crowdLevel && ['Low', 'Moderate', 'High'].includes(String(act.crowdLevel))
      ? (act.crowdLevel as 'Low' | 'Moderate' | 'High')
      : undefined;

  const stayMode: StayMode = VALID_STAY_MODES.includes(b.stayMode as StayMode)
    ? (b.stayMode as StayMode)
    : 'without-hotel';

  const dayScheduleSummary = Array.isArray(b.dayScheduleSummary)
    ? b.dayScheduleSummary.slice(0, 20).map((s) => {
        const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        return {
          title: cleanString(obj.title, 180, 'dayScheduleSummary.title', false) || 'Activity',
          startTime: cleanString(obj.startTime, 10, 'dayScheduleSummary.startTime', false) || '09:00',
          endTime: cleanString(obj.endTime, 10, 'dayScheduleSummary.endTime', false) || '10:00',
          category: VALID_CATEGORIES.includes(obj.category as ActivityCategory)
            ? (obj.category as ActivityCategory)
            : 'Attraction',
        };
      })
    : [];

  return {
    destination,
    daysCount,
    dayNumber,
    adults,
    children,
    travelStyle,
    instruction,
    activity: {
      id,
      title,
      description,
      category,
      location,
      startTime,
      endTime,
      durationMinutes,
      cost,
      day,
      isChildFriendly: typeof act.isChildFriendly === 'boolean' ? act.isChildFriendly : undefined,
      crowdLevel,
      notes: cleanString(act.notes, 500, 'activity.notes', false) || undefined,
    },
    dayScheduleSummary,
    stayMode,
    hotel: stayMode === 'with-hotel' ? cleanHotel(b.hotel) : null,
  };
}

// ============================================================================
// Gemini @google/genai Response Schemas (strict JSON structure)
// ============================================================================

const ACTIVITY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Concise activity or meal title.' },
    description: {
      type: Type.STRING,
      description: 'Helpful, realistic 1-2 sentence description without fabricated opening hours or prices.',
    },
    category: {
      type: Type.STRING,
      enum: ['Food', 'Attraction', 'Transport', 'Leisure', 'Nature', 'Culture'],
    },
    location: {
      type: Type.STRING,
      description: 'General landmark, neighborhood, or area name (not a fabricated street address).',
    },
    startTime: { type: Type.STRING, description: '24-hour HH:MM start time, e.g. 09:00.' },
    durationMinutes: { type: Type.INTEGER, description: 'Duration in minutes (30 to 240).' },
    estimatedCost: {
      type: Type.INTEGER,
      description: 'Approximate estimated cost in INR for the group (>= 0).',
    },
    isChildFriendly: { type: Type.BOOLEAN },
    crowdLevel: { type: Type.STRING, enum: ['Low', 'Moderate', 'High'] },
    notes: {
      type: Type.STRING,
      description: 'Practical travel or meal tip (e.g. rest time, local dish, booking reminder).',
    },
  },
  required: [
    'title',
    'description',
    'category',
    'location',
    'startTime',
    'durationMinutes',
    'estimatedCost',
    'isChildFriendly',
    'crowdLevel',
    'notes',
  ],
};

export const GENERATE_ITINERARY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tripTitle: { type: Type.STRING },
    overview: { type: Type.STRING },
    practicalNotes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    days: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          dayNumber: { type: Type.INTEGER },
          title: { type: Type.STRING },
          pace: { type: Type.STRING, enum: ['Relaxed', 'Balanced', 'Activity-heavy'] },
          notes: { type: Type.ARRAY, items: { type: Type.STRING } },
          activities: { type: Type.ARRAY, items: ACTIVITY_SCHEMA },
        },
        required: ['dayNumber', 'title', 'pace', 'notes', 'activities'],
      },
    },
  },
  required: ['tripTitle', 'overview', 'practicalNotes', 'days'],
};

export const REGENERATE_DAY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    dayNumber: { type: Type.INTEGER },
    title: { type: Type.STRING },
    pace: { type: Type.STRING, enum: ['Relaxed', 'Balanced', 'Activity-heavy'] },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
    activities: { type: Type.ARRAY, items: ACTIVITY_SCHEMA },
  },
  required: ['dayNumber', 'title', 'pace', 'notes', 'activities'],
};

export const RECOMMENDATIONS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          category: {
            type: Type.STRING,
            enum: ['Food', 'Attraction', 'Transport', 'Leisure', 'Nature', 'Culture'],
          },
          locationHint: {
            type: Type.STRING,
            description: 'Area or neighborhood name in destination (no fabricated exact street address).',
          },
          shortExplanation: { type: Type.STRING },
          whyItSuitsTrip: { type: Type.STRING },
          approxCostMin: { type: Type.INTEGER },
          approxCostMax: { type: Type.INTEGER },
          suggestedDurationMinutes: { type: Type.INTEGER },
          importantCaveats: { type: Type.STRING },
          isChildFriendly: { type: Type.BOOLEAN },
          crowdLevel: { type: Type.STRING, enum: ['Low', 'Moderate', 'High'] },
          tags: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
              enum: ['Similar', 'Lower Cost', 'Child-Friendly', 'Shorter Duration', 'Different Type'],
            },
          },
        },
        required: [
          'name',
          'category',
          'locationHint',
          'shortExplanation',
          'whyItSuitsTrip',
          'approxCostMin',
          'approxCostMax',
          'suggestedDurationMinutes',
          'importantCaveats',
          'isChildFriendly',
          'crowdLevel',
          'tags',
        ],
      },
    },
  },
  required: ['recommendations'],
};

export const ESTIMATE_BUDGET_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    currency: { type: Type.STRING },
    categories: {
      type: Type.OBJECT,
      properties: {
        accommodation: { type: Type.INTEGER },
        food: { type: Type.INTEGER },
        localTransport: { type: Type.INTEGER },
        intercityTransport: { type: Type.INTEGER },
        activitiesAndAttractions: { type: Type.INTEGER },
        shopping: { type: Type.INTEGER },
        miscellaneous: { type: Type.INTEGER },
        contingency: { type: Type.INTEGER },
      },
      required: [
        'accommodation',
        'food',
        'localTransport',
        'intercityTransport',
        'activitiesAndAttractions',
        'shopping',
        'miscellaneous',
        'contingency',
      ],
    },
    categoryNotes: {
      type: Type.OBJECT,
      properties: {
        accommodation: { type: Type.STRING },
        food: { type: Type.STRING },
        localTransport: { type: Type.STRING },
        intercityTransport: { type: Type.STRING },
        activitiesAndAttractions: { type: Type.STRING },
        shopping: { type: Type.STRING },
        miscellaneous: { type: Type.STRING },
        contingency: { type: Type.STRING },
      },
      required: [
        'accommodation',
        'food',
        'localTransport',
        'intercityTransport',
        'activitiesAndAttractions',
        'shopping',
        'miscellaneous',
        'contingency',
      ],
    },
    assumptions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    disclaimer: { type: Type.STRING },
  },
  required: ['currency', 'categories', 'categoryNotes', 'assumptions', 'disclaimer'],
};

export const REFINE_ACTIVITY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    description: { type: Type.STRING },
    category: {
      type: Type.STRING,
      enum: ['Food', 'Attraction', 'Transport', 'Leisure', 'Nature', 'Culture'],
    },
    location: { type: Type.STRING },
    startTime: { type: Type.STRING },
    durationMinutes: { type: Type.INTEGER },
    estimatedCost: { type: Type.INTEGER },
    isChildFriendly: { type: Type.BOOLEAN },
    crowdLevel: { type: Type.STRING, enum: ['Low', 'Moderate', 'High'] },
    notes: { type: Type.STRING },
    changeSummary: { type: Type.STRING },
  },
  required: [
    'title',
    'description',
    'category',
    'location',
    'startTime',
    'durationMinutes',
    'estimatedCost',
    'isChildFriendly',
    'crowdLevel',
    'notes',
    'changeSummary',
  ],
};
