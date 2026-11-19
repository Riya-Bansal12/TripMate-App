import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import { AlertTriangle, Building2, Clock, Navigation, Route as RouteIcon } from 'lucide-react';
import { Activity, CommuteMode, GeoPoint, HotelInfo } from '../types/trip';
import {
  estimateHeuristicTravelMinutes,
  formatCommuteLabel,
  haversineDistanceKm,
  OSM_TILE_ATTRIBUTION,
  OSM_TILE_URL,
} from '../utils/mapsConfig';
import { formatDuration } from '../utils/scheduleUtils';

interface TripMapOverviewProps {
  dayNumber: number;
  hotel?: HotelInfo | null;
  activities: Activity[];
  commuteMode?: CommuteMode;
  maxHotelRadiusKm?: number;
}

function createPinIcon(label: string, variant: 'hotel' | 'normal' | 'far'): L.DivIcon {
  const bg =
    variant === 'hotel' ? '#D8AC55' : variant === 'far' ? '#C2410C' : '#174B3A';
  const border = variant === 'hotel' ? '#174B3A' : '#FFFFFF';
  const color = variant === 'hotel' ? '#174B3A' : '#FFFFFF';

  return L.divIcon({
    className: 'tripmate-map-pin',
    html: `<div style="width:28px;height:28px;border-radius:9999px;background:${bg};border:2px solid ${border};color:${color};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

const FitBoundsEffect: React.FC<{ points: GeoPoint[] }> = ({ points }) => {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [42, 42], maxZoom: 15 });
  }, [map, points]);

  return null;
};

export const TripMapOverview: React.FC<TripMapOverviewProps> = ({
  dayNumber,
  hotel,
  activities,
  commuteMode = 'DRIVING',
  maxHotelRadiusKm = 10,
}) => {
  const [tileLoadError, setTileLoadError] = useState(false);

  const mappedActivities = useMemo(
    () => activities.filter((a) => Boolean(a.coordinates)),
    [activities]
  );

  const waypoints = useMemo<GeoPoint[]>(() => {
    const pts = mappedActivities.map((a) => a.coordinates as GeoPoint);
    return hotel ? [hotel.location, ...pts] : pts;
  }, [hotel, mappedActivities]);

  const polylinePositions = useMemo<[number, number][]>(
    () => waypoints.map((pt) => [pt.lat, pt.lng]),
    [waypoints]
  );

  const straightLineSummary = useMemo(() => {
    if (waypoints.length < 2) return null;
    let totalKm = 0;
    let totalMin = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const legKm = haversineDistanceKm(waypoints[i - 1], waypoints[i]);
      totalKm += legKm;
      totalMin += estimateHeuristicTravelMinutes(legKm, commuteMode);
    }
    return {
      distanceKm: Math.round(totalKm * 10) / 10,
      durationMin: totalMin,
    };
  }, [waypoints, commuteMode]);

  const initialCenter: GeoPoint =
    hotel?.location ||
    mappedActivities[0]?.coordinates || { lat: 24.5854, lng: 73.7125 };

  const totalDayTravel = activities.reduce(
    (s, a, idx) =>
      s +
      (idx === 0
        ? a.travelFromPrevMinutes ?? a.travelFromHotelMinutes ?? 0
        : a.travelFromPrevMinutes ?? 0),
    0
  );
  const totalDayWait = activities.reduce((s, a) => s + (a.waitingTimeMinutes || 0), 0);
  const farCount = activities.filter((a) => a.isFarFromHotel).length;
  const hotelIcon = useMemo(() => createPinIcon('H', 'hotel'), []);

  return (
    <section className="bg-white rounded-2xl border border-[#252B28]/10 overflow-hidden">
      <div className="px-5 py-4 bg-[#F8F5EC] border-b border-[#252B28]/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <RouteIcon className="w-4 h-4 text-[#174B3A] mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-[#252B28]">
              Day {dayNumber} Stops &amp; Estimated Proximity Map
            </div>
            <div className="text-xs text-[#5A645F] mt-0.5 flex flex-wrap items-center gap-3">
              {hotel && (
                <span className="inline-flex items-center gap-1 font-medium text-[#174B3A]">
                  <Building2 className="w-3.5 h-3.5" />
                  Stay: {hotel.name}
                </span>
              )}
              <span>Mode: {formatCommuteLabel(commuteMode)}</span>
              <span>Radius guard: {maxHotelRadiusKm} km</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
          {straightLineSummary && (
            <div
              className="inline-flex items-center gap-1.5 text-[#174B3A] font-semibold"
              title="Calculated via Haversine straight-line formula — actual road distances may differ"
            >
              <Navigation className="w-3.5 h-3.5" />
              <span>
                {straightLineSummary.distanceKm} km straight-line · ~
                {formatDuration(straightLineSummary.durationMin)} est.
              </span>
            </div>
          )}
          {totalDayTravel > 0 && (
            <div className="text-[#252B28]">
              Est. commute: <span className="font-semibold">~{formatDuration(totalDayTravel)}</span>
            </div>
          )}
          {totalDayWait > 0 && (
            <div className="inline-flex items-center gap-1 text-[#5A645F]">
              <Clock className="w-3.5 h-3.5" />
              <span>Wait buffers: {formatDuration(totalDayWait)}</span>
            </div>
          )}
        </div>
      </div>

      {farCount > 0 && (
        <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
          <span>
            {farCount} stop{farCount > 1 ? 's' : ''} on Day {dayNumber}{' '}
            {farCount > 1 ? 'are' : 'is'} outside your {maxHotelRadiusKm} km straight-line radius
            from {hotel?.name || 'your hotel'}. Consider swapping for a closer alternative.
          </span>
        </div>
      )}

      {waypoints.length > 0 ? (
        <div className="relative w-full h-[340px] bg-[#EFECE3] z-0">
          {tileLoadError && (
            <div className="absolute top-2.5 left-2.5 right-2.5 z-[500] px-3 py-2 rounded-lg bg-amber-50/95 border border-amber-200 text-[11px] text-amber-900 shadow-sm">
              OpenStreetMap background tiles are temporarily unavailable or rate-limited. Markers and straight-line distance estimates remain accurate.
            </div>
          )}
          <MapContainer
            center={[initialCenter.lat, initialCenter.lng]}
            zoom={13}
            scrollWheelZoom={false}
            className="w-full h-full"
          >
            <TileLayer
              url={OSM_TILE_URL}
              attribution={OSM_TILE_ATTRIBUTION}
              eventHandlers={{
                tileerror: () => setTileLoadError(true),
              }}
            />
            <FitBoundsEffect points={waypoints} />

            {polylinePositions.length >= 2 && (
              <Polyline
                positions={polylinePositions}
                pathOptions={{
                  color: '#174B3A',
                  weight: 3,
                  opacity: 0.8,
                  dashArray: '8, 8',
                }}
              />
            )}

            {hotel && (
              <Marker position={[hotel.location.lat, hotel.location.lng]} icon={hotelIcon}>
                <Popup>
                  <div className="max-w-[220px]">
                    <div className="text-[11px] font-semibold text-[#174B3A]">
                      Your Selected Hotel
                    </div>
                    <div className="text-xs font-semibold text-[#252B28] mt-0.5">
                      {hotel.name}
                    </div>
                    <div className="text-[11px] text-[#5A645F] mt-0.5">
                      {hotel.formattedAddress}
                    </div>
                  </div>
                </Popup>
              </Marker>
            )}

            {mappedActivities.map((act, idx) => (
              <Marker
                key={act.id}
                position={[act.coordinates!.lat, act.coordinates!.lng]}
                icon={createPinIcon(String(idx + 1), act.isFarFromHotel ? 'far' : 'normal')}
              >
                <Popup>
                  <div className="max-w-[230px]">
                    <div className="text-xs font-semibold text-[#252B28]">
                      {idx + 1}. {act.title}
                    </div>
                    <div className="text-[11px] text-[#5A645F] mt-0.5">
                      {act.startTime} – {act.endTime} · {act.location}
                    </div>
                    {(act.distanceFromHotelKm !== undefined ||
                      act.travelFromHotelMinutes !== undefined) && (
                      <div className="mt-1 text-[11px] font-mono text-[#174B3A]">
                        {act.distanceFromHotelKm !== undefined
                          ? `${act.distanceFromHotelKm} km straight-line`
                          : ''}
                        {act.travelFromHotelMinutes !== undefined
                          ? ` · ~${act.travelFromHotelMinutes}m est.`
                          : ''}
                        {act.waitingTimeMinutes !== undefined
                          ? ` · +${act.waitingTimeMinutes}m wait`
                          : ''}
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      ) : (
        <div className="p-6 text-center text-xs text-[#5A645F]">
          No saved map coordinates for Day {dayNumber} stops yet. Use location search or edit a stop to add coordinates for map visualization.
        </div>
      )}

      <div className="px-5 py-2 bg-[#FCFBF7] border-t border-[#252B28]/8 text-[11px] text-[#5A645F] flex flex-wrap items-center justify-between gap-2">
        <span>
          Dashed lines show straight-line Haversine paths and estimated travel durations (not live road routing).
        </span>
        <span>Map tiles &copy; OpenStreetMap contributors</span>
      </div>
    </section>
  );
};
