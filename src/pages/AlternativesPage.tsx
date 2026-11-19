import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  Check,
  Clock,
  Loader2,
  MapPin,
  Navigation,
  PlusCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { PlaceAutocompleteInput, SelectedPlaceResult } from '../components/PlaceAutocompleteInput';
import { TravelImage } from '../components/TravelImage';
import { useTripContext } from '../context/TripContext';
import { GENERATED_IMAGES } from '../data/destinations';
import {
  AiRecommendationItem,
  getRecommendationsAi,
  RecommendationCategory,
  verifyPlaceWithPhoton,
} from '../services/aiService';
import { getAlternativesForTrip } from '../utils/itineraryGenerator';
import { ActivityCategory, AlternativeActivityOption, GeoPoint } from '../types/trip';
import { computeHotelToPlaceMetrics } from '../utils/hotelItineraryService';
import { formatCommuteLabel, getDestinationBiasCenter } from '../utils/mapsConfig';
import { formatDuration, formatINR } from '../utils/scheduleUtils';

const AI_MODES: { id: RecommendationCategory; label: string }[] = [
  { id: 'places_to_visit', label: 'Places to visit' },
  { id: 'activities', label: 'Activities' },
  { id: 'food_dining', label: 'Food & dining' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'local_experiences', label: 'Local experiences' },
  { id: 'alternatives', label: 'Alternatives to activity' },
];

type FilterTag =
  | 'All'
  | 'Similar'
  | 'Lower Cost'
  | 'Child-Friendly'
  | 'Shorter Duration'
  | 'Different Type';

const FILTER_OPTIONS: { id: FilterTag; label: string }[] = [
  { id: 'All', label: 'All Alternatives' },
  { id: 'Similar', label: 'Similar Attractions' },
  { id: 'Lower Cost', label: 'Lower Cost' },
  { id: 'Child-Friendly', label: 'Child-Friendly' },
  { id: 'Shorter Duration', label: 'Shorter Duration' },
  { id: 'Different Type', label: 'Different Activity Type' },
];

const CATEGORIES: ActivityCategory[] = [
  'Food',
  'Attraction',
  'Culture',
  'Nature',
  'Leisure',
  'Transport',
];

