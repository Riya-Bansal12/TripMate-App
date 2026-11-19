import {
  ESTIMATE_BUDGET_SCHEMA,
  EstimateBudgetInput,
  GENERATE_ITINERARY_SCHEMA,
  GeminiJsonSchema,
  GenerateItineraryInput,
  RECOMMENDATIONS_SCHEMA,
  RecommendationsInput,
  REFINE_ACTIVITY_SCHEMA,
  RefineActivityInput,
  REGENERATE_DAY_SCHEMA,
  RegenerateDayInput,
} from '../schemas/aiSchemas';
import { WorkerEnv } from '../types';
import {
  MalformedAiOutputError,
  NormalizedBudgetEstimate,
  NormalizedGeneratedItinerary,
  NormalizedRecommendationItem,
  NormalizedRefinedActivity,
  NormalizedRegeneratedDay,
  normalizeBudgetEstimate,
  normalizeGeneratedItinerary,
  normalizeRecommendations,
  normalizeRefinedActivity,
  normalizeRegeneratedDay,
} from '../utils/responseNormalizer';

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type WorkerThinkingLevel = 'LOW' | 'MEDIUM' | 'HIGH';

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

export function getConfiguredGeminiModel(env: WorkerEnv): string {
  const envModel = env.GEMINI_MODEL?.trim();
  return envModel && envModel.length > 0 ? envModel : DEFAULT_GEMINI_MODEL;
}

export function isGeminiConfigured(env: WorkerEnv): boolean {
  return Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length > 0);
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/x-goog-api-key['":\s=]+[A-Za-z0-9_-]+/gi, 'x-goog-api-key=[REDACTED]');
}

const FACTUAL_ACCURACY_INSTRUCTION = [
  'You are TripMate AI, an accurate and practical travel planner focused on realistic pacing and INR cost planning.',
  'STRICT FACTUAL ACCURACY RULES:',
  '- NEVER invent or guess Google Maps place IDs, exact latitude/longitude coordinates, verified street addresses, opening hours, live booking availability, live ticket/hotel rates, or exact route distances/durations.',
  '- Use well-known landmark/neighborhood names in location fields; do not fabricate street numbers or unverified business claims.',
  '- Keep schedules realistically paced with meal windows and rest time; avoid overly packed itineraries.',
  '- Return ONLY valid JSON matching the requested schema.',
].join('\n');

function supportsThinkingLevel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith('gemini-3') || normalized.startsWith('gemini-4');
}

function isTransientHttpOrError(status: number | null, message: string): boolean {
  if (status !== null && [429, 500, 502, 503, 504].includes(status)) return true;
  const msg = message.toLowerCase();
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

interface GeminiRestResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

function extractResponseText(payload: GeminiRestResponse): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('');
}

export interface WorkerGeminiExecutionAdapter {
  generateJson(params: {
    env: WorkerEnv;
    systemInstruction: string;
    prompt: string;
    responseSchema: GeminiJsonSchema;
    thinkingLevel: WorkerThinkingLevel;
    timeoutMs?: number;
  }): Promise<string>;
}

