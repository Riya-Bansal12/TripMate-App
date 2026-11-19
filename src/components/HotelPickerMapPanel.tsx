import React, { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { Building2, Car, Footprints, Loader2, MapPin, Navigation, Search, TrainFront } from 'lucide-react';
import { CommuteMode, GeoPoint, HotelInfo } from '../types/trip';
import { HotelSearchCandidate, searchHotelsInDestination } from '../utils/hotelItineraryService';
import { getDestinationBiasCenter, OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from '../utils/mapsConfig';
import { PlaceAutocompleteInput } from './PlaceAutocompleteInput';

interface HotelPickerMapPanelProps {
  destination: string;
  hotel: HotelInfo | null;
  onSelectHotel: (hotel: HotelInfo) => void;
  commuteMode: CommuteMode;
  onChangeCommuteMode: (mode: CommuteMode) => void;
  maxHotelRadiusKm: number;
  onChangeMaxRadiusKm: (km: number) => void;
  waitingBufferMinutes: number;
  onChangeWaitingBufferMinutes: (mins: number) => void;
}

const COMMUTE_OPTIONS: { id: CommuteMode; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'DRIVING', label: 'Cab / Drive', icon: Car },
  { id: 'TRANSIT', label: 'Public Transit', icon: TrainFront },
  { id: 'WALKING', label: 'Walking', icon: Footprints },
  { id: 'TWO_WHEELER', label: 'Two-Wheeler', icon: Navigation },
];

function createHotelPinIcon(): L.DivIcon {
  return L.divIcon({
    className: 'tripmate-hotel-pin',
    html: `<div style="width:30px;height:30px;border-radius:9999px;background:#174B3A;border:2.5px solid #ffffff;color:#D8AC55;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;box-shadow:0 3px 8px rgba(0,0,0,0.3);">H</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

const MapRecenterEffect: React.FC<{ center: GeoPoint; zoom: number }> = ({ center, zoom }) => {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng], zoom, { animate: true });
  }, [map, center.lat, center.lng, zoom]);
  return null;
};

const MapClickPinHandler: React.FC<{
  onPinCoordinates: (coords: GeoPoint) => void;
}> = ({ onPinCoordinates }) => {
  useMapEvents({
    click(e) {
      onPinCoordinates({
        lat: Math.round(e.latlng.lat * 100000) / 100000,
        lng: Math.round(e.latlng.lng * 100000) / 100000,
      });
    },
  });
  return null;
};

export const HotelPickerMapPanel: React.FC<HotelPickerMapPanelProps> = ({
  destination,
  hotel,
  onSelectHotel,
  commuteMode,
  onChangeCommuteMode,
  maxHotelRadiusKm,
  onChangeMaxRadiusKm,
  waitingBufferMinutes,
  onChangeWaitingBufferMinutes,
}) => {
  const [hotelQuery, setHotelQuery] = useState(hotel?.name || '');
  const [manualAddress, setManualAddress] = useState(hotel?.formattedAddress || '');
  const [suggestedHotels, setSuggestedHotels] = useState<HotelSearchCandidate[]>([]);
  const [searchingHotels, setSearchingHotels] = useState(false);
  const [hotelSearchNotice, setHotelSearchNotice] = useState<string | null>(null);
  const [tileLoadError, setTileLoadError] = useState(false);

  const biasCenter = getDestinationBiasCenter(destination);
  const mapCenter = hotel?.location || biasCenter || { lat: 24.5854, lng: 73.7125 };
  const hotelPinIcon = useMemo(() => createHotelPinIcon(), []);

  useEffect(() => {
    if (hotel?.name && hotel.name !== hotelQuery) {
      setHotelQuery(hotel.name);
    }
    if (hotel?.formattedAddress && hotel.formattedAddress !== manualAddress) {
      setManualAddress(hotel.formattedAddress);
    }
  }, [hotel?.name, hotel?.formattedAddress]);

  const handleFindDestinationHotels = async () => {
    if (!destination.trim()) return;
    setSearchingHotels(true);
    setHotelSearchNotice(null);
    const res = await searchHotelsInDestination(destination, biasCenter);
    setSuggestedHotels(res.hotels);
    if (res.errorMessage) {
      setHotelSearchNotice(res.errorMessage);
    } else if (res.hotels.length === 0) {
      setHotelSearchNotice(
        `No lodging entries returned for "${destination}" from OpenStreetMap. Type your hotel details below or click the map to pin it.`
      );
    }
    setSearchingHotels(false);
  };

  const handlePinOnMap = (coords: GeoPoint) => {
    const cleanName = hotelQuery.trim() || `Pinned Stay in ${destination || 'Destination'}`;
    const cleanAddr =
      manualAddress.trim() || `${cleanName} (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
    setHotelQuery(cleanName);
    setManualAddress(cleanAddr);
    onSelectHotel({
      name: cleanName,
      formattedAddress: cleanAddr,
      location: coords,
    });
  };

  const handleApplyManualHotel = () => {
    const cleanName = hotelQuery.trim();
    if (!cleanName) return;
    const coords = hotel?.location || biasCenter;
    if (!coords) {
      setHotelSearchNotice(
        'Please select a Photon suggestion or click anywhere on the map to set the stay coordinates.'
      );
      return;
    }
    const cleanAddr =
      manualAddress.trim() || `${cleanName}${destination ? `, ${destination}` : ''}`;
    onSelectHotel({
      name: cleanName,
      formattedAddress: cleanAddr,
      placeId: hotel?.placeId,
      location: coords,
    });
    setHotelSearchNotice(null);
  };

  return (
    <div className="rounded-2xl border border-[#174B3A]/20 bg-[#F8F5EC]/65 p-5 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[#174B3A] flex items-center gap-1.5">
            <Building2 className="w-4 h-4" />
            <span>Hotel-Anchored Itinerary Settings</span>
          </div>
          <p className="text-xs text-[#5A645F] mt-0.5">
            Search OpenStreetMap lodging or click the map to set your stay in {destination || 'your destination'}. Travel times use straight-line distance heuristics and your waiting buffer.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleFindDestinationHotels()}
          disabled={searchingHotels || !destination.trim()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-[#252B28]/15 text-xs font-semibold text-[#174B3A] hover:bg-[#FCFBF7] transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
        >
          {searchingHotels ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Search className="w-3.5 h-3.5" />
          )}
          <span>Browse OSM Hotels in {destination || 'City'}</span>
        </button>
      </div>

      {/* Hotel Autocomplete & Manual Entry */}
      <div className="space-y-2.5">
        <label className="block text-xs font-semibold text-[#252B28]">
          Search or Enter Your Hotel Name
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <PlaceAutocompleteInput
              value={hotelQuery}
              onChangeText={(txt) => {
                setHotelQuery(txt);
              }}
              includedPrimaryTypes={['lodging']}
              locationBias={biasCenter}
              placeholder={`Search hotel in ${destination || 'destination'} (e.g., Taj Lake Palace, Zostel...)`}
              onSelectPlace={(place) => {
                setHotelSearchNotice(null);
                setManualAddress(place.formattedAddress);
                onSelectHotel({
                  name: place.name,
                  formattedAddress: place.formattedAddress,
                  placeId: place.placeId,
                  location: place.location,
                });
              }}
            />
          </div>
          {hotelQuery.trim().length >= 2 && (hotel?.location || biasCenter) && (
            <button
              type="button"
              onClick={handleApplyManualHotel}
              className="px-3.5 py-2.5 rounded-xl bg-white border border-[#174B3A]/25 text-xs font-semibold text-[#174B3A] hover:bg-[#FCFBF7] whitespace-nowrap self-start"
            >
              Use Typed Hotel
            </button>
          )}
        </div>

        <div>
          <input
            type="text"
            value={manualAddress}
            onChange={(e) => setManualAddress(e.target.value)}
            placeholder="Optional street / neighborhood address (manual override)"
            className="w-full px-3.5 py-2 rounded-xl border border-[#252B28]/12 bg-white text-xs text-[#252B28] focus:outline-none focus:border-[#174B3A]"
          />
        </div>
      </div>

      {hotelSearchNotice && (
        <div className="px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
          {hotelSearchNotice}
        </div>
      )}

      {/* Suggested Hotel Quick Picks from OpenStreetMap / Photon */}
      {suggestedHotels.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-[#5A645F] mb-2">
            Lodging places found in {destination} via OpenStreetMap — click to select
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {suggestedHotels.map((cand) => {
              const isSelected = hotel?.placeId === cand.id || hotel?.name === cand.name;
              return (
                <button
                  key={cand.id}
                  type="button"
                  onClick={() => {
                    setHotelQuery(cand.name);
                    setManualAddress(cand.formattedAddress);
                    onSelectHotel({
                      name: cand.name,
                      formattedAddress: cand.formattedAddress,
                      placeId: cand.id,
                      location: cand.location,
                    });
                  }}
                  className={`p-3 rounded-xl border text-left transition-colors ${
                    isSelected
                      ? 'bg-[#174B3A] border-[#174B3A] text-white'
                      : 'bg-white border-[#252B28]/12 hover:border-[#174B3A]/45 text-[#252B28]'
                  }`}
                >
                  <div className="text-xs font-semibold line-clamp-1">{cand.name}</div>
                  <div
                    className={`mt-1 text-[11px] line-clamp-1 ${
                      isSelected ? 'text-white/80' : 'text-[#5A645F]'
                    }`}
                  >
                    {cand.formattedAddress}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected Hotel Summary */}
      {hotel && (
        <div className="bg-white rounded-xl border border-[#174B3A]/25 p-3.5 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#D8AC55]/25 text-[#174B3A] flex items-center justify-center shrink-0">
            <MapPin className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[#252B28]">{hotel.name}</div>
            <div className="text-xs text-[#5A645F] truncate">{hotel.formattedAddress}</div>
            <div className="text-[11px] font-mono text-[#5A645F] mt-0.5">
              Pin: {hotel.location.lat.toFixed(4)}, {hotel.location.lng.toFixed(4)}
            </div>
          </div>
        </div>
      )}

      {/* Interactive Leaflet Map Preview */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-[#5A645F]">
          <span>Click anywhere on the map to pin or adjust your hotel location manually.</span>
          {tileLoadError && (
            <span className="text-amber-700 font-medium">
              Map tiles temporarily unavailable — pin &amp; search still work.
            </span>
          )}
        </div>
        <div className="rounded-xl overflow-hidden border border-[#252B28]/12 h-[260px] w-full bg-[#EFECE3] relative z-0">
          <MapContainer
            center={[mapCenter.lat, mapCenter.lng]}
            zoom={hotel ? 14 : 12}
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
            <MapRecenterEffect center={mapCenter} zoom={hotel ? 14 : 12} />
            <MapClickPinHandler onPinCoordinates={handlePinOnMap} />
            {hotel && (
              <Marker position={[hotel.location.lat, hotel.location.lng]} icon={hotelPinIcon}>
                <Popup>
                  <div className="max-w-[210px]">
                    <div className="text-xs font-semibold text-[#252B28]">{hotel.name}</div>
                    <div className="text-[11px] text-[#5A645F] mt-0.5">{hotel.formattedAddress}</div>
                  </div>
                </Popup>
              </Marker>
            )}
          </MapContainer>
        </div>
      </div>

      {/* Commute Mode, Proximity Radius & Waiting Buffer Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
        <div>
          <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
            Commute Mode from Hotel
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {COMMUTE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = commuteMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChangeCommuteMode(opt.id)}
                  className={`px-2.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1.5 transition-colors ${
                    active
                      ? 'bg-[#174B3A] border-[#174B3A] text-white'
                      : 'bg-white border-[#252B28]/12 text-[#252B28] hover:border-[#174B3A]/40'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
            Avoid Spots Farther Than
          </label>
          <select
            value={maxHotelRadiusKm}
            onChange={(e) => onChangeMaxRadiusKm(Number(e.target.value))}
            className="w-full px-3 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-xs font-medium text-[#252B28] focus:outline-none focus:border-[#174B3A]"
          >
            <option value={5}>5 km (Ultra-local around hotel)</option>
            <option value={10}>10 km (Recommended balanced zone)</option>
            <option value={18}>18 km (Wider city highlights)</option>
            <option value={30}>30 km (Day-trip range)</option>
          </select>
          <p className="mt-1 text-[11px] text-[#5A645F]">
            Spots beyond {maxHotelRadiusKm} km (straight-line) are flagged.
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
            Entry / Waiting Time Buffer
          </label>
          <select
            value={waitingBufferMinutes}
            onChange={(e) => onChangeWaitingBufferMinutes(Number(e.target.value))}
            className="w-full px-3 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-xs font-medium text-[#252B28] focus:outline-none focus:border-[#174B3A]"
          >
            <option value={10}>+10 min (Fast check-in / light queues)</option>
            <option value={15}>+15 min (Standard ticket & wait buffer)</option>
            <option value={25}>+25 min (Peak season / unhurried wait)</option>
          </select>
          <p className="mt-1 text-[11px] text-[#5A645F]">
            Added on top of estimated travel time before each activity starts.
          </p>
        </div>
      </div>
    </div>
  );
};
