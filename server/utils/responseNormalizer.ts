import crypto from 'node:crypto';
import {
  ActivityCategory,
  DayPace,
  EstimateBudgetInput,
  GenerateItineraryInput,
  RecommendationCategory,
  RecommendationsInput,
  RefineActivityInput,
  RegenerateDayInput,
} from '../schemas/aiSchemas';

export class MalformedAiOutputError extends Error {
  public readonly statusCode = 502;
  public readonly code = 'AI_MALFORMED_OUTPUT';
  constructor(message: string) {
    super(message);
    this.name = 'MalformedAiOutputError';
  }
}

const VALID_CATEGORIES: ActivityCategory[] = [
  'Food',
  'Attraction',
  'Transport',
  'Leisure',
  'Nature',
  'Culture',
];
const VALID_PACES: DayPace[] = ['Relaxed', 'Balanced', 'Activity-heavy'];
const VALID_REC_TAGS = [
  'Similar',
  'Lower Cost',
  'Child-Friendly',
  'Shorter Duration',
  'Different Type',
] as const;

const DESTINATION_IMAGE_PATHS = {
  hero: '/images/hero_tripmate_journey_1794652509398.jpg',
  jaipur: '/images/dest_jaipur_palace_1794652509323.jpg',
  goa: '/images/dest_goa_coast_1794652509607.jpg',
  manali: '/images/dest_manali_alpine_1794652510519.jpg',
  kerala: '/images/dest_kerala_backwaters_1794652511242.jpg',
  udaipur: '/images/dest_udaipur_lake_1794652511245.jpg',
  delhi: '/images/dest_delhi_heritage_1794652511841.jpg',
  cafe: '/images/act_cafe_bistro_1794652512093.jpg',
};

export function pickFallbackImage(category: ActivityCategory, destination: string): string {
  if (category === 'Food') return DESTINATION_IMAGE_PATHS.cafe;
  const lower = destination.toLowerCase();
  if (lower.includes('jaipur') || lower.includes('rajasthan')) return DESTINATION_IMAGE_PATHS.jaipur;
  if (lower.includes('goa')) return DESTINATION_IMAGE_PATHS.goa;
  if (lower.includes('manali') || lower.includes('himachal') || lower.includes('ladakh')) {
    return DESTINATION_IMAGE_PATHS.manali;
  }
  if (lower.includes('kerala') || lower.includes('kochi') || lower.includes('munnar')) {
    return DESTINATION_IMAGE_PATHS.kerala;
  }
  if (lower.includes('delhi') || lower.includes('agra')) return DESTINATION_IMAGE_PATHS.delhi;
  if (lower.includes('udaipur')) return DESTINATION_IMAGE_PATHS.udaipur;
  return category === 'Leisure' ? DESTINATION_IMAGE_PATHS.hero : DESTINATION_IMAGE_PATHS.udaipur;
}

function makeUniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseHHMMToMinutes(raw: unknown, fallbackMinutes = 540): number {
  if (typeof raw !== 'string') return fallbackMinutes;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) return fallbackMinutes;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeCategory(val: unknown): ActivityCategory {
  if (typeof val === 'string' && VALID_CATEGORIES.includes(val as ActivityCategory)) {
    return val as ActivityCategory;
  }
  const lower = typeof val === 'string' ? val.toLowerCase() : '';
  if (lower.includes('food') || lower.includes('dining') || lower.includes('cafe')) return 'Food';
  if (lower.includes('transport') || lower.includes('transit') || lower.includes('transfer')) return 'Transport';
  if (lower.includes('nature') || lower.includes('park') || lower.includes('beach')) return 'Nature';
  if (lower.includes('culture') || lower.includes('museum') || lower.includes('heritage')) return 'Culture';
  if (lower.includes('leisure') || lower.includes('relax') || lower.includes('market')) return 'Leisure';
  return 'Attraction';
}

function normalizeCrowdLevel(val: unknown): 'Low' | 'Moderate' | 'High' {
  if (val === 'Low' || val === 'Moderate' || val === 'High') return val;
  return 'Moderate';
}

const MAX_AI_RESPONSE_CHARS = 262_144;