export function createRestGeminiAdapter(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): WorkerGeminiExecutionAdapter {
  return {
    async generateJson({ env, systemInstruction, prompt, responseSchema, thinkingLevel, timeoutMs = 45000 }) {
      const apiKey = env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        throw new GeminiServiceError(
          503,
          'GEMINI_NOT_CONFIGURED',
          'Server-side GEMINI_API_KEY secret is not configured.'
        );
      }

      const model = getConfiguredGeminiModel(env);
      const endpointUrl = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

      const generationConfig: Record<string, unknown> = {
        responseMimeType: 'application/json',
        responseSchema,
      };
      if (supportsThinkingLevel(model)) {
        generationConfig.thinkingConfig = { thinkingLevel };
      }

      const requestBody = JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig,
      });

      const maxAttempts = 3;
      let lastStatus: number | null = null;
      let lastMessage = 'Upstream Gemini AI call failed.';

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('GEMINI_TIMEOUT'), timeoutMs);

        try {
          const response = await fetchImpl(endpointUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
              'User-Agent': 'aistudio-build',
            },
            body: requestBody,
            signal: controller.signal,
          });

          const rawBodyText = await response.text();
          let parsedBody: GeminiRestResponse | null = null;
          try {
            parsedBody = JSON.parse(rawBodyText) as GeminiRestResponse;
          } catch {
            parsedBody = null;
          }

          if (!response.ok) {
            lastStatus = response.status;
            lastMessage = parsedBody?.error?.message || `HTTP ${response.status}`;

            if (attempt < maxAttempts && isTransientHttpOrError(response.status, lastMessage)) {
              const backoffMs = 400 * Math.pow(2, attempt - 1);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            break;
          }

          if (!parsedBody) {
            throw new MalformedAiOutputError('Gemini returned non-JSON HTTP 200 payload.');
          }

          const text = extractResponseText(parsedBody);
          if (!text || !text.trim()) {
            throw new MalformedAiOutputError('Gemini returned an empty response body.');
          }
          return text;
        } catch (err) {
          if (err instanceof MalformedAiOutputError || err instanceof GeminiServiceError) {
            throw err;
          }

          const isAbort =
            controller.signal.aborted ||
            (err instanceof Error && err.name === 'AbortError');
          if (isAbort) {
            throw new GeminiServiceError(
              504,
              'GEMINI_TIMEOUT',
              'Gemini AI request timed out. Please retry.'
            );
          }

          lastStatus = null;
          lastMessage = err instanceof Error ? err.message : 'Network error calling Gemini API.';
          if (attempt < maxAttempts && isTransientHttpOrError(null, lastMessage)) {
            const backoffMs = 400 * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          break;
        } finally {
          clearTimeout(timer);
        }
      }

      const safeMsg = redactSensitiveText(lastMessage);
      if (lastStatus === 401 || lastStatus === 403) {
        throw new GeminiServiceError(
          502,
          'GEMINI_AUTH_ERROR',
          'Server Gemini API credentials were rejected by upstream service.'
        );
      }
      if (lastStatus === 404 || safeMsg.toLowerCase().includes('not found')) {
        throw new GeminiServiceError(
          502,
          'GEMINI_MODEL_UNAVAILABLE',
          `Configured Gemini model "${model}" is unavailable in this project.`
        );
      }
      if (lastStatus === 429) {
        throw new GeminiServiceError(
          429,
          'GEMINI_UPSTREAM_RATE_LIMIT',
          'Gemini AI service is temporarily rate-limited. Please wait a moment and retry.'
        );
      }

      throw new GeminiServiceError(
        lastStatus !== null && lastStatus >= 400 && lastStatus < 600 ? 502 : 500,
        'GEMINI_REQUEST_FAILED',
        `Unable to complete Gemini AI request (${safeMsg.slice(0, 180)}).`
      );
    },
  };
}

export function createWorkerGeminiService(
  adapter: WorkerGeminiExecutionAdapter = createRestGeminiAdapter()
) {
  return {
    async generateItinerary(
      env: WorkerEnv,
      input: GenerateItineraryInput
    ): Promise<NormalizedGeneratedItinerary> {
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
        env,
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: GENERATE_ITINERARY_SCHEMA,
        thinkingLevel: 'MEDIUM',
        timeoutMs: 45000,
      });

      return normalizeGeneratedItinerary(raw, input);
    },

    async regenerateDay(
      env: WorkerEnv,
      input: RegenerateDayInput
    ): Promise<NormalizedRegeneratedDay> {
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
        env,
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: REGENERATE_DAY_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: 35000,
      });

      return normalizeRegeneratedDay(raw, input);
    },

    async getRecommendations(
      env: WorkerEnv,
      input: RecommendationsInput
    ): Promise<NormalizedRecommendationItem[]> {
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
        env,
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: RECOMMENDATIONS_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: 35000,
      });

      return normalizeRecommendations(raw, input);
    },

    async estimateBudget(
      env: WorkerEnv,
      input: EstimateBudgetInput
    ): Promise<NormalizedBudgetEstimate> {
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
        env,
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: ESTIMATE_BUDGET_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: 30000,
      });

      return normalizeBudgetEstimate(raw, input);
    },

    async refineActivity(
      env: WorkerEnv,
      input: RefineActivityInput
    ): Promise<NormalizedRefinedActivity> {
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
        env,
        systemInstruction: FACTUAL_ACCURACY_INSTRUCTION,
        prompt,
        responseSchema: REFINE_ACTIVITY_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: 30000,
      });

      return normalizeRefinedActivity(raw, input);
    },
  };
}

export type WorkerGeminiService = ReturnType<typeof createWorkerGeminiService>;
