import { GENERATED_IMAGES } from '../data/destinations';
import {
  Activity,
  ActivityCategory,
  CommuteMode,
  DayPace,
  DayPlan,
  GeoPoint,
  HotelInfo,
  Trip,
} from '../types/trip';
import {
  estimateHeuristicTravelMinutes,
  haversineDistanceKm,
} from './mapsConfig';
import { isPhotonRateLimitCoolingDown, searchPlacesWithPhoton } from './photonService';
import { generateMockItinerary, ItineraryGenerationRequest } from './itineraryGenerator';
import { addMinutesToTime, minutesToTime } from './scheduleUtils';

export interface HotelSearchCandidate {
  id: string;
  name: string;
  formattedAddress: string;
  location: GeoPoint;
}

export interface HotelDiscoveryResult {
  hotels: HotelSearchCandidate[];
  errorMessage?: string;
}

interface DiscoveredPlaceCandidate {
  placeId: string;
  title: string;
  address: string;
  location: GeoPoint;
  category: ActivityCategory;
  preferredSlot: 'morning' | 'midday' | 'afternoon' | 'evening';
  durationMinutes: number;
  baseCost: number;
  description: string;
  imageUrl: string;
  distanceFromHotelKm: number;
  travelFromHotelMinutes: number;
  isFarFromHotel: boolean;
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function pickImageForPlace(category: ActivityCategory, destination: string): string {
  if (category === 'Food') return GENERATED_IMAGES.cafe;
  const lower = destination.toLowerCase();
  if (lower.includes('jaipur')) return GENERATED_IMAGES.jaipur;
  if (lower.includes('goa')) return GENERATED_IMAGES.goa;
  if (lower.includes('manali')) return GENERATED_IMAGES.manali;
  if (lower.includes('kerala')) return GENERATED_IMAGES.kerala;
  if (lower.includes('delhi')) return GENERATED_IMAGES.delhi;
  if (lower.includes('udaipur')) return GENERATED_IMAGES.udaipur;
  return category === 'Leisure' ? GENERATED_IMAGES.hero : GENERATED_IMAGES.udaipur;
}

function mapOsmTypeToCategory(
  osmKey: string | undefined,
  osmValue: string | undefined,
  fallbackCategory: ActivityCategory
): ActivityCategory {
  const k = (osmKey || '').toLowerCase();
  const v = (osmValue || '').toLowerCase();
  if (
    k === 'amenity' &&
    (v.includes('restaurant') || v.includes('cafe') || v.includes('bakery') || v.includes('fast_food'))
  ) {
    return 'Food';
  }
  if (v.includes('park') || v.includes('garden') || v.includes('beach') || k === 'natural') {
    return 'Nature';
  }
  if (
    k === 'historic' ||
    v.includes('museum') ||
    v.includes('temple') ||
    v.includes('palace') ||
    v.includes('place_of_worship')
  ) {
    return 'Culture';
  }
  if (k === 'railway' || k === 'public_transport' || v.includes('station') || v.includes('ferry')) {
    return 'Transport';
  }
  if (v.includes('market') || v.includes('mall') || v.includes('viewpoint')) {
    return 'Leisure';
  }
  return fallbackCategory;
}

function estimateCostForCategory(
  category: ActivityCategory,
  adults: number,
  children: number,
  targetDailyBudget: number,
  activitiesPerDay: number
): number {
  const baseByCat: Record<ActivityCategory, number> = {
    Food: 650,
    Attraction: 950,
    Culture: 600,
    Nature: 400,
    Leisure: 500,
    Transport: 550,
  };
  const travelersFactor = Math.max(1, adults + children * 0.6);
  const raw = baseByCat[category] * (travelersFactor > 2 ? 1 + (travelersFactor - 2) * 0.25 : 1);
  const budgetCapPerAct = targetDailyBudget > 0 ? (targetDailyBudget * 0.9) / Math.max(1, activitiesPerDay) : raw;
  const blended = targetDailyBudget > 0 ? Math.min(raw, Math.max(250, budgetCapPerAct * 1.05)) : raw;
  return Math.round(blended / 50) * 50;
}

function getWaitingMinutesForCategory(category: ActivityCategory, baseWaitMinutes: number): number {
  const base = Math.max(5, Math.min(45, baseWaitMinutes));
  switch (category) {
    case 'Attraction':
    case 'Transport':
      return base;
    case 'Culture':
      return Math.max(5, Math.round(base * 0.9));
    case 'Food':
      return Math.max(5, Math.round(base * 0.65));
    case 'Nature':
    case 'Leisure':
    default:
      return Math.max(5, Math.round(base * 0.6));
  }
}

/**
 * Searches OpenStreetMap lodging places in the destination via Photon (no billing/API key).
 * Never invents hotel listings or coordinates when Photon returns nothing or is rate-limited.
 */
export async function searchHotelsInDestination(
  destination: string,
  biasCenter?: GeoPoint
): Promise<HotelDiscoveryResult> {
  const dest = destination.trim();
  if (!dest) return { hotels: [] };

  const primary = await searchPlacesWithPhoton(dest, {
    limit: 6,
    locationBias: biasCenter,
    osmTags: ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel', 'tourism:resort'],
  });

  if (primary.unavailable && primary.results.length === 0) {
    return {
      hotels: [],
      errorMessage:
        primary.errorMessage ||
        'Hotel discovery is temporarily unavailable. Enter your hotel name or click on the map to pin it manually.',
    };
  }

  let candidates = primary.results;
  if (candidates.length === 0) {
    const fallbackText = await searchPlacesWithPhoton(`hotel ${dest}`, {
      limit: 6,
      locationBias: biasCenter,
    });
    if (fallbackText.unavailable && fallbackText.results.length === 0) {
      return {
        hotels: [],
        errorMessage: fallbackText.errorMessage,
      };
    }
    candidates = fallbackText.results;
  }

  return {
    hotels: candidates.map((c) => ({
      id: c.placeId,
      name: c.name,
      formattedAddress: c.formattedAddress,
      location: c.location,
    })),
  };
}

/**
 * Computes straight-line Haversine distance and clearly estimated travel time heuristic
 * between hotel and target coordinates (zero external paid routing calls).
 */
export async function computeHotelToPlaceMetrics(
  hotelLocation: GeoPoint,
  targetLocation: GeoPoint,
  commuteMode: CommuteMode = 'DRIVING',
  maxRadiusKm = 10
): Promise<{ distanceKm: number; travelMinutes: number; isFarFromHotel: boolean }> {
  const straightKm = haversineDistanceKm(hotelLocation, targetLocation);
  const estTravelMin = estimateHeuristicTravelMinutes(straightKm, commuteMode);

  return {
    distanceKm: straightKm,
    travelMinutes: estTravelMin,
    isFarFromHotel: straightKm > maxRadiusKm || estTravelMin > 45,
  };
}

function orderNearestNeighbor(
  start: GeoPoint,
  items: DiscoveredPlaceCandidate[]
): DiscoveredPlaceCandidate[] {
  const remaining = [...items];
  const ordered: DiscoveredPlaceCandidate[] = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineDistanceKm(current, remaining[i].location);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked);
    current = picked.location;
  }
  return ordered;
}