function parseJsonSafe(rawText: string): Record<string, unknown> {
  if (rawText.length > MAX_AI_RESPONSE_CHARS) {
    throw new MalformedAiOutputError('Gemini response exceeded maximum safe payload size.');
  }
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!cleaned) {
    throw new MalformedAiOutputError('Gemini returned an empty response.');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MalformedAiOutputError('Gemini returned an unexpected JSON shape.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof MalformedAiOutputError) throw err;
    throw new MalformedAiOutputError('Gemini returned malformed JSON that could not be parsed.');
  }
}

export interface NormalizedActivity {
  id: string;
  title: string;
  description: string;
  category: ActivityCategory;
  location: string;
  imageUrl: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  cost: number;
  day: number;
  isChildFriendly: boolean;
  crowdLevel: 'Low' | 'Moderate' | 'High';
  notes?: string;
}

export interface NormalizedDayPlan {
  dayNumber: number;
  title: string;
  pace: DayPace;
  notes: string[];
}

export interface NormalizedGeneratedItinerary {
  tripTitle: string;
  overview: string;
  practicalNotes: string[];
  dayPlans: NormalizedDayPlan[];
  activities: NormalizedActivity[];
  verificationStatus: 'ai_unverified';
}

function normalizeDayActivitiesList(
  rawList: unknown,
  dayNumber: number,
  destination: string
): NormalizedActivity[] {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new MalformedAiOutputError(`Day ${dayNumber} did not contain any activities.`);
  }

  const mapped = rawList
    .slice(0, 8)
    .map((item, idx) => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const title =
        typeof obj.title === 'string' && obj.title.trim()
          ? obj.title.trim().slice(0, 180)
          : `Stop ${idx + 1}`;
      const description =
        typeof obj.description === 'string' && obj.description.trim()
          ? obj.description.trim().slice(0, 950)
          : `${title} in ${destination}.`;
      const category = normalizeCategory(obj.category);
      const locationRaw =
        typeof obj.location === 'string' && obj.location.trim()
          ? obj.location.trim().slice(0, 280)
          : `${destination} (AI suggestion — verify exact venue)`;
      const durationMinutes = clampInt(obj.durationMinutes, 30, 360, 75);
      const requestedStartMin = parseHHMMToMinutes(obj.startTime, 8 * 60 + 30 + idx * 135);
      const cost = clampInt(obj.estimatedCost, 0, 10000000, 0);
      const notesStr =
        typeof obj.notes === 'string' && obj.notes.trim()
          ? obj.notes.trim().slice(0, 480)
          : 'AI-estimated stop; confirm hours and local fares before booking.';

      return {
        id: makeUniqueId(`act-d${dayNumber}`),
        title,
        description,
        category,
        location: locationRaw,
        imageUrl: pickFallbackImage(category, destination),
        requestedStartMin,
        durationMinutes,
        cost,
        day: dayNumber,
        isChildFriendly: typeof obj.isChildFriendly === 'boolean' ? obj.isChildFriendly : true,
        crowdLevel: normalizeCrowdLevel(obj.crowdLevel),
        notes: notesStr,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  if (mapped.length === 0) {
    throw new MalformedAiOutputError(`Day ${dayNumber} activities could not be normalized.`);
  }

  // Sort chronologically and guarantee non-overlapping valid HH:MM intervals within [07:00, 23:45]
  mapped.sort((a, b) => a.requestedStartMin - b.requestedStartMin);
  const DAY_END_LIMIT = 23 * 60 + 45;
  let cursorMin = Math.max(7 * 60, Math.min(11 * 60, mapped[0].requestedStartMin));

  const scheduled = mapped.map((act, idx) => {
    const startMin =
      idx === 0 ? cursorMin : Math.max(act.requestedStartMin, cursorMin + 20);
    const endMin = startMin + act.durationMinutes;
    cursorMin = endMin;
    return { act, startMin, dur: act.durationMinutes, endMin };
  });

  // If any activity overflows the day boundary, re-pack cleanly from 08:00 with 15m gaps
  const overflowsDay = scheduled.some((s) => s.endMin > DAY_END_LIMIT);
  const finalSchedule = overflowsDay
    ? (() => {
        const packStart = 8 * 60;
        const gap = 15;
        const availableActivityMins = Math.max(
          mapped.length * 30,
          DAY_END_LIMIT - packStart - Math.max(0, mapped.length - 1) * gap
        );
        const totalRequestedMins = mapped.reduce((sum, a) => sum + a.durationMinutes, 0) || 1;
        const scale = Math.min(1, availableActivityMins / totalRequestedMins);
        let packCursor = packStart;
        return mapped.map((act, idx) => {
          const remainingItems = mapped.length - 1 - idx;
          const maxRemainingEnd = DAY_END_LIMIT - remainingItems * (30 + gap);
          const scaledDur = Math.max(30, Math.floor(act.durationMinutes * scale));
          const maxAllowedHere = Math.max(30, maxRemainingEnd - packCursor);
          const dur = Math.min(scaledDur, maxAllowedHere);
          const startMin = packCursor;
          const endMin = startMin + dur;
          packCursor = endMin + gap;
          return { act, startMin, dur, endMin };
        });
      })()
    : scheduled;

  return finalSchedule.map(({ act, startMin, dur, endMin }) => ({
    id: act.id,
    title: act.title,
    description: act.description,
    category: act.category,
    location: act.location,
    imageUrl: act.imageUrl,
    startTime: minutesToHHMM(startMin),
    endTime: minutesToHHMM(endMin),
    durationMinutes: dur,
    cost: act.cost,
    day: dayNumber,
    isChildFriendly: act.isChildFriendly,
    crowdLevel: act.crowdLevel,
    notes: act.notes,
  }));
}

export function normalizeGeneratedItinerary(
  rawText: string,
  input: GenerateItineraryInput
): NormalizedGeneratedItinerary {
  const parsed = parseJsonSafe(rawText);
  const rawDays = Array.isArray(parsed.days) ? parsed.days : [];
  if (rawDays.length < input.daysCount) {
    throw new MalformedAiOutputError(
      `Gemini returned ${rawDays.length} day(s) when ${input.daysCount} day(s) were requested.`
    );
  }

  const tripTitle =
    typeof parsed.tripTitle === 'string' && parsed.tripTitle.trim()
      ? parsed.tripTitle.trim().slice(0, 160)
      : `${input.destination} ${input.daysCount}-Day AI Itinerary`;

  const overview =
    typeof parsed.overview === 'string' && parsed.overview.trim()
      ? parsed.overview.trim().slice(0, 600)
      : `AI-planned ${input.daysCount}-day ${input.travelStyle.toLowerCase()} trip to ${input.destination}.`;

  const practicalNotes = Array.isArray(parsed.practicalNotes)
    ? parsed.practicalNotes
        .map((n) => (typeof n === 'string' ? n.trim().slice(0, 200) : ''))
        .filter((n) => n.length > 0)
        .slice(0, 12)
    : [];

  const dayPlans: NormalizedDayPlan[] = [];
  const activities: NormalizedActivity[] = [];

  for (let d = 1; d <= input.daysCount; d++) {
    const exactMatch = rawDays.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        Number((item as Record<string, unknown>).dayNumber) === d
    );
    const positional = rawDays[d - 1];
    const positionalDayNum =
      positional && typeof positional === 'object'
        ? Number((positional as Record<string, unknown>).dayNumber)
        : NaN;
    const matched =
      exactMatch ||
      (positional && typeof positional === 'object' && !Number.isFinite(positionalDayNum)
        ? positional
        : undefined);

    if (!matched || typeof matched !== 'object') {
      throw new MalformedAiOutputError(`Missing plan for Day ${d} in Gemini output.`);
    }
    const dayObj = matched as Record<string, unknown>;
    const reqPlan = input.dayPlans.find((p) => p.dayNumber === d);
    const pace: DayPace = VALID_PACES.includes(dayObj.pace as DayPace)
      ? (dayObj.pace as DayPace)
      : reqPlan?.pace || 'Balanced';
    const title =
      typeof dayObj.title === 'string' && dayObj.title.trim()
        ? dayObj.title.trim().slice(0, 160)
        : reqPlan?.title || `Day ${d} in ${input.destination}`;
    const notes = Array.isArray(dayObj.notes)
      ? dayObj.notes
          .map((n) => (typeof n === 'string' ? n.trim().slice(0, 200) : ''))
          .filter((n) => n.length > 0)
          .slice(0, 10)
      : reqPlan?.notes || [];

    dayPlans.push({ dayNumber: d, title, pace, notes });
    activities.push(...normalizeDayActivitiesList(dayObj.activities, d, input.destination));
  }

  return {
    tripTitle,
    overview,
    practicalNotes,
    dayPlans,
    activities,
    verificationStatus: 'ai_unverified',
  };
}

