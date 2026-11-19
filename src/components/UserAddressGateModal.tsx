import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, Compass, Loader2, LocateFixed, MapPin, X } from 'lucide-react';
import { useTripContext } from '../context/TripContext';
import { GeoPoint } from '../types/trip';
import { reverseGeocodeWithPhoton } from '../utils/photonService';
import { PlaceAutocompleteInput, SelectedPlaceResult } from './PlaceAutocompleteInput';

export const UserAddressGateModal: React.FC = () => {
  const location = useLocation();
  const {
    userAddress,
    isAddressModalOpen,
    saveUserAddress,
    dismissAddressPrompt,
  } = useTripContext();

  const [addressText, setAddressText] = useState(userAddress?.formattedAddress || '');
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlaceResult | null>(
    userAddress?.location
      ? {
          placeId: userAddress.placeId || '',
          name: userAddress.label,
          formattedAddress: userAddress.formattedAddress,
          city: userAddress.city,
          location: userAddress.location,
        }
      : null
  );
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState('');

  if (
    !isAddressModalOpen ||
    location.pathname === '/login' ||
    location.pathname === '/signup'
  ) {
    return null;
  }

  const handleUseCurrentLocation = () => {
    setError('');
    if (!navigator.geolocation) {
      setError('Location detection is not supported by your browser. Please enter your address above.');
      return;
    }

    setDetecting(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const coords: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };

        // Free OpenStreetMap/Photon reverse lookup with graceful fallback to raw coordinates
        const match = await reverseGeocodeWithPhoton(coords);
        if (match) {
          setAddressText(match.formattedAddress);
          setSelectedPlace({
            placeId: match.placeId,
            name: match.name || match.formattedAddress,
            formattedAddress: match.formattedAddress,
            city: match.city,
            location: coords,
          });
          setDetecting(false);
          return;
        }

        const fallbackLabel = `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
        setAddressText(fallbackLabel);
        setSelectedPlace({
          placeId: '',
          name: 'Current Location',
          formattedAddress: fallbackLabel,
          location: coords,
        });
        setDetecting(false);
      },
      () => {
        setDetecting(false);
        setError('Unable to access your current location. Search or type your address above instead.');
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmed = addressText.trim();
    if (!trimmed) {
      setError('Please enter or select your address to personalize your starting point.');
      return;
    }

    if (selectedPlace) {
      saveUserAddress({
        label: selectedPlace.name,
        formattedAddress: selectedPlace.formattedAddress,
        city: selectedPlace.city || selectedPlace.name,
        placeId: selectedPlace.placeId || undefined,
        location: selectedPlace.location,
        updatedAt: new Date().toISOString(),
      });
    } else {
      saveUserAddress({
        label: trimmed,
        formattedAddress: trimmed,
        city: trimmed.split(',')[0].trim() || trimmed,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-address-modal-title"
    >
      <div className="bg-white rounded-3xl border border-[#252B28]/12 w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-6 py-5 bg-[#F8F5EC] border-b border-[#252B28]/10 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#174B3A] text-white flex items-center justify-center shrink-0 mt-0.5">
              <Compass className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="user-address-modal-title"
                className="font-display text-xl font-semibold text-[#252B28]"
              >
                Where are you starting from?
              </h2>
              <p className="text-xs text-[#5A645F] mt-1 leading-relaxed">
                Search via OpenStreetMap or type your home city manually so TripMate can pre-fill your departure point.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismissAddressPrompt}
            className="p-1.5 rounded-lg text-[#5A645F] hover:text-[#252B28] hover:bg-black/5 shrink-0"
            aria-label="Skip address setup for now"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && (
            <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="initial-user-address"
              className="block text-xs font-semibold text-[#252B28] mb-1.5"
            >
              Your Street Address, Neighborhood, or City
            </label>
            <PlaceAutocompleteInput
              id="initial-user-address"
              value={addressText}
              onChangeText={(txt) => {
                setAddressText(txt);
                if (selectedPlace && txt !== selectedPlace.name && txt !== selectedPlace.formattedAddress) {
                  setSelectedPlace(null);
                }
              }}
              onSelectPlace={(place) => {
                setSelectedPlace(place);
                setAddressText(place.formattedAddress || place.name);
              }}
              placeholder="e.g., Indiranagar, Bengaluru or 24 Marine Drive, Mumbai"
              autoFocus
            />
            {selectedPlace && (
              <div className="mt-2 px-3 py-2 rounded-xl bg-[#F8F5EC] border border-[#174B3A]/20 text-xs text-[#174B3A] flex items-start gap-2">
                <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <span className="font-semibold">{selectedPlace.name}</span>
                  {selectedPlace.formattedAddress &&
                    selectedPlace.formattedAddress !== selectedPlace.name && (
                      <span className="text-[#5A645F]"> · {selectedPlace.formattedAddress}</span>
                    )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={detecting}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FCFBF7] border border-[#252B28]/15 text-xs font-semibold text-[#252B28] hover:bg-[#F8F5EC] transition-colors disabled:opacity-60"
            >
              {detecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#174B3A]" />
              ) : (
                <LocateFixed className="w-3.5 h-3.5 text-[#174B3A]" />
              )}
              <span>Use Current Location</span>
            </button>

            <div className="flex items-center gap-2.5 ml-auto">
              <button
                type="button"
                onClick={dismissAddressPrompt}
                className="px-4 py-2.5 rounded-xl border border-[#252B28]/15 text-xs font-semibold text-[#5A645F] hover:text-[#252B28] hover:bg-[#F8F5EC] transition-colors"
              >
                Skip for now
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#174B3A] text-white text-xs sm:text-sm font-semibold hover:bg-[#123B2D] transition-colors"
              >
                <Check className="w-4 h-4" />
                <span>Save Address</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
