import { GoogleGenAI, ThinkingLevel, type Schema } from '@google/genai';
import {
  ESTIMATE_BUDGET_SCHEMA,
  EstimateBudgetInput,
  GENERATE_ITINERARY_SCHEMA,
  GenerateItineraryInput,
  RECOMMENDATIONS_SCHEMA,
  RecommendationsInput,
  REFINE_ACTIVITY_SCHEMA,
  RefineActivityInput,
  REGENERATE_DAY_SCHEMA,
  RegenerateDayInput,
} from '../schemas/aiSchemas';
import {
  MalformedAiOutputError,
  normalizeBudgetEstimate,
  NormalizedBudgetEstimate,
  NormalizedGeneratedItinerary,
  NormalizedRecommendationItem,
  NormalizedRefinedActivity,
  NormalizedRegeneratedDay,
  normalizeGeneratedItinerary,
  normalizeRecommendations,
  normalizeRefinedActivity,
  normalizeRegeneratedDay,
} from '../utils/responseNormalizer';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

export class GeminiServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'GeminiServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getConfiguredGeminiModel(): string {
  const envModel = process.env.GEMINI_MODEL?.trim();
  return envModel && envModel.length > 0 ? envModel : DEFAULT_GEMINI_MODEL;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
}

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey: string | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiServiceError(
      503,
      'GEMINI_NOT_CONFIGURED',
      'Server-side GEMINI_API_KEY is not configured. Add GEMINI_API_KEY in Google AI Studio Settings > Secrets to enable AI features.'
    );
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

const FACTUAL_ACCURACY_INSTRUCTION = [
  'You are TripMate AI, an accurate and practical travel planner focused on realistic pacing and INR cost planning.',
  'STRICT FACTUAL ACCURACY RULES:',
  '- NEVER invent or guess Google Maps place IDs, exact latitude/longitude coordinates, verified street addresses, opening hours, live booking availability, live ticket/hotel rates, or exact route distances/durations.',
  '- Use well-known landmark/neighborhood names in location fields; do not fabricate street numbers or unverified business claims.',
  '- Keep schedules realistically paced with meal windows and rest time; avoid overly packed itineraries.',
  '- Return ONLY valid JSON matching the requested schema.',
].join('\n');

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { status?: unknown; code?: unknown; message?: unknown };
  const status = Number(anyErr.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(anyErr.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('unavailable') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit')
  );
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new GeminiServiceError(504, 'GEMINI_TIMEOUT', 'Gemini AI request timed out. Please retry.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GeminiExecutionAdapter {
  generateJson(params: {
    systemInstruction: string;
    prompt: string;
    responseSchema: Schema;
    thinkingLevel: ThinkingLevel;
    timeoutMs?: number;
  }): Promise<string>;
}

const defaultAdapter: GeminiExecutionAdapter = {
  async generateJson({ systemInstruction, prompt, responseSchema, thinkingLevel, timeoutMs = 45000 }) {
    const ai = getGeminiClient();
    const model = getConfiguredGeminiModel();

    const maxAttempts = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await runWithTimeout(
          ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              thinkingConfig: { thinkingLevel },
            },
          }),
          timeoutMs
        );
        const text = response.text;
        if (!text || !text.trim()) {
          throw new MalformedAiOutputError('Gemini returned an empty response body.');
        }
        return text;
      } catch (err) {
        lastErr = err;
        if (
          err instanceof GeminiServiceError &&
          (err.code === 'GEMINI_NOT_CONFIGURED' || err.code === 'GEMINI_TIMEOUT')
        ) {
          throw err;
        }
        if (err instanceof MalformedAiOutputError) {
          throw err;
        }
        if (attempt < maxAttempts && isTransientError(err)) {
          const backoffMs = 400 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        break;
      }
    }

    if (lastErr instanceof GeminiServiceError) {
      throw lastErr;
    }

    const status =
      lastErr && typeof lastErr === 'object' && 'status' in lastErr
        ? Number((lastErr as { status: unknown }).status)
        : 502;
    const rawMsg =
      lastErr instanceof Error ? lastErr.message : 'Upstream Gemini AI call failed.';
    // Sanitize so keys or auth headers are never echoed
    const safeMsg = rawMsg.replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]');

    if (status === 401 || status === 403) {
      throw new GeminiServiceError(
        502,
        'GEMINI_AUTH_ERROR',
        'Server Gemini API credentials were rejected by upstream service.'
      );
    }
    if (status === 404 || safeMsg.toLowerCase().includes('not found')) {
      throw new GeminiServiceError(
        502,
        'GEMINI_MODEL_UNAVAILABLE',
        `Configured Gemini model "${getConfiguredGeminiModel()}" is unavailable in this project.`
      );
    }
    if (status === 429) {
      throw new GeminiServiceError(
        429,
        'GEMINI_UPSTREAM_RATE_LIMIT',
        'Gemini AI service is temporarily rate-limited. Please wait a moment and retry.'
      );
    }
    throw new GeminiServiceError(
      status >= 400 && status < 600 ? 502 : 500,
      'GEMINI_REQUEST_FAILED',
      `Unable to complete Gemini AI request (${safeMsg.slice(0, 180)}).`
    );
  },
};