export interface NormalizedRegeneratedDay {
  dayPlan: NormalizedDayPlan;
  activities: NormalizedActivity[];
  verificationStatus: 'ai_unverified';
}

export function normalizeRegeneratedDay(
  rawText: string,
  input: RegenerateDayInput
): NormalizedRegeneratedDay {
  const parsed = parseJsonSafe(rawText);
  const returnedDay = Number(parsed.dayNumber);
  if (Number.isFinite(returnedDay) && returnedDay !== input.dayNumber) {
    // Enforce exact day isolation: reject or strictly bind only to requested dayNumber
    if (returnedDay < 1 || returnedDay > input.daysCount) {
      throw new MalformedAiOutputError(
        `Gemini returned invalid dayNumber ${returnedDay} for Day ${input.dayNumber}.`
      );
    }
  }

  const pace: DayPace = VALID_PACES.includes(parsed.pace as DayPace)
    ? (parsed.pace as DayPace)
    : input.dayPlan.pace;
  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 160)
      : input.dayPlan.title;
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes
        .map((n) => (typeof n === 'string' ? n.trim().slice(0, 200) : ''))
        .filter((n) => n.length > 0)
        .slice(0, 10)
    : input.dayPlan.notes;

  const activities = normalizeDayActivitiesList(parsed.activities, input.dayNumber, input.destination);

  return {
    dayPlan: {
      dayNumber: input.dayNumber,
      title,
      pace,
      notes,
    },
    activities,
    verificationStatus: 'ai_unverified',
  };
}