/**
 * Generates an itinerary anchored to the user's selected hotel using OpenStreetMap/Photon
 * place discovery + Haversine distance & commute heuristics (zero Google Maps calls).
 */
export async function buildWithHotelItinerary(
  req: ItineraryGenerationRequest
): Promise<Trip> {
  const hotel: HotelInfo | null = req.hotel || null;
  if (req.stayMode !== 'with-hotel' || !hotel) {
    return generateMockItinerary(req);
  }

  const commuteMode: CommuteMode = req.commuteMode || 'DRIVING';
  const maxRadiusKm = req.maxHotelRadiusKm || 10;
  const baseWaitingMinutes = req.waitingBufferMinutes ?? 15;
  const destLabel = req.destination.trim() || 'Destination';

  try {
    const searchSpecs: {
      query: string;
      osmTags?: string[];
      fallbackCategory: ActivityCategory;
      preferredSlot: DiscoveredPlaceCandidate['preferredSlot'];
      durationMinutes: number;
    }[] = [
      {
        query: destLabel,
        osmTags: ['tourism:attraction', 'historic'],
        fallbackCategory: 'Attraction',
        preferredSlot: 'morning',
        durationMinutes: 105,
      },
      {
        query: destLabel,
        osmTags: ['amenity:restaurant', 'amenity:cafe'],
        fallbackCategory: 'Food',
        preferredSlot: 'midday',
        durationMinutes: 60,
      },
      {
        query: destLabel,
        osmTags: ['leisure:park', 'tourism:museum'],
        fallbackCategory: 'Nature',
        preferredSlot: 'afternoon',
        durationMinutes: 90,
      },
    ];

    const seenIds = new Set<string>();
    if (hotel.placeId) seenIds.add(hotel.placeId);
    const rawCandidates: DiscoveredPlaceCandidate[] = [];

    for (const spec of searchSpecs) {
      if (isPhotonRateLimitCoolingDown()) break;
      const res = await searchPlacesWithPhoton(spec.query, {
        limit: 8,
        locationBias: hotel.location,
        osmTags: spec.osmTags,
      });

      for (const p of res.results) {
        if (seenIds.has(p.placeId)) continue;
        seenIds.add(p.placeId);
        const straightKm = haversineDistanceKm(hotel.location, p.location);
        const category = mapOsmTypeToCategory(p.osmKey, p.osmValue, spec.fallbackCategory);
        const estTravelMin = estimateHeuristicTravelMinutes(straightKm, commuteMode);
        rawCandidates.push({
          placeId: p.placeId,
          title: p.name,
          address: p.formattedAddress || destLabel,
          location: p.location,
          category,
          preferredSlot: category === 'Food' ? 'midday' : spec.preferredSlot,
          durationMinutes: spec.durationMinutes,
          baseCost: 600,
          description: `${p.formattedAddress || destLabel} · OpenStreetMap listing`,
          imageUrl: pickImageForPlace(category, destLabel),
          distanceFromHotelKm: straightKm,
          travelFromHotelMinutes: estTravelMin,
          isFarFromHotel: straightKm > maxRadiusKm || estTravelMin > 45,
        });
      }
      if (res.rateLimited) break;
    }

    if (rawCandidates.length === 0) {
      const baseTrip = generateMockItinerary(req);
      return annotateFallbackWithHotelWait(baseTrip, hotel, commuteMode, maxRadiusKm, baseWaitingMinutes);
    }

    rawCandidates.sort((a, b) => a.distanceFromHotelKm - b.distanceFromHotelKm);
    const nearbyPool = rawCandidates.filter((c) => !c.isFarFromHotel);
    const farawayPool = rawCandidates.filter((c) => c.isFarFromHotel);
    const orderedPool = [...nearbyPool, ...farawayPool];

    const usedPlaceIds = new Set<string>();
    const activities: Activity[] = [];
    const normalizedDayPlans: DayPlan[] = [];
    const targetDailyBudget =
      req.budget.daily || Math.round(req.budget.total / Math.max(1, req.daysCount));

    const foodFocus = req.generalNotes.some((n) => n.toLowerCase().includes('food'));
    const natureFocus = req.generalNotes.some((n) => n.toLowerCase().includes('nature'));

    for (let d = 1; d <= req.daysCount; d++) {
      const requestedPlan = req.dayPlans.find((p) => p.dayNumber === d);
      const pace: DayPace =
        requestedPlan?.pace ||
        (req.travelStyle === 'Adventure'
          ? 'Activity-heavy'
          : req.travelStyle === 'Relaxed'
          ? 'Relaxed'
          : d === 1
          ? 'Relaxed'
          : 'Balanced');

      const dayTitle =
        requestedPlan?.title ||
        (d === 1
          ? `Arrival near ${hotel.name}`
          : d === req.daysCount
          ? `Local Highlights & Departure`
          : `Around ${hotel.name} · Day ${d}`);

      normalizedDayPlans.push({
        dayNumber: d,
        title: dayTitle,
        pace,
        notes: requestedPlan?.notes || [],
      });

      const targetCount = pace === 'Relaxed' ? 3 : pace === 'Activity-heavy' ? 5 : 4;
      const pickedForDay: DiscoveredPlaceCandidate[] = [];

      for (let s = 0; s < targetCount; s++) {
        const wantFood = s === 0 || s === 2;
        const ranked = orderedPool
          .filter((c) => !usedPlaceIds.has(c.placeId))
          .map((c) => {
            let score = c.isFarFromHotel ? -50 : 25;
            score -= c.distanceFromHotelKm * 1.4;
            if (wantFood && c.category === 'Food') score += 10;
            if (!wantFood && c.category !== 'Food') score += 6;
            if (foodFocus && c.category === 'Food') score += 4;
            if (natureFocus && (c.category === 'Nature' || c.category === 'Leisure')) score += 4;
            return { c, score };
          })
          .sort((a, b) => b.score - a.score);

        const chosen = ranked[0]?.c;
        if (chosen) {
          usedPlaceIds.add(chosen.placeId);
          pickedForDay.push(chosen);
        } else if (orderedPool.length > 0) {
          const nearbyRecycle = orderedPool[(d * 3 + s) % Math.max(1, nearbyPool.length || orderedPool.length)];
          if (nearbyRecycle && !pickedForDay.some((p) => p.placeId === nearbyRecycle.placeId)) {
            pickedForDay.push(nearbyRecycle);
          }
        }
      }

      const clusteredDay = orderNearestNeighbor(hotel.location, pickedForDay);
      let cursorMin = 8 * 60 + 30;

      clusteredDay.forEach((stop, idx) => {
        let travelFromPrevMin = stop.travelFromHotelMinutes;
        if (idx > 0) {
          const prevLoc = clusteredDay[idx - 1].location;
          const hopKm = haversineDistanceKm(prevLoc, stop.location);
          travelFromPrevMin = estimateHeuristicTravelMinutes(hopKm, commuteMode);
        }

        const waitMin = getWaitingMinutesForCategory(stop.category, baseWaitingMinutes);
        const departureTime = minutesToTime(cursorMin);
        const arrivalAndStartMin = Math.min(22 * 60, cursorMin + travelFromPrevMin + waitMin);
        const startTime = minutesToTime(arrivalAndStartMin);
        const duration = Math.max(30, stop.durationMinutes);
        const endTime = addMinutesToTime(startTime, duration);
        cursorMin = Math.min(23 * 60, arrivalAndStartMin + duration);

        const cost = estimateCostForCategory(
          stop.category,
          req.adults,
          req.children,
          targetDailyBudget,
          clusteredDay.length
        );

        activities.push({
          id: uid('act'),
          title: stop.title,
          description: stop.description,
          category: stop.category,
          location: stop.address,
          imageUrl: stop.imageUrl,
          startTime,
          endTime,
          durationMinutes: duration,
          cost,
          day: d,
          isChildFriendly: true,
          crowdLevel: 'Moderate',
          placeId: stop.placeId,
          coordinates: stop.location,
          travelFromHotelMinutes: stop.travelFromHotelMinutes,
          travelFromPrevMinutes: travelFromPrevMin,
          waitingTimeMinutes: waitMin,
          distanceFromHotelKm: stop.distanceFromHotelKm,
          isFarFromHotel: stop.isFarFromHotel,
          departureFromHotelTime: idx === 0 ? departureTime : undefined,
        });
      });
    }

    const now = new Date().toISOString();
    return {
      id: uid('trip'),
      name: `${destLabel} ${req.daysCount}-Day Stay`,
      origin: req.origin.trim() || 'Bengaluru',
      destination: destLabel,
      daysCount: req.daysCount,
      adults: req.adults,
      children: req.children,
      budget: { ...req.budget },
      travelStyle: req.travelStyle,
      dayPlans: normalizedDayPlans,
      activities,
      generalNotes: req.generalNotes,
      stayMode: 'with-hotel',
      hotel,
      commuteMode,
      maxHotelRadiusKm: maxRadiusKm,
      waitingBufferMinutes: baseWaitingMinutes,
      createdAt: now,
      updatedAt: now,
    };
  } catch {
    const baseTrip = generateMockItinerary(req);
    return annotateFallbackWithHotelWait(baseTrip, hotel, commuteMode, maxRadiusKm, baseWaitingMinutes);
  }
}

