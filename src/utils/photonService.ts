import { GeoPoint } from '../types/trip';
import { PHOTON_API_URL, PHOTON_REVERSE_URL } from './mapsConfig';

export interface PhotonPlaceCandidate {
  placeId: string;
  name: string;
  formattedAddress: string;
  city?: string;
  location: GeoPoint;
  osmKey?: string;
  osmValue?: string;
}

export interface PhotonSearchResponse {
  results: PhotonPlaceCandidate[];
  rateLimited: boolean;
  unavailable: boolean;
  errorMessage?: string;
}

interface PhotonFeatureProperties {
  osm_id?: number;
  osm_type?: string;
  osm_key?: string;
  osm_value?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  district?: string;
  locality?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
}

interface PhotonFeature {
  type?: string;
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
  properties?: PhotonFeatureProperties;
}

interface CacheEntry {
  results: PhotonPlaceCandidate[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 80;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

const searchCache = new Map<string, CacheEntry>();
let rateLimitedUntilMs = 0;

export function isPhotonRateLimitCoolingDown(): boolean {
  return Date.now() < rateLimitedUntilMs;
}

function buildFormattedAddress(props: PhotonFeatureProperties): string {
  const streetLine = [props.housenumber, props.street].filter(Boolean).join(' ').trim();
  const parts = [
    props.name,
    streetLine,
    props.locality || props.district,
    props.city || props.town || props.village || props.county,
    props.state,
    props.country,
  ]
    .map((p) => (p ? p.trim() : ''))
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const k = part.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(part);
    }
  }
  return unique.join(', ');
}

function mapFeatureToCandidate(feature: PhotonFeature): PhotonPlaceCandidate | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const props = feature.properties || {};
  const formattedAddress = buildFormattedAddress(props) || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const city =
    props.city || props.town || props.village || props.county || props.state || undefined;
  const name =
    (props.name && props.name.trim()) ||
    [props.street, city].filter(Boolean).join(', ') ||
    formattedAddress;
  const osmType = props.osm_type || 'N';
  const osmId = props.osm_id != null ? String(props.osm_id) : `${lat.toFixed(5)},${lng.toFixed(5)}`;

  return {
    placeId: `osm:${osmType}${osmId}`,
    name,
    formattedAddress,
    city,
    location: { lat, lng },
    osmKey: props.osm_key,
    osmValue: props.osm_value,
  };
}

export interface SearchPhotonOptions {
  limit?: number;
  locationBias?: GeoPoint;
  osmTags?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function searchPlacesWithPhoton(
  query: string,
  options: SearchPhotonOptions = {}
): Promise<PhotonSearchResponse> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { results: [], rateLimited: false, unavailable: false };
  }

  const limit = Math.max(1, Math.min(15, options.limit ?? 6));
  const biasKey = options.locationBias
    ? `${options.locationBias.lat.toFixed(2)},${options.locationBias.lng.toFixed(2)}`
    : 'none';
  const tagsKey = options.osmTags?.length ? options.osmTags.join('|') : 'all';
  const cacheKey = `${trimmed.toLowerCase()}::${limit}::${biasKey}::${tagsKey}`;

  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { results: cached.results, rateLimited: false, unavailable: false };
  }

  if (isPhotonRateLimitCoolingDown()) {
    return {
      results: [],
      rateLimited: true,
      unavailable: true,
      errorMessage: 'Location search is cooling down due to public rate limits. You can type your address manually.',
    };
  }

  const params = new URLSearchParams({
    q: trimmed,
    limit: String(limit),
    lang: 'en',
  });
  if (options.locationBias) {
    params.set('lat', String(options.locationBias.lat));
    params.set('lon', String(options.locationBias.lng));
  }
  if (options.osmTags) {
    for (const tag of options.osmTags) {
      params.append('osm_tag', tag);
    }
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 6500;
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      globalThis.clearTimeout(timeoutId);
      return { results: [], rateLimited: false, unavailable: false };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(`${PHOTON_API_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (res.status === 429) {
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return {
        results: [],
        rateLimited: true,
        unavailable: true,
        errorMessage: 'Public search rate limit reached. Please pause briefly or type manually.',
      };
    }

    if (!res.ok) {
      return {
        results: [],
        rateLimited: false,
        unavailable: true,
        errorMessage: 'Location search is temporarily unavailable. Manual entry still works.',
      };
    }

    const data = (await res.json()) as { features?: PhotonFeature[] };
    const features = Array.isArray(data?.features) ? data.features : [];
    const results = features
      .map(mapFeatureToCandidate)
      .filter((item): item is PhotonPlaceCandidate => item !== null);

    if (searchCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey) searchCache.delete(oldestKey);
    }
    searchCache.set(cacheKey, {
      results,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return { results, rateLimited: false, unavailable: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { results: [], rateLimited: false, unavailable: false };
    }
    return {
      results: [],
      rateLimited: false,
      unavailable: true,
      errorMessage: 'Unable to reach location search. You can enter an address manually.',
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function reverseGeocodeWithPhoton(
  coords: GeoPoint
): Promise<PhotonPlaceCandidate | null> {
  if (isPhotonRateLimitCoolingDown()) return null;

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 6000);

  try {
    const params = new URLSearchParams({
      lat: String(coords.lat),
      lon: String(coords.lng),
      lang: 'en',
    });
    const res = await fetch(`${PHOTON_REVERSE_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 429) {
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return null;
    }
    if (!res.ok) return null;

    const data = (await res.json()) as { features?: PhotonFeature[] };
    const first = Array.isArray(data?.features) ? data.features[0] : undefined;
    if (!first) return null;
    return mapFeatureToCandidate(first);
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