export interface NormalizedRecommendationItem {
  id: string;
  name: string;
  category: ActivityCategory;
  recommendationType: RecommendationCategory;
  locationHint: string;
  shortExplanation: string;
  whyItSuitsTrip: string;
  approxCostMin: number;
  approxCostMax: number;
  estimatedCostMid: number;
  suggestedDurationMinutes: number;
  importantCaveats: string;
  isChildFriendly: boolean;
  crowdLevel: 'Low' | 'Moderate' | 'High';
  tags: ('Similar' | 'Lower Cost' | 'Child-Friendly' | 'Shorter Duration' | 'Different Type')[];
  imageUrl: string;
  verificationStatus: 'ai_unverified';
}

export function normalizeRecommendations(
  rawText: string,
  input: RecommendationsInput
): NormalizedRecommendationItem[] {
  const parsed = parseJsonSafe(rawText);
  if (!Array.isArray(parsed.recommendations)) {
    throw new MalformedAiOutputError('Gemini recommendations response must include a recommendations array.');
  }

  const blockedTitles = new Set(
    [...input.existingTitles, ...input.excludeTitles, input.targetActivity?.title || '']
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set<string>();
  const results: NormalizedRecommendationItem[] = [];

  for (const raw of parsed.recommendations.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 180) : '';
    if (!name) continue;
    const normalizedKey = name.toLowerCase();
    if (blockedTitles.has(normalizedKey) || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);

    const category = normalizeCategory(obj.category);
    const minCost = clampInt(obj.approxCostMin, 0, 10000000, 0);
    const maxCost = Math.max(minCost, clampInt(obj.approxCostMax, minCost, 10000000, minCost));
    const midCost = Math.round((minCost + maxCost) / 2);

    const rawTags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is (typeof VALID_REC_TAGS)[number] =>
          VALID_REC_TAGS.includes(t as (typeof VALID_REC_TAGS)[number])
        )
      : [];

    results.push({
      id: makeUniqueId('ai-rec'),
      name,
      category,
      recommendationType: input.category,
      locationHint:
        typeof obj.locationHint === 'string' && obj.locationHint.trim()
          ? obj.locationHint.trim().slice(0, 260)
          : input.destination,
      shortExplanation:
        typeof obj.shortExplanation === 'string' && obj.shortExplanation.trim()
          ? obj.shortExplanation.trim().slice(0, 400)
          : `${name} in ${input.destination}.`,
      whyItSuitsTrip:
        typeof obj.whyItSuitsTrip === 'string' && obj.whyItSuitsTrip.trim()
          ? obj.whyItSuitsTrip.trim().slice(0, 300)
          : `Fits your ${input.travelStyle.toLowerCase()} travel style.`,
      approxCostMin: minCost,
      approxCostMax: maxCost,
      estimatedCostMid: midCost,
      suggestedDurationMinutes: clampInt(obj.suggestedDurationMinutes, 15, 720, 90),
      importantCaveats:
        typeof obj.importantCaveats === 'string' && obj.importantCaveats.trim()
          ? obj.importantCaveats.trim().slice(0, 300)
          : 'AI suggestion awaiting verification — confirm hours, availability, and current pricing before booking.',
      isChildFriendly: typeof obj.isChildFriendly === 'boolean' ? obj.isChildFriendly : true,
      crowdLevel: normalizeCrowdLevel(obj.crowdLevel),
      tags: rawTags.length > 0 ? rawTags : ['Similar'],
      imageUrl: pickFallbackImage(category, input.destination),
      verificationStatus: 'ai_unverified',
    });
  }

  return results;
}