/**
 * Fallback helper used when OSM/Photon discovery returns empty:
 * applies travel & waiting time buffers without inventing fake coordinates.
 */
function annotateFallbackWithHotelWait(
  trip: Trip,
  hotel: HotelInfo,
  commuteMode: CommuteMode,
  maxRadiusKm: number,
  baseWaitMinutes: number
): Trip {
  const updatedActs: Activity[] = [];

  for (let d = 1; d <= trip.daysCount; d++) {
    const dayActs = trip.activities.filter((a) => a.day === d);
    let cursorMin = 8 * 60 + 30;
    dayActs.forEach((act, idx) => {
      const estTravel = idx === 0 ? 15 : 12;
      const waitMin = getWaitingMinutesForCategory(act.category, baseWaitMinutes);
      const departureTime = minutesToTime(cursorMin);
      const startMin = Math.min(22 * 60, cursorMin + estTravel + waitMin);
      const startTime = minutesToTime(startMin);
      const endTime = addMinutesToTime(startTime, act.durationMinutes);
      cursorMin = Math.min(23 * 60, startMin + act.durationMinutes);

      updatedActs.push({
        ...act,
        startTime,
        endTime,
        travelFromHotelMinutes: estTravel,
        travelFromPrevMinutes: estTravel,
        waitingTimeMinutes: waitMin,
        departureFromHotelTime: idx === 0 ? departureTime : undefined,
      });
    });
  }

  return {
    ...trip,
    stayMode: 'with-hotel',
    hotel,
    commuteMode,
    maxHotelRadiusKm: maxRadiusKm,
    waitingBufferMinutes: baseWaitMinutes,
    activities: updatedActs,
  };
}