export const AlternativesPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeTrip,
    selectedSwapActivityId,
    setSelectedSwapActivityId,
    replaceActivityWithAlternative,
    addRecommendedAtSlot,
    addActivity,
  } = useTripContext();

  const [filter, setFilter] = useState<FilterTag>('All');
  const [aiMode, setAiMode] = useState<RecommendationCategory>('places_to_visit');
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiTargetDay, setAiTargetDay] = useState(1);
  const [aiRecommendations, setAiRecommendations] = useState<AiRecommendationItem[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const [customTitle, setCustomTitle] = useState('');
  const [customLocation, setCustomLocation] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customDuration, setCustomDuration] = useState(90);
  const [customCost, setCustomCost] = useState(550);
  const [customCategory, setCustomCategory] = useState<ActivityCategory>('Attraction');
  const [customDay, setCustomDay] = useState(1);
  const [customStartTime, setCustomStartTime] = useState('15:30');
  const [customPlaceId, setCustomPlaceId] = useState<string | undefined>(undefined);
  const [customCoords, setCustomCoords] = useState<GeoPoint | undefined>(undefined);
  const [customDistanceKm, setCustomDistanceKm] = useState<number | undefined>(undefined);
  const [customTravelMin, setCustomTravelMin] = useState<number | undefined>(undefined);
  const [customIsFar, setCustomIsFar] = useState(false);
  const [checkingProximity, setCheckingProximity] = useState(false);
  const [formError, setFormError] = useState('');

  const targetActivity = useMemo(() => {
    if (!activeTrip || activeTrip.activities.length === 0) return null;
    if (selectedSwapActivityId) {
      const found = activeTrip.activities.find((a) => a.id === selectedSwapActivityId);
      if (found) return found;
    }
    return activeTrip.activities[0];
  }, [activeTrip, selectedSwapActivityId]);

  const alternativesPool = useMemo(() => {
    if (!activeTrip) return [];
    return getAlternativesForTrip(activeTrip.destination);
  }, [activeTrip]);

  const filteredAlternatives = useMemo(() => {
    return alternativesPool.filter((alt) => {
      if (filter === 'All') return true;
      if (filter === 'Lower Cost' && targetActivity) {
        return alt.tags.includes('Lower Cost') || alt.cost < targetActivity.cost;
      }
      if (filter === 'Shorter Duration' && targetActivity) {
        return alt.tags.includes('Shorter Duration') || alt.durationMinutes < targetActivity.durationMinutes;
      }
      if (filter === 'Child-Friendly') {
        return alt.isChildFriendly;
      }
      if (filter === 'Different Type' && targetActivity) {
        return alt.category !== targetActivity.category || alt.tags.includes('Different Type');
      }
      return alt.tags.includes(filter);
    });
  }, [alternativesPool, filter, targetActivity]);

  if (!activeTrip) {
    return (
      <AppLayout title="Explore Alternatives">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-10 text-center text-sm text-[#5A645F]">
          Create or select a trip to discover activity alternatives.
        </div>
      </AppLayout>
    );
  }

  const isWithHotel = activeTrip.stayMode === 'with-hotel' && Boolean(activeTrip.hotel);
  const maxHotelRadius = activeTrip.maxHotelRadiusKm || 10;
  const commuteMode = activeTrip.commuteMode || 'DRIVING';
  const defaultWaiting = activeTrip.waitingBufferMinutes ?? 15;
  const biasCenter = activeTrip.hotel?.location || getDestinationBiasCenter(activeTrip.destination);

  const handleSelectCustomPlace = async (place: SelectedPlaceResult) => {
    setCustomLocation(place.formattedAddress || place.name);
    if (!customTitle.trim()) {
      setCustomTitle(place.name);
    }
    setCustomPlaceId(place.placeId);
    setCustomCoords(place.location);

    if (isWithHotel && activeTrip.hotel) {
      setCheckingProximity(true);
      try {
        const metrics = await computeHotelToPlaceMetrics(
          activeTrip.hotel.location,
          place.location,
          commuteMode,
          maxHotelRadius
        );
        setCustomDistanceKm(metrics.distanceKm);
        setCustomTravelMin(metrics.travelMinutes);
        setCustomIsFar(metrics.isFarFromHotel);
      } finally {
        setCheckingProximity(false);
      }
    }
  };

  const handleReplace = (alt: AlternativeActivityOption) => {
    if (!targetActivity) return;
    replaceActivityWithAlternative(targetActivity.id, alt);
  };

  const mapAiItemToOption = (item: AiRecommendationItem): AlternativeActivityOption => ({
    id: item.id,
    title: item.name,
    description: `${item.shortExplanation} (${item.whyItSuitsTrip})`,
    category: item.category,
    location: item.verifiedAddress || item.locationHint,
    imageUrl: item.imageUrl,
    durationMinutes: item.suggestedDurationMinutes,
    cost: item.estimatedCostMid,
    isChildFriendly: item.isChildFriendly,
    crowdLevel: item.crowdLevel,
    tags: item.tags,
    coordinates: item.coordinates,
    placeId: item.placeId,
  });

  const handleFetchAiRecommendations = async (appendMode = false) => {
    if (aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    try {
      const existingTitles = activeTrip.activities.map((a) => a.title);
      const excludeTitles = appendMode ? aiRecommendations.map((r) => r.name) : [];

      const { data } = await getRecommendationsAi({
        destination: activeTrip.destination,
        category: aiMode,
        daysCount: activeTrip.daysCount,
        adults: activeTrip.adults,
        children: activeTrip.children,
        travelStyle: activeTrip.travelStyle,
        budgetTotal: activeTrip.budget.total,
        interests: activeTrip.generalNotes,
        existingTitles,
        excludeTitles,
        stayMode: activeTrip.stayMode || 'without-hotel',
        hotel: activeTrip.hotel || null,
        targetActivity:
          aiMode === 'alternatives' && targetActivity
            ? {
                id: targetActivity.id,
                title: targetActivity.title,
                category: targetActivity.category,
                location: targetActivity.location,
                durationMinutes: targetActivity.durationMinutes,
                cost: targetActivity.cost,
              }
            : undefined,
        instruction: aiInstruction.trim() || undefined,
      });

      const verifiedBatch: AiRecommendationItem[] = [];
      let stopLookup = false;
      for (const item of data.recommendations) {
        if (stopLookup) {
          verifiedBatch.push(item);
          continue;
        }
        const check = await verifyPlaceWithPhoton(
          `${item.name} ${item.locationHint}`,
          activeTrip.destination,
          biasCenter
        );
        if (check.rateLimited) {
          stopLookup = true;
        }
        if (check.verified && check.placeId && check.coordinates) {
          verifiedBatch.push({
            ...item,
            verificationStatus: 'maps_verified' as const,
            placeId: check.placeId,
            verifiedAddress: check.formattedAddress || item.locationHint,
            coordinates: check.coordinates,
          });
        } else {
          verifiedBatch.push(item);
        }
      }

      if (appendMode) {
        setAiRecommendations((prev) => {
          const seen = new Set(prev.map((p) => p.name.trim().toLowerCase()));
          const unique = verifiedBatch.filter((v) => !seen.has(v.name.trim().toLowerCase()));
          return [...prev, ...unique];
        });
      } else {
        setAiRecommendations(verifiedBatch);
      }
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : 'Unable to fetch Gemini AI recommendations right now.'
      );
    } finally {
      setAiLoading(false);
    }
  };

  const handleVerifySingleAiItem = async (item: AiRecommendationItem) => {
    setVerifyingId(item.id);
    try {
      const check = await verifyPlaceWithPhoton(
        `${item.name} ${item.locationHint}`,
        activeTrip.destination,
        biasCenter
      );
      if (check.verified && check.placeId && check.coordinates) {
        setAiRecommendations((prev) =>
          prev.map((r) =>
            r.id === item.id
              ? {
                  ...r,
                  verificationStatus: 'maps_verified',
                  placeId: check.placeId,
                  verifiedAddress: check.formattedAddress || r.locationHint,
                  coordinates: check.coordinates,
                }
              : r
          )
        );
      }
    } finally {
      setVerifyingId(null);
    }
  };

  const handleAddCustom = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!customTitle.trim()) {
      setFormError('Please enter an activity name.');
      return;
    }
    if (customDuration < 15) {
      setFormError('Duration must be at least 15 minutes.');
      return;
    }

    const imageByCategory =
      customCategory === 'Food'
        ? GENERATED_IMAGES.cafe
        : activeTrip.destination.toLowerCase().includes('jaipur')
        ? GENERATED_IMAGES.jaipur
        : activeTrip.destination.toLowerCase().includes('goa')
        ? GENERATED_IMAGES.goa
        : activeTrip.destination.toLowerCase().includes('manali')
        ? GENERATED_IMAGES.manali
        : activeTrip.destination.toLowerCase().includes('kerala')
        ? GENERATED_IMAGES.kerala
        : GENERATED_IMAGES.udaipur;

    addActivity({
      title: customTitle.trim(),
      location: customLocation.trim() || activeTrip.destination,
      description:
        customDescription.trim() ||
        `Custom ${customCategory.toLowerCase()} experience added for Day ${customDay}.`,
      durationMinutes: Number(customDuration),
      cost: Number(customCost),
      category: customCategory,
      day: Number(customDay),
      startTime: customStartTime,
      imageUrl: imageByCategory,
      isChildFriendly: true,
      crowdLevel: 'Low',
      placeId: customPlaceId,
      coordinates: customCoords,
      distanceFromHotelKm: customDistanceKm,
      travelFromHotelMinutes: customTravelMin,
      travelFromPrevMinutes: customTravelMin,
      waitingTimeMinutes: isWithHotel ? defaultWaiting : undefined,
      isFarFromHotel: isWithHotel ? customIsFar : undefined,
    });

    setCustomTitle('');
    setCustomLocation('');
    setCustomDescription('');
    setCustomPlaceId(undefined);
    setCustomCoords(undefined);
    setCustomDistanceKm(undefined);
    setCustomTravelMin(undefined);
    setCustomIsFar(false);
  };

  return (
    <AppLayout
      title="Explore Alternatives & Custom Stops"
      subtitle={`Discover alternative experiences in ${activeTrip.destination} or add your own`}
    >
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 8 Columns: Alternative Discovery */}
        <div className="xl:col-span-8 space-y-5">
          {/* Target Activity Selector */}
          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-[#5A645F]">
                  Replacing Activity in {activeTrip.name}
                </div>
                {targetActivity ? (
                  <div className="mt-1 text-sm font-semibold text-[#252B28]">
                    Day {targetActivity.day} · {targetActivity.title} ({formatINR(targetActivity.cost)} ·{' '}
                    {formatDuration(targetActivity.durationMinutes)})
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-[#5A645F]">No activities in trip yet.</div>
                )}
                {isWithHotel && activeTrip.hotel && (
                  <div className="mt-1.5 text-xs text-[#174B3A] inline-flex items-center gap-1.5 font-medium">
                    <Building2 className="w-3.5 h-3.5" />
                    <span>
                      Hotel stay: {activeTrip.hotel.name} · Radius guard: {maxHotelRadius} km
                    </span>
                  </div>
                )}
              </div>

              <select
                value={targetActivity?.id || ''}
                onChange={(e) => setSelectedSwapActivityId(e.target.value)}
                className="px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-medium text-[#252B28] max-w-xs focus:outline-none focus:border-[#174B3A]"
              >
                {activeTrip.activities.map((a) => (
                  <option key={a.id} value={a.id}>
                    Day {a.day}: {a.title} ({formatINR(a.cost)})
                  </option>
                ))}
              </select>
            </div>

            {/* Intent Filter Tabs */}
            <div className="mt-4 pt-4 border-t border-[#252B28]/8 flex flex-wrap gap-1.5">
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFilter(opt.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    filter === opt.id
                      ? 'bg-[#174B3A] text-white'
                      : 'bg-[#F8F5EC] text-[#5A645F] hover:text-[#252B28]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Gemini AI Recommendations Section */}
          <section className="bg-white rounded-2xl border border-[#252B28]/10 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#174B3A] inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Gemini AI Recommendations</span>
                </div>
                <h2 className="mt-1 font-display text-xl font-semibold text-[#252B28]">
                  Discover tailored places &amp; alternatives for {activeTrip.destination}
                </h2>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={aiTargetDay}
                  onChange={(e) => setAiTargetDay(Number(e.target.value))}
                  aria-label="Day for AI quick add"
                  className="px-3 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-mono font-semibold text-[#174B3A]"
                >
                  {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      Add to Day {d}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void handleFetchAiRecommendations(false)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60 whitespace-nowrap"
                >
                  {aiLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>{aiLoading ? 'Searching with AI...' : 'Get AI Picks'}</span>
                </button>
              </div>
            </div>

            {/* 6 Recommendation Categories */}
            <div className="flex flex-wrap gap-1.5">
              {AI_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setAiMode(m.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    aiMode === m.id
                      ? 'bg-[#174B3A] text-white'
                      : 'bg-[#F8F5EC] text-[#5A645F] hover:text-[#252B28]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder="Optional focus (e.g., quiet cafes near lake, evening heritage walk, wheelchair friendly)..."
                className="flex-1 px-3.5 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs focus:outline-none focus:border-[#174B3A]"
              />
              {aiRecommendations.length > 0 && (
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void handleFetchAiRecommendations(true)}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F8F5EC] border border-[#174B3A]/20 text-xs font-semibold text-[#174B3A] hover:bg-[#efe9d8] disabled:opacity-60 whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Load More (No Duplicates)</span>
                </button>
              )}
            </div>

            {aiError && (
              <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span>{aiError}</span>
                <button
                  type="button"
                  onClick={() => void handleFetchAiRecommendations(false)}
                  className="px-3 py-1.5 rounded-lg bg-red-700 text-white font-semibold hover:bg-red-800 whitespace-nowrap self-start sm:self-auto"
                >
                  Retry
                </button>
              </div>
            )}

            {aiRecommendations.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {aiRecommendations.map((item) => {
                  const opt = mapAiItemToOption(item);
                  const isVerified = item.verificationStatus === 'maps_verified';
                  return (
                    <article
                      key={item.id}
                      className="rounded-xl border border-[#252B28]/12 bg-[#FCFBF7] p-4 flex flex-col justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="font-semibold text-[#5A645F]">
                            {item.category} · {formatDuration(item.suggestedDurationMinutes)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-md font-semibold inline-flex items-center gap-1 ${
                              isVerified
                                ? 'bg-[#EEF4F0] text-[#174B3A]'
                                : 'bg-amber-50 text-amber-800 border border-amber-200'
                            }`}
                          >
                            {isVerified && <ShieldCheck className="w-3 h-3" />}
                            {isVerified ? 'Location Verified' : 'AI Suggestion (unverified)'}
                          </span>
                        </div>

                        <h3 className="mt-1.5 font-display text-base font-semibold text-[#252B28]">
                          {item.name}
                        </h3>
                        <div className="mt-0.5 text-xs text-[#5A645F] flex items-center gap-1">
                          <MapPin className="w-3 h-3 shrink-0" />
                          <span className="truncate">
                            {item.verifiedAddress || item.locationHint}
                          </span>
                        </div>

                        <p className="mt-2 text-xs text-[#252B28] leading-relaxed">
                          {item.shortExplanation}
                        </p>
                        <p className="mt-1 text-[11px] text-[#174B3A] font-medium">
                          Fit: {item.whyItSuitsTrip}
                        </p>
                        {item.importantCaveats && (
                          <p className="mt-1 text-[11px] text-[#5A645F]">
                            Note: {item.importantCaveats}
                          </p>
                        )}
                      </div>

                      <div className="pt-3 border-t border-[#252B28]/10 space-y-2.5">
                        <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                          <span className="font-semibold text-[#174B3A]">
                            Est. {formatINR(item.approxCostMin)}–{formatINR(item.approxCostMax)}
                          </span>
                          {!isVerified && (
                            <button
                              type="button"
                              disabled={verifyingId === item.id}
                              onClick={() => void handleVerifySingleAiItem(item)}
                              className="font-sans text-[11px] font-semibold text-[#174B3A] hover:underline disabled:opacity-50"
                            >
                              {verifyingId === item.id ? 'Checking OSM...' : 'Locate via OSM'}
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => addRecommendedAtSlot(opt, aiTargetDay)}
                            className="flex-1 py-1.5 px-3 rounded-lg bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] whitespace-nowrap"
                          >
                            Add to Day {aiTargetDay}
                          </button>
                          {targetActivity && (
                            <button
                              type="button"
                              onClick={() => handleReplace(opt)}
                              className="flex-1 py-1.5 px-3 rounded-lg bg-white border border-[#174B3A]/25 text-[#174B3A] text-xs font-semibold hover:bg-[#F8F5EC] whitespace-nowrap"
                            >
                              Replace Selected
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Alternative Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {filteredAlternatives.map((alt) => {
              const costDiff = targetActivity ? alt.cost - targetActivity.cost : 0;
              return (
                <article
                  key={alt.id}
                  className="bg-white rounded-2xl border border-[#252B28]/10 overflow-hidden flex flex-col"
                >
                  <div className="h-44 overflow-hidden bg-[#F8F5EC]">
                    <TravelImage
                      src={alt.imageUrl}
                      alt={alt.title}
                      fallbackTitle={alt.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-5 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="text-xs text-[#5A645F] font-medium flex items-center gap-2">
                        <span>{alt.category}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDuration(alt.durationMinutes)}
                        </span>
                        {alt.isChildFriendly && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Child-friendly</span>
                          </>
                        )}
                      </div>
                      <h3 className="mt-2 font-display text-lg font-semibold text-[#252B28]">
                        {alt.title}
                      </h3>
                      <div className="mt-1 text-xs text-[#5A645F] flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        <span>{alt.location}</span>
                      </div>
                      <p className="mt-2.5 text-xs sm:text-sm text-[#5A645F] leading-relaxed">
                        {alt.description}
                      </p>
                    </div>

                    <div className="mt-5 pt-4 border-t border-[#252B28]/8 flex items-center justify-between gap-3">
                      <div>
                        <div className="font-mono text-base font-semibold text-[#174B3A] tabular-nums">
                          {formatINR(alt.cost)}
                        </div>
                        {targetActivity && costDiff !== 0 && (
                          <div
                            className={`text-[11px] font-mono tabular-nums ${
                              costDiff < 0 ? 'text-[#174B3A]' : 'text-amber-700'
                            }`}
                          >
                            {costDiff < 0
                              ? `Saves ${formatINR(Math.abs(costDiff))}`
                              : `+${formatINR(costDiff)} vs current`}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={!targetActivity}
                        onClick={() => handleReplace(alt)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        <ArrowLeftRight className="w-3.5 h-3.5" />
                        <span>Replace Activity</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        {/* Right 4 Columns: Add Custom Activity Form */}
        <aside className="xl:col-span-4 bg-white rounded-2xl border border-[#252B28]/10 p-6 sticky top-24">
          <div className="flex items-center gap-2 text-[#174B3A] mb-1">
            <PlusCircle className="w-4 h-4" />
            <span className="text-xs font-semibold">Custom Experience</span>
          </div>
          <h2 className="font-display text-xl font-semibold text-[#252B28]">
            Add Custom Activity
          </h2>
          <p className="text-xs text-[#5A645F] mt-1">
            Search any spot via OpenStreetMap or type your own booking to insert directly into the trip.
          </p>

          {formError && (
            <div className="mt-4 px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
              {formError}
            </div>
          )}

          <form onSubmit={handleAddCustom} className="mt-5 space-y-3.5">
            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1">
                Activity Name
              </label>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="e.g., Sunset Rooftop Dinner"
                className="w-full px-3 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1">
                Location (OpenStreetMap Search)
              </label>
              <PlaceAutocompleteInput
                value={customLocation}
                onChangeText={(text) => {
                  setCustomLocation(text);
                  if (!text.trim()) {
                    setCustomPlaceId(undefined);
                    setCustomCoords(undefined);
                    setCustomDistanceKm(undefined);
                    setCustomTravelMin(undefined);
                    setCustomIsFar(false);
                  }
                }}
                onSelectPlace={(p) => void handleSelectCustomPlace(p)}
                locationBias={biasCenter}
                placeholder={`Search spot in ${activeTrip.destination}...`}
              />
            </div>

            {isWithHotel && (checkingProximity || customDistanceKm !== undefined) && (
              <div
                className={`rounded-xl border p-3 text-xs ${
                  customIsFar
                    ? 'bg-amber-50 border-amber-300 text-amber-950'
                    : 'bg-[#F8F5EC] border-[#174B3A]/20 text-[#252B28]'
                }`}
              >
                {checkingProximity ? (
                  <div className="flex items-center gap-2 text-[#174B3A] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Checking distance from {activeTrip.hotel?.name}...</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between font-mono tabular-nums">
                      <span className="inline-flex items-center gap-1 font-semibold text-[#174B3A]">
                        <Navigation className="w-3.5 h-3.5" />
                        {customDistanceKm} km straight-line
                      </span>
                      {customTravelMin !== undefined && (
                        <span>
                          ~{customTravelMin}m est. ({formatCommuteLabel(commuteMode)}) · +{defaultWaiting}m wait
                        </span>
                      )}
                    </div>
                    {customIsFar && (
                      <div className="flex items-start gap-1.5 text-amber-900 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-700" />
                        <span>
                          Faraway alert: Beyond your {maxHotelRadius} km hotel radius.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1">
                Description
              </label>
              <textarea
                rows={2}
                value={customDescription}
                onChange={(e) => setCustomDescription(e.target.value)}
                placeholder="Short notes about this stop..."
                className="w-full px-3 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1">
                  Category
                </label>
                <select
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value as ActivityCategory)}
                  className="w-full px-3 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-medium focus:outline-none focus:border-[#174B3A]"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1">Day</label>
                <select
                  value={customDay}
                  onChange={(e) => setCustomDay(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
                >
                  {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      Day {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1">
                  Start Time
                </label>
                <input
                  type="time"
                  value={customStartTime}
                  onChange={(e) => setCustomStartTime(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1">
                  Duration (m)
                </label>
                <input
                  type="number"
                  min={15}
                  step={15}
                  value={customDuration}
                  onChange={(e) => setCustomDuration(Number(e.target.value))}
                  className="w-full px-2.5 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1">
                  Cost (INR)
                </label>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={customCost}
                  onChange={(e) => setCustomCost(Number(e.target.value))}
                  className="w-full px-2.5 py-2 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-[#174B3A] text-white text-sm font-semibold hover:bg-[#123B2D] transition-colors flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" />
              <span>Add to Day {customDay}</span>
            </button>
          </form>

          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="mt-3 w-full py-2 rounded-xl bg-[#F8F5EC] text-[#174B3A] text-xs font-semibold hover:bg-[#efe9d8] transition-colors"
          >
            Return to Itinerary Dashboard
          </button>
        </aside>
      </div>
    </AppLayout>
  );
};