export function createGeminiAiService(adapter: GeminiExecutionAdapter = defaultAdapter) {
  return {
    async generateItinerary(input: GenerateItineraryInput): Promise<NormalizedGeneratedItinerary> {
      const dateInfo =
        input.startDate && input.endDate
          ? `Dates: ${input.startDate} to ${input.endDate} (${input.daysCount} days)`
          : `Duration: ${input.daysCount} days`;

      const daySpecs = Array.from({ length: input.daysCount }, (_, i) => {
        const reqPlan = input.dayPlans.find((d) => d.dayNumber === i + 1);
        const pace = reqPlan?.pace || (i === 0 ? 'Relaxed' : 'Balanced');
        const notes = reqPlan?.notes?.length ? ` · Focus: ${reqPlan.notes.join(', ')}` : '';
        return `Day ${i + 1}: pace=${pace}${notes}`;
      }).join('\n');

      const prompt = [
        `Create a complete ${input.daysCount}-day travel itinerary for ${input.destination} departing from ${input.origin}.`,
        dateInfo,
        `Travelers: ${input.adults} adult(s), ${input.children} child(ren).`,
        `Travel Style: ${input.travelStyle}.`,
        `Target Budget (INR): Total ₹${input.budget.total}, Daily ~₹${input.budget.daily} (Food ₹${input.budget.food}, Transport ₹${input.budget.transport}, Attractions ₹${input.budget.attraction}).`,
        input.stayMode === 'with-hotel' && input.hotel
          ? `Anchored Stay Hotel: ${input.hotel.name} (${input.hotel.formattedAddress}). Prioritize stops reachable via ${input.commuteMode}.`
          : `Stay Mode: Flexible city exploration.`,
        input.accommodationPreference ? `Accommodation preference: ${input.accommodationPreference}` : '',
        input.transportPreference ? `Transport preference: ${input.transportPreference}` : '',
        input.accessibilityNeeds ? `Accessibility needs: ${input.accessibilityNeeds}` : '',
        input.interests?.length ? `Interests: ${input.interests.join(', ')}` : '',
        input.generalNotes.length ? `General traveler notes: ${input.generalNotes.join('; ')}` : '',
        `Per-day pace & hints:\n${daySpecs}`,
        'For each day generate 3-5 realistic activities (3 for Relaxed, 4 for Balanced, 5 for Activity-heavy) including local meal suggestions and breathing room.',
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await adapter.generateJson({
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: GENERATE_ITINERARY_SCHEMA,
        thinkingLevel: ThinkingLevel.MEDIUM,
        timeoutMs: 45000,
      });

      return normalizeGeneratedItinerary(raw, input);
    },

    async regenerateDay(input: RegenerateDayInput): Promise<NormalizedRegeneratedDay> {
      const prompt = [
        `Regenerate ONLY Day ${input.dayNumber} of a ${input.daysCount}-day trip to ${input.destination} (from ${input.origin}).`,
        input.date ? `Selected date: ${input.date}` : '',
        `User refinement instruction: "${input.instruction}"`,
        `Travelers: ${input.adults} adult(s), ${input.children} child(ren). Style: ${input.travelStyle}.`,
        `Target daily budget: ~₹${input.dailyBudget} (overall trip budget ₹${input.budgetTotal}).`,
        `Requested day pace: ${input.dayPlan.pace}. Current day title: "${input.dayPlan.title}".`,
        input.stayMode === 'with-hotel' && input.hotel
          ? `Base hotel: ${input.hotel.name} (${input.hotel.formattedAddress}), commute: ${input.commuteMode}.`
          : '',
        input.generalNotes.length ? `Trip notes: ${input.generalNotes.join('; ')}` : '',
        input.existingDayActivities.length
          ? `Current Day ${input.dayNumber} stops being replaced: ${input.existingDayActivities
              .map((a) => `${a.startTime} ${a.title} (${a.category}, ₹${a.cost})`)
              .join(' | ')}`
          : '',
        input.otherDaysHighlights.length
          ? `Activities already scheduled on OTHER days (DO NOT repeat these): ${input.otherDaysHighlights.join(', ')}`
          : '',
        `Return updated dayPlan and 3-5 well-paced activities strictly for dayNumber ${input.dayNumber}.`,
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await adapter.generateJson({
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: REGENERATE_DAY_SCHEMA,
        thinkingLevel: ThinkingLevel.LOW,
        timeoutMs: 35000,
      });

      return normalizeRegeneratedDay(raw, input);
    },

    async getRecommendations(input: RecommendationsInput): Promise<NormalizedRecommendationItem[]> {
      const categoryLabels: Record<RecommendationsInput['category'], string> = {
        places_to_visit: 'Places to Visit / Sightseeing Landmarks',
        activities: 'Experiences & Activities',
        food_dining: 'Food, Cafes & Regional Dining Suggestions',
        accommodation: 'Accommodation Area & Stay Style Ideas',
        local_experiences: 'Authentic Local Experiences & Cultural Workshops',
        alternatives: 'Alternative Stops to Replace Existing Activity',
      };

      const excluded = [...input.existingTitles, ...input.excludeTitles].slice(0, 50);

      const prompt = [
        `Recommend 5 distinct ${categoryLabels[input.category]} in ${input.destination}.`,
        `Trip context: ${input.daysCount} days, ${input.adults} adult(s), ${input.children} child(ren), ${input.travelStyle} style, total budget ₹${input.budgetTotal}.`,
        input.startDate && input.endDate ? `Travel window: ${input.startDate} to ${input.endDate}.` : '',
        input.interests.length ? `Interests/notes: ${input.interests.join(', ')}.` : '',
        input.stayMode === 'with-hotel' && input.hotel
          ? `Traveler hotel base: ${input.hotel.name} (${input.hotel.formattedAddress}).`
          : '',
        input.targetActivity
          ? `Replacing target activity: "${input.targetActivity.title}" (${input.targetActivity.category}, ${input.targetActivity.durationMinutes}m, ₹${input.targetActivity.cost}, area: ${input.targetActivity.location}).`
          : '',
        input.instruction ? `Additional preference: ${input.instruction}` : '',
        excluded.length
          ? `Do NOT repeat or suggest any of these already-listed items: ${excluded.join(' | ')}`
          : '',
        'Do not fabricate exact ratings, review counts, opening hours, booking links, or exact live prices. Give approximate INR cost ranges and candid importantCaveats.',
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await adapter.generateJson({
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: RECOMMENDATIONS_SCHEMA,
        thinkingLevel: ThinkingLevel.LOW,
        timeoutMs: 35000,
      });

      return normalizeRecommendations(raw, input);
    },

    async estimateBudget(input: EstimateBudgetInput): Promise<NormalizedBudgetEstimate> {
      const plannedSummary =
        input.plannedActivities.length > 0
          ? input.plannedActivities
              .slice(0, 40)
              .map((a) => `Day ${a.day}: ${a.title} (${a.category}, ₹${a.cost})`)
              .join('; ')
          : 'No pre-planned activities supplied.';

      const prompt = [
        `Estimate a realistic, itemized trip budget in ${input.currency} for ${input.destination} traveling from ${input.origin}.`,
        `Duration: ${input.daysCount} day(s). Group: ${input.adults} adult(s), ${input.children} child(ren).`,
        `Travel Style: ${input.travelStyle}. Accommodation preference: ${input.accommodationPreference}.`,
        input.userBudgetTotal !== undefined
          ? `User's current target budget reference: ₹${input.userBudgetTotal} (provide a realistic independent estimate across categories and note how it compares).`
          : '',
        `Existing planned activities context: ${plannedSummary}`,
        input.notes ? `Additional traveler notes: ${input.notes}` : '',
        'Provide realistic non-negative integer estimates for each of the 8 mutually exclusive categories (accommodation, food, localTransport, intercityTransport, activitiesAndAttractions, shopping, miscellaneous, contingency) with NO double counting between categories, plus clear assumptions and an estimate disclaimer.',
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await adapter.generateJson({
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: ESTIMATE_BUDGET_SCHEMA,
        thinkingLevel: ThinkingLevel.LOW,
        timeoutMs: 30000,
      });

      return normalizeBudgetEstimate(raw, input);
    },

    async refineActivity(input: RefineActivityInput): Promise<NormalizedRefinedActivity> {
      const a = input.activity;
      const prompt = [
        `Refine ONLY this single activity on Day ${input.dayNumber} of a trip to ${input.destination}:`,
        `Current activity: title="${a.title}", category=${a.category}, location="${a.location}", startTime=${a.startTime}, durationMinutes=${a.durationMinutes}, cost=₹${a.cost}, childFriendly=${Boolean(a.isChildFriendly)}, crowdLevel=${a.crowdLevel || 'Moderate'}, description="${a.description}".`,
        `User refinement request: "${input.instruction}"`,
        `Group: ${input.adults} adult(s), ${input.children} child(ren), style=${input.travelStyle}.`,
        input.stayMode === 'with-hotel' && input.hotel
          ? `Hotel stay: ${input.hotel.name} (${input.hotel.formattedAddress}).`
          : '',
        input.dayScheduleSummary.length
          ? `Other activities on Day ${input.dayNumber} (avoid time collisions): ${input.dayScheduleSummary
              .map((s) => `${s.startTime}-${s.endTime} ${s.title}`)
              .join(' | ')}`
          : '',
        'Keep unchanged fields aligned with the original activity unless the instruction asks to alter them. Never claim a newly suggested spot is verified nearby without verification.',
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await adapter.generateJson({
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: REFINE_ACTIVITY_SCHEMA,
        thinkingLevel: ThinkingLevel.LOW,
        timeoutMs: 30000,
      });

      return normalizeRefinedActivity(raw, input);
    },
  };
}

export type GeminiAiService = ReturnType<typeof createGeminiAiService>;
