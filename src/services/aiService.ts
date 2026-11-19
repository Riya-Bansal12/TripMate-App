import { auth } from '../firebase';
import { isVerifiedFirebaseUser } from '../services/authService';
import {
  Activity,
  ActivityCategory,
  BudgetBreakdown,
  CommuteMode,
  DayPace,
  DayPlan,
  GeoPoint,
  HotelInfo,
  StayMode,
  TravelStyle,
} from '../types/trip';
import { searchPlacesWithPhoton } from '../utils/photonService';

export type RecommendationCategory =
  | 'places_to_visit'
  | 'activities'
  | 'food_dining'
  | 'accommodation'
  | 'local_experiences'
  | 'alternatives';

export interface AiItineraryActivity {
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

export interface AiGenerateItineraryResponse {
  tripTitle: string;
  overview: string;
  practicalNotes: string[];
  dayPlans: DayPlan[];
  activities: AiItineraryActivity[];
  verificationStatus: 'ai_unverified';
}

export interface AiRegenerateDayResponse {
  dayPlan: DayPlan;
  activities: AiItineraryActivity[];
  verificationStatus: 'ai_unverified';
}

export interface AiRecommendationItem {
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
  verificationStatus: 'ai_unverified' | 'maps_verified';
  verifiedAddress?: string;
  placeId?: string;
  coordinates?: GeoPoint;
}

export interface AiBudgetEstimateResponse {
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

export interface AiRefineActivityResponse {
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
  verificationStatus: 'ai_unverified' | 'maps_verified';
}

export interface AiEnvelope<T> {
  ok: true;
  model: string;
  uid: string;
  data: T;
}

export class AiClientError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  constructor(message: string, code = 'AI_REQUEST_FAILED', statusCode = 500) {
    super(message);
    this.name = 'AiClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function getBearerToken(forceRefresh = false): Promise<string> {
  const currentUser = auth.currentUser;
  if (!currentUser || !isVerifiedFirebaseUser(currentUser)) {
    throw new AiClientError(
      'Please sign in with a verified email account to use TripMate AI features.',
      'AUTH_REQUIRED',
      401
    );
  }
  try {
    return await currentUser.getIdToken(forceRefresh);
  } catch {
    throw new AiClientError(
      'Your authentication session could not be verified. Please sign in again.',
      'AUTH_SESSION_ERROR',
      401
    );
  }
}

async function postAiEndpoint<TPayload, TResult>(
  endpoint: string,
  payload: TPayload
): Promise<{ data: TResult; model: string }> {
  const executeRequest = async (token: string) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new AiClientError(
        'Network error reaching the TripMate AI backend. Check your connection and try again.',
        'NETWORK_ERROR',
        0
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body
    }

    return { response, body };
  };

  let token = await getBearerToken(false);
  let { response, body } = await executeRequest(token);

  // Retry once with a refreshed ID token if the token just expired
  if (response.status === 401 && body?.code === 'AUTH_EXPIRED') {
    token = await getBearerToken(true);
    ({ response, body } = await executeRequest(token));
  }

  if (!response.ok) {
    const serverMessage =
      typeof body?.error === 'string' && body.error.trim()
        ? body.error.trim()
        : `AI request failed with status ${response.status}.`;
    const serverCode = typeof body?.code === 'string' ? body.code : 'AI_REQUEST_FAILED';
    throw new AiClientError(serverMessage, serverCode, response.status);
  }

  const envelope = body as unknown as AiEnvelope<TResult>;
  if (!envelope || envelope.ok !== true || !envelope.data) {
    throw new AiClientError('Received an unexpected response format from AI server.', 'INVALID_ENVELOPE', 502);
  }