export interface NormalizedBudgetEstimate {
  currency: string;
  isEstimate: true;
  categories: {
    accommodation: number;
    food: number;
    localTransport: number;
    intercityTransport: number;
    activitiesAndAttractions: number;
    shopping: number;
    miscellaneous: number;
    contingency: number;
  };
  categoryNotes: {
    accommodation: string;
    food: string;
    localTransport: string;
    intercityTransport: string;
    activitiesAndAttractions: string;
    shopping: string;
    miscellaneous: string;
    contingency: string;
  };
  estimatedTotal: number;
  perDayEstimate: number;
  perPersonEstimate: number;
  plannedActivitiesBaselineTotal: number;
  assumptions: string[];
  disclaimer: string;
}

export function normalizeBudgetEstimate(
  rawText: string,
  input: EstimateBudgetInput
): NormalizedBudgetEstimate {
  const parsed = parseJsonSafe(rawText);
  const rawCats =
    parsed.categories && typeof parsed.categories === 'object'
      ? (parsed.categories as Record<string, unknown>)
      : null;
  if (!rawCats) {
    throw new MalformedAiOutputError('Gemini budget estimate did not include a categories breakdown.');
  }

  const rawNotes =
    parsed.categoryNotes && typeof parsed.categoryNotes === 'object'
      ? (parsed.categoryNotes as Record<string, unknown>)
      : {};

  const categories = {
    accommodation: clampInt(rawCats.accommodation, 0, 50000000, 0),
    food: clampInt(rawCats.food, 0, 50000000, 0),
    localTransport: clampInt(rawCats.localTransport, 0, 50000000, 0),
    intercityTransport: clampInt(rawCats.intercityTransport, 0, 50000000, 0),
    activitiesAndAttractions: clampInt(rawCats.activitiesAndAttractions, 0, 50000000, 0),
    shopping: clampInt(rawCats.shopping, 0, 50000000, 0),
    miscellaneous: clampInt(rawCats.miscellaneous, 0, 50000000, 0),
    contingency: clampInt(rawCats.contingency, 0, 50000000, 0),
  };

  // Authoritative sum computed server-side so category values never drift or double-count
  const estimatedTotal =
    categories.accommodation +
    categories.food +
    categories.localTransport +
    categories.intercityTransport +
    categories.activitiesAndAttractions +
    categories.shopping +
    categories.miscellaneous +
    categories.contingency;

  if (estimatedTotal <= 0) {
    throw new MalformedAiOutputError('Gemini returned a non-positive total budget estimate.');
  }

  const cleanNote = (key: keyof typeof categories, fallback: string) => {
    const v = rawNotes[key];
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 220) : fallback;
  };

  const travelersCount = Math.max(1, input.adults + input.children);
  const plannedBaseline = input.plannedActivities.reduce((s, a) => s + a.cost, 0);

  const assumptions = Array.isArray(parsed.assumptions)
    ? parsed.assumptions
        .map((a) => (typeof a === 'string' ? a.trim().slice(0, 240) : ''))
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return {
    currency: input.currency || 'INR',
    isEstimate: true,
    categories,
    categoryNotes: {
      accommodation: cleanNote('accommodation', `${input.accommodationPreference} stay assumption.`),
      food: cleanNote('food', 'Daily meals, snacks, and local dining.'),
      localTransport: cleanNote('localTransport', 'Local cabs, autos, or transit.'),
      intercityTransport: cleanNote('intercityTransport', `Travel between ${input.origin} and ${input.destination}.`),
      activitiesAndAttractions: cleanNote('activitiesAndAttractions', 'Entry fees, tours, and experiences.'),
      shopping: cleanNote('shopping', 'Souvenirs and optional local purchases.'),
      miscellaneous: cleanNote('miscellaneous', 'Tips, SIM/data, and minor incidentals.'),
      contingency: cleanNote('contingency', 'Buffer for unexpected price changes.'),
    },
    estimatedTotal,
    perDayEstimate: Math.round(estimatedTotal / Math.max(1, input.daysCount)),
    perPersonEstimate: Math.round(estimatedTotal / travelersCount),
    plannedActivitiesBaselineTotal: plannedBaseline,
    assumptions:
      assumptions.length > 0
        ? assumptions
        : [
            `Estimated for ${input.adults} adult(s) and ${input.children} child(ren) over ${input.daysCount} day(s) in ${input.destination}.`,
          ],
    disclaimer:
      typeof parsed.disclaimer === 'string' && parsed.disclaimer.trim()
        ? parsed.disclaimer.trim().slice(0, 320)
        : 'AI planning estimate only — not live hotel, transport, or ticket prices. Confirm rates before booking.',
  };
}

