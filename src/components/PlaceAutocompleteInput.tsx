import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, X } from 'lucide-react';
import { GeoPoint } from '../types/trip';
import { PhotonPlaceCandidate, searchPlacesWithPhoton } from '../utils/photonService';

export interface SelectedPlaceResult {
  placeId: string;
  name: string;
  formattedAddress: string;
  city?: string;
  location: GeoPoint;
}

interface PlaceAutocompleteInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSelectPlace: (place: SelectedPlaceResult) => void;
  placeholder?: string;
  includedPrimaryTypes?: string[];
  osmTags?: string[];
  locationBias?: GeoPoint;
  className?: string;
  inputClassName?: string;
  id?: string;
  autoFocus?: boolean;
}

const PHOTON_DEBOUNCE_MS = 500; // >= 450 ms per Photon fair-use policy

export const PlaceAutocompleteInput: React.FC<PlaceAutocompleteInputProps> = ({
  value,
  onChangeText,
  onSelectPlace,
  placeholder = 'Search address or place...',
  includedPrimaryTypes,
  osmTags,
  locationBias,
  className = '',
  inputClassName = '',
  id,
  autoFocus = false,
}) => {
  const justSelectedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [suggestions, setSuggestions] = useState<PhotonPlaceCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);

  const resolvedOsmTags = useMemo(() => {
    if (osmTags && osmTags.length > 0) return osmTags;
    if (includedPrimaryTypes?.includes('lodging')) {
      return ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel', 'tourism:resort'];
    }
    return undefined;
  }, [osmTags, includedPrimaryTypes]);

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setIsOpen(false);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, []);

  useEffect(() => {
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      setSearchNotice(null);
      return;
    }

    const abortController = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setSearchNotice(null);

      try {
        const res = await searchPlacesWithPhoton(trimmed, {
          limit: 6,
          locationBias,
          osmTags: resolvedOsmTags,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) return;

        if (res.unavailable) {
          setSuggestions([]);
          setIsOpen(false);
          setSearchNotice(
            res.errorMessage ||
              'Location suggestions unavailable. Continue typing to enter manually.'
          );
        } else {
          setSuggestions(res.results);
          setIsOpen(res.results.length > 0);
          setSearchNotice(null);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, PHOTON_DEBOUNCE_MS);

    return () => {
      abortController.abort();
      window.clearTimeout(timer);
    };
  }, [value, locationBias, resolvedOsmTags]);

  const handleSelectSuggestion = (item: PhotonPlaceCandidate) => {
    justSelectedRef.current = true;
    setSearchNotice(null);
    onChangeText(item.name || item.formattedAddress);
    onSelectPlace({
      placeId: item.placeId,
      name: item.name || item.formattedAddress,
      formattedAddress: item.formattedAddress,
      city: item.city,
      location: item.location,
    });
    clearSuggestions();
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <MapPin className="w-4 h-4 text-[#174B3A] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          id={id}
          type="text"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChangeText(e.target.value)}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          placeholder={placeholder}
          autoComplete="off"
          className={
            inputClassName ||
            'w-full pl-10 pr-9 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]'
          }
        />
        {isLoading ? (
          <Loader2 className="w-4 h-4 text-[#5A645F] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
        ) : (
          value.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onChangeText('');
                setSearchNotice(null);
                clearSuggestions();
              }}
              className="p-1 text-[#5A645F] hover:text-[#252B28] absolute right-2 top-1/2 -translate-y-1/2"
              aria-label="Clear location search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )
        )}
      </div>

      {searchNotice && (
        <p className="mt-1 text-[11px] text-[#5A645F]">{searchNotice}</p>
      )}

      {isOpen && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 mt-1.5 bg-white rounded-xl border border-[#252B28]/15 shadow-xl z-50 overflow-hidden">
          <ul
            role="listbox"
            className="max-h-60 overflow-y-auto divide-y divide-[#252B28]/8"
          >
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  onClick={() => handleSelectSuggestion(s)}
                  className="w-full px-3.5 py-2.5 text-left hover:bg-[#F8F5EC] transition-colors flex items-start gap-2.5"
                >
                  <MapPin className="w-3.5 h-3.5 text-[#174B3A] mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-semibold text-[#252B28] truncate">
                      {s.name}
                    </div>
                    {s.formattedAddress && s.formattedAddress !== s.name && (
                      <div className="text-[11px] text-[#5A645F] truncate">
                        {s.formattedAddress}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="px-3 py-1.5 bg-[#F8F5EC] border-t border-[#252B28]/8 text-[10px] text-[#5A645F] flex items-center justify-between">
            <span>Search data: OpenStreetMap / Photon</span>
            <span>Manual typing always supported</span>
          </div>
        </div>
      )}
    </div>
  );
};
