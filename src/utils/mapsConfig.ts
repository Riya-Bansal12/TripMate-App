import { CommuteMode, GeoPoint } from '../types/trip';

/**
 * Explicit free-only external map & geocoding endpoints (zero API keys, zero billing).
 * These are community-operated public services subject to fair-use rate limits;
 * callers must debounce requests, cache results, display attribution, and fail gracefully.
 */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
export const PHOTON_API_URL = 'https://photon.komoot.io/api/';
export const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';

export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return Math.round(R * c * 10) / 10;
}

/**
 * Estimates travel duration purely as a straight-line Haversine heuristic
 * (incorporating an urban detour factor and mode-typical speed).
 * Always display these values as estimates, never as live road routing.
 */
export function estimateHeuristicTravelMinutes(
  straightLineKm: number,
  commuteMode: CommuteMode = 'DRIVING'
): number {
  if (!Number.isFinite(straightLineKm) || straightLineKm <= 0) return 5;
  const urbanDetourFactor = commuteMode === 'WALKING' ? 1.2 : 1.3;
  const effectiveKm = straightLineKm * urbanDetourFactor;

  switch (commuteMode) {
    case 'WALKING':
      return Math.max(5, Math.round((effectiveKm / 4.5) * 60));
    case 'TRANSIT':
      return Math.max(8, Math.round((effectiveKm / 18) * 60) + 5);
    case 'TWO_WHEELER':
      return Math.max(5, Math.round((effectiveKm / 24) * 60));
    case 'DRIVING':
    default:
      return Math.max(5, Math.round((effectiveKm / 22) * 60));
  }
}

/**
 * Coarse city-center bias coordinates purely used as locationBias hints
 * for Photon search and initial map viewport before a hotel is selected.
 */
export const DESTINATION_SEARCH_BIAS: Record<string, GeoPoint> = {
  udaipur: { lat: 24.5854, lng: 73.7125 },
  jaipur: { lat: 26.9124, lng: 75.7873 },
  goa: { lat: 15.2993, lng: 74.124 },
  manali: { lat: 32.2432, lng: 77.1892 },
  kerala: { lat: 9.9312, lng: 76.2673 },
  delhi: { lat: 28.6139, lng: 77.209 },
  mumbai: { lat: 19.076, lng: 72.8777 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
};

export function getDestinationBiasCenter(destinationName: string): GeoPoint | undefined {
  const lower = destinationName.trim().toLowerCase();
  for (const [key, coords] of Object.entries(DESTINATION_SEARCH_BIAS)) {
    if (lower.includes(key)) return coords;
  }
  return undefined;
}

export function formatCommuteLabel(mode: CommuteMode): string {
  switch (mode) {
    case 'WALKING':
      return 'Walk';
    case 'TRANSIT':
      return 'Transit';
    case 'TWO_WHEELER':
      return 'Two-Wheeler';
    case 'DRIVING':
    default:
      return 'Cab / Drive';
  }
}