export interface NormalizedRefinedActivity {
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
    isChildFriendly: boolean;
    crowdLevel: 'Low' | 'Moderate' | 'High';
    notes?: string;
    locationChanged: boolean;
  };
  changeSummary: string;
  verificationStatus: 'ai_unverified';
}

export function normalizeRefinedActivity(
  rawText: string,
  input: RefineActivityInput
): NormalizedRefinedActivity {
  const parsed = parseJsonSafe(rawText);
  const orig = input.activity;

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 180)
      : orig.title;
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim().slice(0, 950)
      : orig.description;
  const category = normalizeCategory(parsed.category ?? orig.category);
  const location =
    typeof parsed.location === 'string' && parsed.location.trim()
      ? parsed.location.trim().slice(0, 280)
      : orig.location;

  const rawStartMin = parseHHMMToMinutes(parsed.startTime, parseHHMMToMinutes(orig.startTime, 540));
  const startMin = Math.min(23 * 60 + 30, rawStartMin);
  const requestedDuration = clampInt(parsed.durationMinutes, 15, 720, orig.durationMinutes);
  const maxDuration = Math.max(15, 23 * 60 + 55 - startMin);
  const durationMinutes = Math.min(requestedDuration, maxDuration);
  const endTime = minutesToHHMM(startMin + durationMinutes);
  const cost = clampInt(parsed.estimatedCost, 0, 10000000, orig.cost);
  const locationChanged = location.trim().toLowerCase() !== orig.location.trim().toLowerCase();

  return {
    activity: {
      id: orig.id, // Strictly preserve existing Firestore activity ID
      title,
      description,
      category,
      location,
      startTime: minutesToHHMM(startMin),
      endTime,
      durationMinutes,
      cost,
      day: orig.day, // Preserve day ownership
      isChildFriendly:
        typeof parsed.isChildFriendly === 'boolean'
          ? parsed.isChildFriendly
          : orig.isChildFriendly ?? true,
      crowdLevel: normalizeCrowdLevel(parsed.crowdLevel ?? orig.crowdLevel),
      notes:
        typeof parsed.notes === 'string' && parsed.notes.trim()
          ? parsed.notes.trim().slice(0, 480)
          : orig.notes,
      locationChanged,
    },
    changeSummary:
      typeof parsed.changeSummary === 'string' && parsed.changeSummary.trim()
        ? parsed.changeSummary.trim().slice(0, 260)
        : 'Refined activity using Gemini AI.',
    verificationStatus: 'ai_unverified',
  };
}