/**
 * Enriches an AI-generated itinerary anchored to a hotel using Photon/OSM lookup
 * and Haversine travel-time heuristics without inventing coordinates for unresolved stops.
 * Caps lookup bursts and halts immediately if public rate limits are hit.
 */
export async function enrichAiTripWithHotelMaps(trip: Trip): Promise<Trip> {
  if (trip.stayMode !== 'with-hotel' || !trip.hotel) {
    return trip;
  }

  const hotel = trip.hotel;
  const commuteMode: CommuteMode = trip.commuteMode || 'DRIVING';
  const maxRadiusKm = trip.maxHotelRadiusKm || 10;
  const baseWaitMinutes = trip.waitingBufferMinutes ?? 15;

  const resolvedActs: Activity[] = [];
  let lookupsPerformed = 0;
  let abortedForRateLimit = false;

  for (const act of trip.activities) {
    // Already has saved coordinates: preserve and recompute deterministic Haversine metrics
    if (act.coordinates) {
      const metrics = await computeHotelToPlaceMetrics(
        hotel.location,
        act.coordinates,
        commuteMode,
        maxRadiusKm
      );
      resolvedActs.push({
        ...act,
        distanceFromHotelKm: metrics.distanceKm,
        travelFromHotelMinutes: metrics.travelMinutes,
        travelFromPrevMinutes: act.travelFromPrevMinutes ?? metrics.travelMinutes,
        waitingTimeMinutes:
          act.waitingTimeMinutes ?? getWaitingMinutesForCategory(act.category, baseWaitMinutes),
        isFarFromHotel: metrics.isFarFromHotel,
      });
      continue;
    }

    if (abortedForRateLimit || lookupsPerformed >= 8 || isPhotonRateLimitCoolingDown()) {
      resolvedActs.push({
        ...act,
        waitingTimeMinutes:
          act.waitingTimeMinutes ?? getWaitingMinutesForCategory(act.category, baseWaitMinutes),
      });
      continue;
    }

    lookupsPerformed++;
    const res = await searchPlacesWithPhoton(`${act.title} ${trip.destination}`, {
      limit: 1,
      locationBias: hotel.location,
    });
    if (res.rateLimited || res.unavailable) {
      abortedForRateLimit = true;
    }

    const match = res.results[0];
    if (!match) {
      resolvedActs.push({
        ...act,
        waitingTimeMinutes:
          act.waitingTimeMinutes ?? getWaitingMinutesForCategory(act.category, baseWaitMinutes),
      });
      continue;
    }

    const metrics = await computeHotelToPlaceMetrics(
      hotel.location,
      match.location,
      commuteMode,
      maxRadiusKm
    );
    const waitMin = getWaitingMinutesForCategory(act.category, baseWaitMinutes);
    resolvedActs.push({
      ...act,
      placeId: match.placeId,
      location: match.formattedAddress || act.location,
      coordinates: match.location,
      distanceFromHotelKm: metrics.distanceKm,
      travelFromHotelMinutes: metrics.travelMinutes,
      travelFromPrevMinutes: metrics.travelMinutes,
      waitingTimeMinutes: waitMin,
      isFarFromHotel: metrics.isFarFromHotel,
    });
  }

  return {
    ...trip,
    activities: resolvedActs,
  };
}