  return {
    data: envelope.data,
    model: envelope.model || 'gemini-4-hydrogen',
  };
}

export interface GenerateItineraryPayload {
  origin: string;
  destination: string;
  daysCount: number;
  startDate?: string;
  endDate?: string;
  adults: number;
  children: number;
  budget: BudgetBreakdown;
  travelStyle: TravelStyle;
  dayPlans: DayPlan[];
  generalNotes: string[];
  stayMode: StayMode;
  hotel?: HotelInfo | null;
  commuteMode: CommuteMode;
  accommodationPreference?: string;
  transportPreference?: string;
  accessibilityNeeds?: string;
  interests?: string[];
}

export async function generateItineraryAi(
  payload: GenerateItineraryPayload
): Promise<{ data: AiGenerateItineraryResponse; model: string }> {
  const sanitizedHotel =
    payload.stayMode === 'with-hotel' && payload.hotel
      ? {
          name: payload.hotel.name,
          formattedAddress: payload.hotel.formattedAddress,
          placeId: payload.hotel.placeId,
        }
      : null;

  return postAiEndpoint<unknown, AiGenerateItineraryResponse>('/api/ai/generate-itinerary', {
    ...payload,
    hotel: sanitizedHotel,
  });
}

export interface RegenerateDayPayload {
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
  hotel?: HotelInfo | null;
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

export async function regenerateDayAi(
  payload: RegenerateDayPayload
): Promise<{ data: AiRegenerateDayResponse; model: string }> {
  const sanitizedHotel =
    payload.stayMode === 'with-hotel' && payload.hotel
      ? {
          name: payload.hotel.name,
          formattedAddress: payload.hotel.formattedAddress,
          placeId: payload.hotel.placeId,
        }
      : null;

  return postAiEndpoint<unknown, AiRegenerateDayResponse>('/api/ai/regenerate-day', {
    ...payload,
    hotel: sanitizedHotel,
  });
}

export interface RecommendationsPayload {
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
  hotel?: HotelInfo | null;
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

export async function getRecommendationsAi(
  payload: RecommendationsPayload
): Promise<{ data: { recommendations: AiRecommendationItem[] }; model: string }> {
  const sanitizedHotel =
    payload.stayMode === 'with-hotel' && payload.hotel
      ? {
          name: payload.hotel.name,
          formattedAddress: payload.hotel.formattedAddress,
          placeId: payload.hotel.placeId,
        }
      : null;

  return postAiEndpoint<unknown, { recommendations: AiRecommendationItem[] }>(
    '/api/ai/recommendations',
    {
      ...payload,
      hotel: sanitizedHotel,
    }
  );
}

export interface EstimateBudgetPayload {
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

export async function estimateBudgetAi(
  payload: EstimateBudgetPayload
): Promise<{ data: AiBudgetEstimateResponse; model: string }> {
  return postAiEndpoint<EstimateBudgetPayload, AiBudgetEstimateResponse>(
    '/api/ai/estimate-budget',
    payload
  );
}

export interface RefineActivityPayload {
  destination: string;
  daysCount: number;
  dayNumber: number;
  adults: number;
  children: number;
  travelStyle: TravelStyle;
  instruction: string;
  activity: Activity;
  dayScheduleSummary: {
    title: string;
    startTime: string;
    endTime: string;
    category: ActivityCategory;
  }[];
  stayMode: StayMode;
  hotel?: HotelInfo | null;
}

export async function refineActivityAi(
  payload: RefineActivityPayload
): Promise<{ data: AiRefineActivityResponse; model: string }> {
  const sanitizedHotel =
    payload.stayMode === 'with-hotel' && payload.hotel
      ? {
          name: payload.hotel.name,
          formattedAddress: payload.hotel.formattedAddress,
          placeId: payload.hotel.placeId,
        }
      : null;

  return postAiEndpoint<unknown, AiRefineActivityResponse>('/api/ai/refine-activity', {
    destination: payload.destination,
    daysCount: payload.daysCount,
    dayNumber: payload.dayNumber,
    adults: payload.adults,
    children: payload.children,
    travelStyle: payload.travelStyle,
    instruction: payload.instruction,
    activity: {
      id: payload.activity.id,
      title: payload.activity.title,
      description: payload.activity.description,
      category: payload.activity.category,
      location: payload.activity.location,
      startTime: payload.activity.startTime,
      endTime: payload.activity.endTime,
      durationMinutes: payload.activity.durationMinutes,
      cost: payload.activity.cost,
      day: payload.activity.day,
      isChildFriendly: payload.activity.isChildFriendly,
      crowdLevel: payload.activity.crowdLevel,
      notes: payload.activity.notes,
    },
    dayScheduleSummary: payload.dayScheduleSummary,
    stayMode: payload.stayMode,
    hotel: sanitizedHotel,
  });
}

/**
 * Free OpenStreetMap/Photon geocoding helper for AI-recommended items.
 * Never fabricates coordinates or placeIds when Photon is unavailable or rate-limited.
 */
export async function verifyPlaceWithPhoton(
  placeName: string,
  destination: string,
  biasCenter?: GeoPoint
): Promise<{
  verified: boolean;
  rateLimited?: boolean;
  placeId?: string;
  formattedAddress?: string;
  coordinates?: GeoPoint;
}> {
  const query = `${placeName.trim()} ${destination.trim()}`.trim();
  if (query.length < 2) return { verified: false };

  const res = await searchPlacesWithPhoton(query, {
    limit: 1,
    locationBias: biasCenter,
  });

  if (res.rateLimited || res.unavailable || res.results.length === 0) {
    return {
      verified: false,
      rateLimited: res.rateLimited,
    };
  }

  const first = res.results[0];
  return {
    verified: true,
    placeId: first.placeId,
    formattedAddress: first.formattedAddress || first.name,
    coordinates: first.location,
  };
}
