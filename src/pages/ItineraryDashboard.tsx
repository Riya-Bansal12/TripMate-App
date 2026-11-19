import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  CalendarRange,
  Clock,
  Edit3,
  Loader2,
  Map as MapIcon,
  MapPin,
  Navigation,
  PieChart,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { ActivityModal, ActivityModalSavePayload } from '../components/ActivityModal';
import { TravelImage } from '../components/TravelImage';
import { TripMapOverview } from '../components/TripMapOverview';
import { useTripContext } from '../context/TripContext';
import { Activity, DayPace } from '../types/trip';
import { formatCommuteLabel } from '../utils/mapsConfig';
import { formatDuration, formatINR, sortActivitiesByTime } from '../utils/scheduleUtils';

const DAY_REGEN_PRESETS = [
  'Make this day more relaxed',
  'Focus on cultural attractions',
  'Reduce estimated spending',
  'Add family-friendly activities',
  'Include more outdoor experiences',
  'Improve activity sequence',
];

const ACTIVITY_REFINE_PRESETS = [
  'Make shorter',
  'More affordable',
  'Child-friendly',
  'Indoor alternative',
  'Improve description',
  'More accessible',
  'Nearby alternative',
  'Fit day schedule',
];

export const ItineraryDashboard: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeTrip,
    activeTripMetrics,
    activeTripAiOverview,
    tripsLoading,
    loadSampleTrip,
    addActivity,
    updateActivity,
    deleteActivity,
    regenerateActiveTrip,
    regenerateDayWithAi,
    refineActivityWithAi,
    autoResolveDay,
    setSelectedSwapActivityId,
    settings,
    showToast,
  } = useTripContext();

  const [selectedDay, setSelectedDay] = useState(1);
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [showMap, setShowMap] = useState(true);

  // Single-Day AI Regeneration state
  const [dayRegenOpen, setDayRegenOpen] = useState(false);
  const [dayRegenInstruction, setDayRegenInstruction] = useState(DAY_REGEN_PRESETS[0]);
  const [dayRegenPace, setDayRegenPace] = useState<DayPace | ''>('');
  const [isRegeneratingDay, setIsRegeneratingDay] = useState(false);
  const [dayRegenError, setDayRegenError] = useState<string | null>(null);

  // Individual Activity AI Refinement state
  const [refiningTarget, setRefiningTarget] = useState<Activity | null>(null);
  const [refineInstruction, setRefineInstruction] = useState('');
  const [isRefiningActivity, setIsRefiningActivity] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refineSummaryMap, setRefineSummaryMap] = useState<Record<string, string>>({});

  const safeDay = useMemo(() => {
    if (!activeTrip) return 1;
    return Math.min(Math.max(1, selectedDay), activeTrip.daysCount);
  }, [activeTrip, selectedDay]);

  if (tripsLoading) {
    return (
      <AppLayout title="Itinerary Dashboard">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-12 text-center max-w-lg mx-auto">
          <Loader2 className="w-7 h-7 text-[#174B3A] animate-spin mx-auto mb-3" />
          <p className="text-sm text-[#5A645F]">Loading your Cloud Firestore itinerary...</p>
        </div>
      </AppLayout>
    );
  }

  if (!activeTrip || !activeTripMetrics) {
    return (
      <AppLayout title="Itinerary Dashboard">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-12 text-center max-w-lg mx-auto">
          <h2 className="font-display text-2xl font-semibold text-[#252B28]">No active trip selected</h2>
          <p className="mt-2 text-sm text-[#5A645F]">
            Start a new personalized journey in the Trip Creation Wizard or load our curated Udaipur sample trip.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/create-trip')}
              className="px-5 py-2.5 rounded-xl bg-[#174B3A] text-white text-sm font-semibold hover:bg-[#123B2D]"
            >
              Create New Trip
            </button>
            <button
              type="button"
              disabled={loadingSample}
              onClick={async () => {
                setLoadingSample(true);
                try {
                  await loadSampleTrip();
                } finally {
                  setLoadingSample(false);
                }
              }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F8F5EC] border border-[#252B28]/12 text-[#174B3A] text-sm font-semibold hover:bg-[#efe9d8] disabled:opacity-60"
            >
              {loadingSample && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Load Sample Udaipur Trip</span>
            </button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const dayPlan = activeTrip.dayPlans.find((d) => d.dayNumber === safeDay);
  const daySummary = activeTripMetrics.dayMetrics.find((m) => m.dayNumber === safeDay);
  const dayActivities = sortActivitiesByTime(
    activeTrip.activities.filter((a) => a.day === safeDay)
  );
  const conflictMap = new Map(
    (daySummary?.conflicts || []).map((c) => [c.activityId, c])
  );

  const travelersCount = activeTrip.adults + activeTrip.children;
  const isWithHotel = activeTrip.stayMode === 'with-hotel' && Boolean(activeTrip.hotel);
  const hasMappedStops = dayActivities.some((a) => Boolean(a.coordinates));

  const handleRegenerate = async () => {
    if (isRegenerating) return;
    setRegenError(null);
    setIsRegenerating(true);
    try {
      await regenerateActiveTrip();
    } catch (err) {
      setRegenError(
        err instanceof Error ? err.message : 'Unable to regenerate itinerary with Gemini AI.'
      );
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleOpenDayRegen = () => {
    setDayRegenError(null);
    setDayRegenPace(dayPlan?.pace || '');
    setDayRegenOpen(true);
  };

  const handleConfirmDayRegen = async () => {
    if (isRegeneratingDay) return;
    setDayRegenError(null);
    setIsRegeneratingDay(true);
    try {
      const res = await regenerateDayWithAi(
        safeDay,
        dayRegenInstruction,
        dayRegenPace || undefined
      );
      if (!res.ok) {
        setDayRegenError(res.error || `Could not regenerate Day ${safeDay}.`);
        return;
      }
      setDayRegenOpen(false);
    } finally {
      setIsRegeneratingDay(false);
    }
  };

  const handleOpenRefine = (act: Activity) => {
    setRefiningTarget(act);
    setRefineInstruction('');
    setRefineError(null);
  };

  const handleConfirmRefine = async (customInstr?: string) => {
    if (!refiningTarget || isRefiningActivity) return;
    const instr = (customInstr ?? refineInstruction).trim();
    if (instr.length < 2) {
      setRefineError('Select a refinement option or enter a custom instruction.');
      return;
    }
    setRefineError(null);
    setIsRefiningActivity(true);
    try {
      const res = await refineActivityWithAi(refiningTarget.id, instr);
      if (!res.ok) {
        setRefineError(res.error || 'Could not refine this activity.');
        return;
      }
      if (res.changeSummary) {
        setRefineSummaryMap((prev) => ({
          ...prev,
          [refiningTarget.id]: res.changeSummary!,
        }));
      }
      setRefiningTarget(null);
      setRefineInstruction('');
    } finally {
      setIsRefiningActivity(false);
    }
  };

  const handleOpenAdd = () => {
    setEditingActivity(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (act: Activity) => {
    setEditingActivity(act);
    setModalOpen(true);
  };

  const handleSaveModal = (payload: ActivityModalSavePayload) => {
    if (payload.id) {
      updateActivity(payload.id, {
        title: payload.title,
        location: payload.location,
        description: payload.description,
        category: payload.category,
        day: payload.day,
        startTime: payload.startTime,
        durationMinutes: payload.durationMinutes,
        cost: payload.cost,
        imageUrl: payload.imageUrl,
        placeId: payload.placeId,
        coordinates: payload.coordinates,
        travelFromHotelMinutes: payload.travelFromHotelMinutes,
        travelFromPrevMinutes: payload.travelFromPrevMinutes,
        waitingTimeMinutes: payload.waitingTimeMinutes,
        distanceFromHotelKm: payload.distanceFromHotelKm,
        isFarFromHotel: payload.isFarFromHotel,
      });
      showToast(`Updated "${payload.title}"`);
    } else {
      addActivity({
        title: payload.title,
        location: payload.location,
        description: payload.description,
        category: payload.category,
        day: payload.day,
        startTime: payload.startTime,
        durationMinutes: payload.durationMinutes,
        cost: payload.cost,
        imageUrl: payload.imageUrl,
        isChildFriendly: true,
        crowdLevel: 'Low',
        placeId: payload.placeId,
        coordinates: payload.coordinates,
        travelFromHotelMinutes: payload.travelFromHotelMinutes,
        travelFromPrevMinutes: payload.travelFromPrevMinutes,
        waitingTimeMinutes: payload.waitingTimeMinutes,
        distanceFromHotelKm: payload.distanceFromHotelKm,
        isFarFromHotel: payload.isFarFromHotel,
      });
      setSelectedDay(payload.day);
    }
  };

  return (
    <AppLayout
      title={activeTrip.name}
      subtitle={`${activeTrip.origin} to ${activeTrip.destination} · ${activeTrip.travelStyle} style`}
    >
      <div className="space-y-6">
        {/* Top Summary Strip */}
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4">
            <div className="text-xs text-[#5A645F]">Destination</div>
            <div className="mt-1 font-display text-lg font-semibold text-[#252B28] truncate">
              {activeTrip.destination}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4">
            <div className="text-xs text-[#5A645F]">Trip Duration</div>
            <div className="mt-1 font-mono text-lg font-semibold text-[#252B28] tabular-nums">
              {activeTrip.daysCount} Days
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4">
            <div className="text-xs text-[#5A645F]">Travelers</div>
            <div className="mt-1 font-mono text-lg font-semibold text-[#252B28] tabular-nums">
              {travelersCount} {travelersCount === 1 ? 'Person' : 'People'}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4">
            <div className="text-xs text-[#5A645F]">Total Budget</div>
            <div className="mt-1 font-mono text-lg font-semibold text-[#252B28] tabular-nums">
              {formatINR(activeTrip.budget.total)}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4">
            <div className="text-xs text-[#5A645F]">Estimated Expenses</div>
            <div className="mt-1 font-mono text-lg font-semibold text-[#174B3A] tabular-nums">
              {formatINR(activeTripMetrics.totalEstimatedExpense)}
            </div>
          </div>

          <div
            className={`rounded-2xl border p-4 ${
              activeTripMetrics.isOverBudget
                ? 'bg-red-50 border-red-200'
                : 'bg-[#F8F5EC] border-[#252B28]/10'
            }`}
          >
            <div className="text-xs text-[#5A645F]">Remaining Budget</div>
            <div
              className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                activeTripMetrics.isOverBudget ? 'text-red-700' : 'text-[#174B3A]'
              }`}
            >
              {formatINR(activeTripMetrics.remainingBudget)}
            </div>
          </div>
        </section>

        {/* Hotel Anchor Banner (when With Hotel mode is active) */}
        {isWithHotel && activeTrip.hotel && (
          <section className="bg-[#174B3A] text-white rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/12 flex items-center justify-center shrink-0">
                <Building2 className="w-5 h-5 text-[#D8AC55]" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#D8AC55]">
                  Hotel-Anchored Itinerary · {formatCommuteLabel(activeTrip.commuteMode || 'DRIVING')} · {activeTrip.maxHotelRadiusKm || 10} km radius guard
                </div>
                <div className="font-display text-lg font-semibold truncate">
                  {activeTrip.hotel.name}
                </div>
                <div className="text-xs text-white/80 truncate">
                  {activeTrip.hotel.formattedAddress}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 shrink-0">
              {daySummary && (daySummary.totalTravelMinutes > 0 || daySummary.totalWaitingMinutes > 0) && (
                <div className="text-right font-mono tabular-nums text-xs">
                  <div className="text-white/75 font-sans text-[11px]">Day {safeDay} Transit &amp; Wait</div>
                  <div className="font-semibold text-[#D8AC55]">
                    {formatDuration(daySummary.totalTravelMinutes)} travel · +{formatDuration(daySummary.totalWaitingMinutes)} wait
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowMap((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white text-[#174B3A] text-xs font-semibold hover:bg-[#F8F5EC] transition-colors whitespace-nowrap"
              >
                <MapIcon className="w-3.5 h-3.5" />
                <span>{showMap ? 'Hide Map' : 'Show Route Map'}</span>
              </button>
            </div>
          </section>
        )}

        {/* Functional Controls Toolbar */}
        <section className="bg-white rounded-2xl border border-[#252B28]/10 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Day Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0">
            {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((dayNum) => {
              const dm = activeTripMetrics.dayMetrics.find((m) => m.dayNumber === dayNum);
              const hasConflict = settings.enableConflictDetection && (dm?.conflicts.length || 0) > 0;
              const isSelected = safeDay === dayNum;
              return (
                <button
                  key={dayNum}
                  type="button"
                  onClick={() => setSelectedDay(dayNum)}
                  className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 ${
                    isSelected
                      ? 'bg-[#174B3A] text-white'
                      : 'bg-[#FCFBF7] text-[#252B28] border border-[#252B28]/10 hover:bg-[#F8F5EC]'
                  }`}
                >
                  <span>Day {dayNum}</span>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      isSelected ? 'text-[#D8AC55]' : 'text-[#5A645F]'
                    }`}
                  >
                    {dm?.activitiesCount || 0}
                  </span>
                  {hasConflict && (
                    <AlertTriangle
                      className={`w-3.5 h-3.5 ${isSelected ? 'text-[#D8AC55]' : 'text-amber-600'}`}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Primary Actions */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsEditingMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-xs font-semibold transition-colors whitespace-nowrap ${
                isEditingMode
                  ? 'bg-[#D8AC55] border-[#D8AC55] text-[#252B28]'
                  : 'bg-[#FCFBF7] border-[#252B28]/15 text-[#252B28] hover:bg-[#F8F5EC]'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>{isEditingMode ? 'Done Editing' : 'Edit Itinerary'}</span>
            </button>

            <button
              type="button"
              onClick={handleOpenDayRegen}
              disabled={isRegenerating || isRegeneratingDay}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F8F5EC] border border-[#174B3A]/20 text-xs font-semibold text-[#174B3A] hover:bg-[#efe9d8] transition-colors whitespace-nowrap disabled:opacity-60"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Regenerate Day {safeDay}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRegenerate()}
              disabled={isRegenerating || isRegeneratingDay}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FCFBF7] border border-[#252B28]/15 text-xs font-semibold text-[#252B28] hover:bg-[#F8F5EC] transition-colors whitespace-nowrap disabled:opacity-60"
            >
              {isRegenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>Regenerate Itinerary</span>
            </button>

            <button
              type="button"
              onClick={handleOpenAdd}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Activity</span>
            </button>

            <button
              type="button"
              onClick={() => navigate('/expenses')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F8F5EC] border border-[#252B28]/12 text-xs font-semibold text-[#174B3A] hover:bg-[#efe9d8] transition-colors whitespace-nowrap"
            >
              <PieChart className="w-3.5 h-3.5" />
              <span>View Expenses</span>
            </button>
          </div>
        </section>

        {regenError && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-red-800">
            <span>{regenError}</span>
            <button
              type="button"
              onClick={() => void handleRegenerate()}
              className="px-3.5 py-1.5 rounded-xl bg-red-700 text-white font-semibold hover:bg-red-800 whitespace-nowrap self-start sm:self-auto"
            >
              Retry AI Regeneration
            </button>
          </div>
        )}

        {activeTripAiOverview && (
          <section className="bg-white rounded-2xl border border-[#252B28]/10 p-4 sm:p-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#174B3A]">
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI Itinerary Overview</span>
            </div>
            <p className="mt-1.5 text-sm text-[#252B28] leading-relaxed">
              {activeTripAiOverview.overview}
            </p>
            {activeTripAiOverview.practicalNotes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {activeTripAiOverview.practicalNotes.slice(0, 4).map((note, i) => (
                  <span
                    key={i}
                    className="px-2.5 py-1 rounded-lg bg-[#F8F5EC] border border-[#252B28]/10 text-[11px] text-[#5A645F]"
                  >
                    {note}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Conflict Warning Banner */}
        {settings.enableConflictDetection && daySummary && daySummary.conflicts.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-amber-900">
                  Schedule overlap detected on Day {safeDay}
                </div>
                <p className="text-xs text-amber-800 mt-0.5">
                  Two or more activities share overlapping start and end times. Adjust times or auto-resolve sequentially.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => autoResolveDay(safeDay)}
              className="px-4 py-2 rounded-xl bg-amber-700 text-white text-xs font-semibold hover:bg-amber-800 transition-colors whitespace-nowrap shrink-0"
            >
              Auto-Resolve Times
            </button>
          </div>
        )}

        {/* Interactive Day Route & Hotel Proximity Map */}
        {showMap && (isWithHotel || hasMappedStops) && (
          <TripMapOverview
            dayNumber={safeDay}
            hotel={activeTrip.hotel}
            activities={dayActivities}
            commuteMode={activeTrip.commuteMode || 'DRIVING'}
            maxHotelRadiusKm={activeTrip.maxHotelRadiusKm || 10}
          />
        )}

        {/* Day Header & Daily Summary */}
        <section className="bg-[#F8F5EC] rounded-2xl border border-[#252B28]/10 p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-[#5A645F]">
              Day {safeDay} · {dayPlan?.pace || 'Balanced'} Pace
            </div>
            <h2 className="mt-1 font-display text-2xl font-semibold text-[#252B28]">
              Day {safeDay} – {dayPlan?.title || 'Exploration'}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-6 font-mono tabular-nums">
            <div>
              <div className="text-[11px] font-sans text-[#5A645F]">Activities</div>
              <div className="text-base font-semibold text-[#252B28]">
                {daySummary?.activitiesCount || 0}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-sans text-[#5A645F]">Estimated Activity Hours</div>
              <div className="text-base font-semibold text-[#252B28]">
                {Math.round(daySummary?.totalHours || 0)} hrs ({formatDuration(daySummary?.totalMinutes || 0)})
              </div>
            </div>
            {daySummary && (daySummary.totalTravelMinutes > 0 || daySummary.totalWaitingMinutes > 0) && (
              <div>
                <div className="text-[11px] font-sans text-[#5A645F]">Commute &amp; Wait</div>
                <div className="text-base font-semibold text-[#252B28]">
                  {formatDuration(daySummary.totalTravelMinutes)} + {formatDuration(daySummary.totalWaitingMinutes)}
                </div>
              </div>
            )}
            <div>
              <div className="text-[11px] font-sans text-[#5A645F]">Daily Estimated Expense</div>
              <div className="text-base font-semibold text-[#174B3A]">
                {formatINR(daySummary?.totalExpense || 0)}
              </div>
            </div>
          </div>
        </section>

        {/* Activity Cards List */}
        {isRegenerating ? (
          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-12 text-center">
            <Loader2 className="w-7 h-7 text-[#174B3A] animate-spin mx-auto mb-3" />
            <div className="font-display text-lg font-semibold text-[#252B28]">
              Refreshing your {activeTrip.destination} itinerary...
            </div>
          </div>
        ) : dayActivities.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-12 text-center">
            <h3 className="font-display text-xl font-semibold text-[#252B28]">
              No activities scheduled for Day {safeDay}
            </h3>
            <p className="mt-2 text-sm text-[#5A645F]">
              Add a custom stop or move an activity here from the Drag-and-Drop Planner.
            </p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={handleOpenAdd}
                className="px-4 py-2.5 rounded-xl bg-[#174B3A] text-white text-xs font-semibold"
              >
                Add Activity
              </button>
              <button
                type="button"
                onClick={() => navigate('/planner')}
                className="px-4 py-2.5 rounded-xl bg-[#F8F5EC] text-[#174B3A] text-xs font-semibold"
              >
                Open DnD Planner
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {dayActivities.map((act, index) => {
              const conflict = settings.enableConflictDetection ? conflictMap.get(act.id) : undefined;
              const travelMinutes = act.travelFromPrevMinutes ?? act.travelFromHotelMinutes;
              const hasTransitMeta =
                travelMinutes !== undefined ||
                act.waitingTimeMinutes !== undefined ||
                act.distanceFromHotelKm !== undefined;

              return (
                <article
                  key={act.id}
                  className={`bg-white rounded-2xl border overflow-hidden transition-colors ${
                    conflict
                      ? 'border-amber-400 bg-amber-50/30'
                      : act.isFarFromHotel
                      ? 'border-amber-300'
                      : 'border-[#252B28]/10 hover:border-[#174B3A]/30'
                  }`}
                >
                  <div className="grid grid-cols-1 md:grid-cols-12 items-stretch">
                    <div className="md:col-span-3 h-48 md:h-auto min-h-[176px] overflow-hidden bg-[#F8F5EC]">
                      <TravelImage
                        src={act.imageUrl}
                        alt={act.title}
                        fallbackTitle={act.title}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    <div className="md:col-span-9 p-5 sm:p-6 flex flex-col justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs text-[#5A645F] font-medium flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold text-[#174B3A]">
                              0{index + 1}.
                            </span>
                            <span>{act.category}</span>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="w-3.5 h-3.5" />
                              {act.location}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                                act.placeId && act.coordinates
                                  ? 'bg-[#EEF4F0] text-[#174B3A]'
                                  : 'bg-[#F8F5EC] text-[#5A645F] border border-[#252B28]/10'
                              }`}
                            >
                              {act.placeId && act.coordinates ? 'Maps Verified' : 'AI Suggestion'}
                            </span>
                          </div>

                          <div className="font-mono text-base font-semibold text-[#174B3A] tabular-nums">
                            {formatINR(act.cost)}
                          </div>
                        </div>

                        <h3 className="mt-2 font-display text-xl font-semibold text-[#252B28]">
                          {act.title}
                        </h3>
                        <p className="mt-1.5 text-sm text-[#5A645F] leading-relaxed">
                          {act.description}
                        </p>

                        {refineSummaryMap[act.id] && (
                          <div className="mt-2 px-3 py-1.5 rounded-lg bg-[#EEF4F0] border border-[#174B3A]/20 text-[11px] font-medium text-[#174B3A] inline-flex items-center gap-1.5">
                            <Wand2 className="w-3 h-3 shrink-0" />
                            <span>AI Update: {refineSummaryMap[act.id]}</span>
                          </div>
                        )}

                        {/* Travel Time, Waiting Buffer & Hotel Proximity Breakdown */}
                        {hasTransitMeta && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                            {index === 0 && act.departureFromHotelTime && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#F8F5EC] border border-[#252B28]/10 text-[#252B28]">
                                <Building2 className="w-3 h-3 text-[#174B3A]" />
                                Depart hotel {act.departureFromHotelTime}
                              </span>
                            )}
                            {travelMinutes !== undefined && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#EEF4F0] text-[#174B3A] font-medium">
                                <Navigation className="w-3 h-3" />
                                {index === 0
                                  ? `~${travelMinutes}m est. commute from hotel`
                                  : `~${travelMinutes}m est. travel from prev stop`}
                                {` (${formatCommuteLabel(activeTrip.commuteMode || 'DRIVING')})`}
                              </span>
                            )}
                            {act.waitingTimeMinutes !== undefined && act.waitingTimeMinutes > 0 && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#FCFBF7] border border-[#252B28]/12 text-[#5A645F]">
                                <Clock className="w-3 h-3 text-[#D8AC55]" />
                                +{act.waitingTimeMinutes}m waiting buffer
                              </span>
                            )}
                            {act.distanceFromHotelKm !== undefined && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#FCFBF7] border border-[#252B28]/12 text-[#5A645F]">
                                {act.distanceFromHotelKm} km straight-line from hotel
                              </span>
                            )}
                          </div>
                        )}

                        {act.isFarFromHotel && (
                          <div className="mt-2.5 inline-flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900 bg-amber-100/80 px-3 py-1.5 rounded-lg">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-700" />
                            <span>
                              Far from {activeTrip.hotel?.name || 'hotel'} ({act.distanceFromHotelKm} km &gt; {activeTrip.maxHotelRadiusKm || 10} km).
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSwapActivityId(act.id);
                                navigate('/alternatives');
                              }}
                              className="underline font-semibold text-[#174B3A] hover:text-[#123B2D]"
                            >
                              Find closer swap
                            </button>
                          </div>
                        )}

                        {conflict && (
                          <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-100/70 px-3 py-1.5 rounded-lg">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>{conflict.message}</span>
                          </div>
                        )}
                      </div>

                      <div className="pt-4 border-t border-[#252B28]/8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-[#252B28] tabular-nums">
                          <span className="inline-flex items-center gap-1.5 font-semibold">
                            <Clock className="w-3.5 h-3.5 text-[#174B3A]" />
                            {act.startTime} – {act.endTime}
                          </span>
                          <span className="text-[#5A645F]">
                            Duration: {formatDuration(act.durationMinutes)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleOpenRefine(act)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EEF4F0] text-[#174B3A] border border-[#174B3A]/20 text-xs font-semibold hover:bg-[#174B3A] hover:text-white transition-colors whitespace-nowrap"
                          >
                            <Wand2 className="w-3.5 h-3.5" />
                            <span>Refine with AI</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSwapActivityId(act.id);
                              navigate('/alternatives');
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F8F5EC] text-[#174B3A] text-xs font-semibold hover:bg-[#efe9d8] transition-colors whitespace-nowrap"
                          >
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                            <span>Swap Alternative</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleOpenEdit(act)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#252B28]/15 text-[#252B28] text-xs font-semibold hover:bg-[#FCFBF7] transition-colors whitespace-nowrap"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => deleteActivity(act.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50 transition-colors whitespace-nowrap"
                            aria-label={`Delete ${act.title}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            {isEditingMode && <span>Delete</span>}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Quick link to Visual Drag-and-Drop Planner */}
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CalendarRange className="w-5 h-5 text-[#174B3A] shrink-0" />
            <div>
              <div className="text-sm font-semibold text-[#252B28]">
                Want to drag activities across days?
              </div>
              <div className="text-xs text-[#5A645F]">
                Use the interactive multi-day board to reorder stops, adjust time slots, and inspect timeline blocks.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/planner')}
            className="px-4 py-2.5 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] transition-colors whitespace-nowrap shrink-0"
          >
            Open Drag &amp; Drop Planner
          </button>
        </div>
      </div>

      <ActivityModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        daysCount={activeTrip.daysCount}
        defaultDay={safeDay}
        editingActivity={editingActivity}
        destination={activeTrip.destination}
        hotel={activeTrip.stayMode === 'with-hotel' ? activeTrip.hotel : null}
        commuteMode={activeTrip.commuteMode || 'DRIVING'}
        maxHotelRadiusKm={activeTrip.maxHotelRadiusKm || 10}
        waitingBufferMinutes={activeTrip.waitingBufferMinutes ?? 15}
        onSave={handleSaveModal}
      />

      {/* Single-Day AI Regeneration Modal */}
      {dayRegenOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#252B28]/15 max-w-lg w-full p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#174B3A] inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>AI Day Refinement</span>
                </div>
                <h3 className="mt-1 font-display text-xl font-semibold text-[#252B28]">
                  Regenerate Day {safeDay}
                </h3>
                <p className="mt-1 text-xs text-[#5A645F]">
                  Only Day {safeDay} stops will be refreshed. Other days, your budget cap, and logged expenses remain unchanged.
                </p>
              </div>
              <button
                type="button"
                disabled={isRegeneratingDay}
                onClick={() => setDayRegenOpen(false)}
                className="p-1.5 rounded-lg text-[#5A645F] hover:bg-[#F8F5EC]"
                aria-label="Close regenerate day dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {dayRegenError && (
              <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                {dayRegenError}
              </div>
            )}

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-2">
                  Quick Refinement Goals
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_REGEN_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setDayRegenInstruction(preset)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        dayRegenInstruction === preset
                          ? 'bg-[#174B3A] border-[#174B3A] text-white'
                          : 'bg-[#FCFBF7] border-[#252B28]/12 text-[#252B28] hover:border-[#174B3A]/40'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                  Instruction for Day {safeDay}
                </label>
                <textarea
                  rows={3}
                  value={dayRegenInstruction}
                  onChange={(e) => setDayRegenInstruction(e.target.value)}
                  placeholder="Describe what you'd like changed for this day..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                  Day Pace
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['Relaxed', 'Balanced', 'Activity-heavy'] as DayPace[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setDayRegenPace(p)}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition-colors ${
                        dayRegenPace === p
                          ? 'bg-[#174B3A] border-[#174B3A] text-white'
                          : 'bg-[#FCFBF7] border-[#252B28]/12 text-[#5A645F] hover:text-[#252B28]'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-[#252B28]/10 flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={isRegeneratingDay}
                onClick={() => setDayRegenOpen(false)}
                className="px-4 py-2 rounded-xl border border-[#252B28]/15 text-xs font-semibold text-[#252B28] hover:bg-[#F8F5EC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isRegeneratingDay}
                onClick={() => void handleConfirmDayRegen()}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60"
              >
                {isRegeneratingDay ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span>{isRegeneratingDay ? `Refreshing Day ${safeDay}...` : `Regenerate Day ${safeDay}`}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Individual Activity AI Refinement Modal */}
      {refiningTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-[#252B28]/15 max-w-lg w-full p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#174B3A] inline-flex items-center gap-1.5">
                  <Wand2 className="w-3.5 h-3.5" />
                  <span>AI Activity Refinement</span>
                </div>
                <h3 className="mt-1 font-display text-xl font-semibold text-[#252B28] truncate">
                  {refiningTarget.title}
                </h3>
                <p className="mt-1 text-xs text-[#5A645F]">
                  Day {refiningTarget.day} · {refiningTarget.startTime}–{refiningTarget.endTime} · {formatINR(refiningTarget.cost)}
                </p>
              </div>
              <button
                type="button"
                disabled={isRefiningActivity}
                onClick={() => setRefiningTarget(null)}
                className="p-1.5 rounded-lg text-[#5A645F] hover:bg-[#F8F5EC]"
                aria-label="Close refine activity dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {refineError && (
              <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                {refineError}
              </div>
            )}

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-2">
                  One-Click Refinement Presets
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {ACTIVITY_REFINE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={isRefiningActivity}
                      onClick={() => {
                        setRefineInstruction(preset);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        refineInstruction === preset
                          ? 'bg-[#174B3A] border-[#174B3A] text-white'
                          : 'bg-[#FCFBF7] border-[#252B28]/12 text-[#252B28] hover:border-[#174B3A]/40'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                  Custom Refinement Instruction
                </label>
                <textarea
                  rows={3}
                  value={refineInstruction}
                  onChange={(e) => setRefineInstruction(e.target.value)}
                  placeholder="e.g., Suggest a quieter breakfast spot nearby under ₹400..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
                />
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-[#252B28]/10 flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={isRefiningActivity}
                onClick={() => setRefiningTarget(null)}
                className="px-4 py-2 rounded-xl border border-[#252B28]/15 text-xs font-semibold text-[#252B28] hover:bg-[#F8F5EC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isRefiningActivity}
                onClick={() => void handleConfirmRefine()}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60"
              >
                {isRefiningActivity ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Wand2 className="w-3.5 h-3.5" />
                )}
                <span>{isRefiningActivity ? 'Refining Activity...' : 'Apply AI Refinement'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
};
