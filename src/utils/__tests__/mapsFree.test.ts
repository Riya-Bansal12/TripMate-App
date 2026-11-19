import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHeuristicTravelMinutes,
  formatCommuteLabel,
  getDestinationBiasCenter,
  haversineDistanceKm,
  OSM_TILE_URL,
  PHOTON_API_URL,
} from '../mapsConfig.ts';
import {
  isPhotonRateLimitCoolingDown,
  reverseGeocodeWithPhoton,
  searchPlacesWithPhoton,
} from '../photonService.ts';
import {
  computeHotelToPlaceMetrics,
  enrichAiTripWithHotelMaps,
  searchHotelsInDestination,
} from '../hotelItineraryService.ts';
import { Trip } from '../../types/trip.ts';

function mockFetchSequence(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('Zero-cost OSM / Photon / Haversine maps utilities', () => {
  test('uses OpenStreetMap tiles and Photon public endpoints (zero Google Maps URLs)', () => {
    assert.ok(OSM_TILE_URL.startsWith('https://tile.openstreetmap.org/'));
    assert.ok(PHOTON_API_URL.startsWith('https://photon.komoot.io/'));
    assert.equal(formatCommuteLabel('DRIVING'), 'Cab / Drive');
    assert.equal(formatCommuteLabel('WALKING'), 'Walk');
    assert.ok(getDestinationBiasCenter('Udaipur, Rajasthan'));
  });

  test('haversineDistanceKm and estimateHeuristicTravelMinutes compute deterministic estimates', async () => {
    const cityPalace = { lat: 24.5764, lng: 73.6835 };
    const fatehSagar = { lat: 24.6005, lng: 73.6716 };
    const farOutSpot = { lat: 24.75, lng: 73.85 };

    const shortKm = haversineDistanceKm(cityPalace, fatehSagar);
    assert.ok(shortKm > 2 && shortKm < 4, `Expected ~2.9 km, got ${shortKm}`);

    assert.equal(estimateHeuristicTravelMinutes(0, 'DRIVING'), 5);
    const walkMin = estimateHeuristicTravelMinutes(3, 'WALKING');
    const driveMin = estimateHeuristicTravelMinutes(3, 'DRIVING');
    assert.ok(walkMin > driveMin, 'Walking estimate must be slower than driving estimate');

    const nearMetrics = await computeHotelToPlaceMetrics(cityPalace, fatehSagar, 'DRIVING', 10);
    assert.equal(nearMetrics.isFarFromHotel, false);

    const farMetrics = await computeHotelToPlaceMetrics(cityPalace, farOutSpot, 'DRIVING', 10);
    assert.equal(farMetrics.isFarFromHotel, true);
  });

  test('searchPlacesWithPhoton maps GeoJSON features, passes locationBias & osm_tag, and caches queries', async () => {
    let calls = 0;
    let lastUrl = '';
    const restore = mockFetchSequence((url) => {
      calls++;
      lastUrl = url;
      return new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [73.6808, 24.5754] },
              properties: {
                osm_id: 123456,
                osm_type: 'N',
                osm_key: 'tourism',
                osm_value: 'hotel',
                name: 'Lakefront Heritage Stay',
                street: 'Lal Ghat Road',
                city: 'Udaipur',
                state: 'Rajasthan',
                country: 'India',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    try {
      const res1 = await searchPlacesWithPhoton('Lakefront Heritage', {
        limit: 5,
        locationBias: { lat: 24.5854, lng: 73.7125 },
        osmTags: ['tourism:hotel'],
      });
      assert.equal(res1.unavailable, false);
      assert.equal(res1.rateLimited, false);
      assert.equal(res1.results.length, 1);
      assert.equal(res1.results[0].placeId, 'osm:N123456');
      assert.deepEqual(res1.results[0].location, { lat: 24.5754, lng: 73.6808 });
      assert.ok(lastUrl.includes('lat=24.5854'));
      assert.ok(lastUrl.includes('lon=73.7125'));
      assert.ok(lastUrl.includes('osm_tag=tourism%3Ahotel'));
      assert.equal(calls, 1);

      // Identical parameters hit the in-memory cache
      const res2 = await searchPlacesWithPhoton('Lakefront Heritage', {
        limit: 5,
        locationBias: { lat: 24.5854, lng: 73.7125 },
        osmTags: ['tourism:hotel'],
      });
      assert.equal(calls, 1);
      assert.equal(res2.results.length, 1);
    } finally {
      restore();
    }
  });

  test('searchPlacesWithPhoton and reverseGeocodeWithPhoton fail gracefully without fake coords on error', async () => {
    const restore = mockFetchSequence(() => {
      throw new Error('Network offline');
    });

    try {
      const searchRes = await searchPlacesWithPhoton('Offline Query Place');
      assert.equal(searchRes.unavailable, true);
      assert.equal(searchRes.rateLimited, false);
      assert.equal(searchRes.results.length, 0);
      assert.ok(searchRes.errorMessage);

      const reverseRes = await reverseGeocodeWithPhoton({ lat: 24.58, lng: 73.68 });
      assert.equal(reverseRes, null);
    } finally {
      restore();
    }
  });

  test('searchHotelsInDestination falls back to text hotel query when tagged lodging is empty', async () => {
    const seenUrls: string[] = [];
    const restore = mockFetchSequence((url) => {
      seenUrls.push(url);
      if (url.includes('osm_tag=')) {
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [73.681, 24.579] },
              properties: {
                osm_id: 9988,
                osm_type: 'W',
                name: 'Jagdish Haveli',
                city: 'Udaipur',
              },
            },
          ],
        }),
        { status: 200 }
      );
    });

    try {
      const res = await searchHotelsInDestination('Udaipur FallbackTest', { lat: 24.5854, lng: 73.7125 });
      assert.equal(seenUrls.length, 2);
      assert.equal(res.hotels.length, 1);
      assert.equal(res.hotels[0].name, 'Jagdish Haveli');
    } finally {
      restore();
    }
  });

  test('enrichAiTripWithHotelMaps recomputes existing coordinates via Haversine without external calls', async () => {
    let fetchCalled = false;
    const restore = mockFetchSequence(() => {
      fetchCalled = true;
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });

    const sampleTrip: Trip = {
      id: 'trip-1',
      name: 'Udaipur Stay',
      origin: 'Bengaluru',
      destination: 'Udaipur',
      daysCount: 1,
      adults: 2,
      children: 0,
      budget: { total: 15000, daily: 15000, food: 4000, transport: 3000, attraction: 8000 },
      travelStyle: 'Balanced',
      dayPlans: [{ dayNumber: 1, title: 'Day 1', pace: 'Balanced', notes: [] }],
      generalNotes: [],
      stayMode: 'with-hotel',
      hotel: {
        name: 'Hotel Lake',
        formattedAddress: 'Udaipur',
        location: { lat: 24.5764, lng: 73.6835 },
      },
      commuteMode: 'DRIVING',
      maxHotelRadiusKm: 10,
      waitingBufferMinutes: 15,
      activities: [
        {
          id: 'act-1',
          title: 'Fateh Sagar',
          description: 'Lake walk',
          category: 'Nature',
          location: 'Udaipur',
          imageUrl: '',
          startTime: '09:00',
          endTime: '10:30',
          durationMinutes: 90,
          cost: 200,
          day: 1,
          coordinates: { lat: 24.6005, lng: 73.6716 },
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    try {
      const enriched = await enrichAiTripWithHotelMaps(sampleTrip);
      assert.equal(fetchCalled, false, 'Should not call Photon for activities already holding coordinates');
      assert.ok(typeof enriched.activities[0].distanceFromHotelKm === 'number');
      assert.ok(typeof enriched.activities[0].travelFromHotelMinutes === 'number');
      assert.equal(enriched.activities[0].isFarFromHotel, false);
    } finally {
      restore();
    }
  });

  // Keep 429 cooldown test last since cooldown persists for 30s in module state
  test('searchPlacesWithPhoton enforces 30s cooldown after HTTP 429 rate-limit response', async () => {
    let calls = 0;
    const restore = mockFetchSequence(() => {
      calls++;
      return new Response('Too Many Requests', { status: 429 });
    });

    try {
      const first = await searchPlacesWithPhoton('Rate Limit Probe Alpha');
      assert.equal(first.rateLimited, true);
      assert.equal(first.unavailable, true);
      assert.equal(first.results.length, 0);
      assert.equal(isPhotonRateLimitCoolingDown(), true);
      assert.equal(calls, 1);

      const second = await searchPlacesWithPhoton('Rate Limit Probe Beta');
      assert.equal(second.rateLimited, true);
      assert.equal(calls, 1, 'Subsequent query during cooldown must not hit fetch');
    } finally {
      restore();
    }
  });
});
