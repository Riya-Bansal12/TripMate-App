import {
  Activity,
  ActivityCategory,
  ActivityConflict,
  DayMetrics,
  ExpenseBucket,
  Trip,
  TripMetrics,
} from '../types/trip';

export function formatINR(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(safe);
}

export function parseTimeToMinutes(time: string): number {
  const [hStr, mStr] = (time || '09:00').split(':');
  const h = Number.parseInt(hStr, 10);
  const m = Number.parseInt(mStr, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return 540;
  return Math.max(0, Math.min(23 * 60 + 59, h * 60 + m));
}

export function minutesToTime(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function addMinutesToTime(startTime: string, durationMinutes: number): string {
  const start = parseTimeToMinutes(startTime);
  const end = Math.min(23 * 60 + 59, start + Math.max(15, durationMinutes));
  return minutesToTime(end);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} hr${h > 1 ? 's' : ''}`;
  return `${h}h ${m}m`;
}

export function mapCategoryToExpenseBucket(category: ActivityCategory): ExpenseBucket {
  switch (category) {
    case 'Food':
      return 'Food';
    case 'Transport':
      return 'Transport';
    case 'Attraction':
    case 'Culture':
      return 'Attraction';
    case 'Leisure':
    case 'Nature':
    default:
      return 'Leisure';
  }
}

export function sortActivitiesByTime(activities: Activity[]): Activity[] {
  return [...activities].sort((a, b) => {
    const diff = parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
    if (diff !== 0) return diff;
    return parseTimeToMinutes(a.endTime) - parseTimeToMinutes(b.endTime);
  });
}

export function detectDayConflicts(dayActivities: Activity[]): ActivityConflict[] {
  const sorted = sortActivitiesByTime(dayActivities);
  const conflictMap = new Map<string, { ids: Set<string>; titles: Set<string> }>();

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aStart = parseTimeToMinutes(a.startTime);
    const aEnd = parseTimeToMinutes(a.endTime);

    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const bStart = parseTimeToMinutes(b.startTime);
      const bEnd = parseTimeToMinutes(b.endTime);

      if (aStart < bEnd && bStart < aEnd) {
        if (!conflictMap.has(a.id)) {
          conflictMap.set(a.id, { ids: new Set(), titles: new Set() });
        }
        if (!conflictMap.has(b.id)) {
          conflictMap.set(b.id, { ids: new Set(), titles: new Set() });
        }
        conflictMap.get(a.id)!.ids.add(b.id);
        conflictMap.get(a.id)!.titles.add(b.title);
        conflictMap.get(b.id)!.ids.add(a.id);
        conflictMap.get(b.id)!.titles.add(a.title);
      }
    }
  }

  return Array.from(conflictMap.entries()).map(([activityId, info]) => ({
    activityId,
    conflictingWithIds: Array.from(info.ids),
    conflictingTitles: Array.from(info.titles),
    message: `Overlaps with ${Array.from(info.titles).join(', ')}`,
  }));
}

export function calculateTripMetrics(trip: Trip): TripMetrics {
  const categoryTotals: Record<ExpenseBucket, number> = {
    Food: 0,
    Attraction: 0,
    Transport: 0,
    Leisure: 0,
  };

  let totalEstimatedExpense = 0;
  let totalMinutes = 0;

  for (const act of trip.activities) {
    const cost = Number(act.cost) || 0;
    const dur = Number(act.durationMinutes) || 0;
    totalEstimatedExpense += cost;
    totalMinutes += dur;
    const bucket = mapCategoryToExpenseBucket(act.category);
    categoryTotals[bucket] += cost;
  }

  const dayMetrics: DayMetrics[] = [];
  let totalConflictsCount = 0;

  for (let d = 1; d <= trip.daysCount; d++) {
    const dayActs = trip.activities.filter((a) => a.day === d);
    const dayExpense = dayActs.reduce((sum, a) => sum + (Number(a.cost) || 0), 0);
    const dayMins = dayActs.reduce((sum, a) => sum + (Number(a.durationMinutes) || 0), 0);
    const dayTravelMins = dayActs.reduce(
      (sum, a, idx) =>
        sum +
        (idx === 0
          ? Number(a.travelFromPrevMinutes ?? a.travelFromHotelMinutes ?? 0)
          : Number(a.travelFromPrevMinutes ?? 0)),
      0
    );
    const dayWaitMins = dayActs.reduce((sum, a) => sum + (Number(a.waitingTimeMinutes) || 0), 0);
    const farawayCount = dayActs.filter((a) => Boolean(a.isFarFromHotel)).length;
    const conflicts = detectDayConflicts(dayActs);
    totalConflictsCount += conflicts.length > 0 ? Math.ceil(conflicts.length / 2) : 0;

    dayMetrics.push({
      dayNumber: d,
      activitiesCount: dayActs.length,
      totalMinutes: dayMins,
      totalHours: Math.round((dayMins / 60) * 10) / 10,
      totalTravelMinutes: dayTravelMins,
      totalWaitingMinutes: dayWaitMins,
      farawayCount,
      totalExpense: dayExpense,
      conflicts,
    });
  }

  const remainingBudget = (trip.budget.total || 0) - totalEstimatedExpense;
  const budgetUtilizationPct =
    trip.budget.total > 0
      ? Math.round((totalEstimatedExpense / trip.budget.total) * 100)
      : 0;

  return {
    totalEstimatedExpense,
    remainingBudget,
    isOverBudget: remainingBudget < 0,
    budgetUtilizationPct,
    totalActivities: trip.activities.length,
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    categoryTotals,
    dayMetrics,
    totalConflictsCount,
  };
}

export function autoResolveDayConflicts(activities: Activity[], day: number): Activity[] {
  const dayActs = sortActivitiesByTime(activities.filter((a) => a.day === day));
  const otherActs = activities.filter((a) => a.day !== day);

  let cursorMinutes = dayActs.length > 0 ? parseTimeToMinutes(dayActs[0].startTime) : 510;
  const resolved = dayActs.map((act, idx) => {
    const gapBuffer =
      idx === 0
        ? 0
        : Math.max(15, (act.travelFromPrevMinutes || 0) + (act.waitingTimeMinutes || 0));
    const startMin =
      idx === 0
        ? parseTimeToMinutes(act.startTime)
        : Math.max(parseTimeToMinutes(act.startTime), cursorMinutes + gapBuffer);
    const dur = Math.max(30, act.durationMinutes || 60);
    const endMin = Math.min(23 * 60 + 45, startMin + dur);
    cursorMinutes = endMin;

    return {
      ...act,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      durationMinutes: endMin - startMin,
    };
  });

  return [...otherActs, ...resolved];
}

export function findOverlappingActivities(
  dayActivities: Activity[],
  candidateStartMin: number,
  candidateEndMin: number,
  excludeActivityId?: string
): Activity[] {
  return dayActivities.filter((act) => {
    if (excludeActivityId && act.id === excludeActivityId) return false;
    const actStart = parseTimeToMinutes(act.startTime);
    const actEnd = parseTimeToMinutes(act.endTime);
    return candidateStartMin < actEnd && actStart < candidateEndMin;
  });
}

export function findFirstAvailableSlot(
  dayActivities: Activity[],
  durationMinutes: number,
  preferredStartMin = 9 * 60
): string | null {
  const dur = Math.max(15, durationMinutes);
  const candidates: number[] = [];

  for (let m = preferredStartMin; m <= 24 * 60 - dur; m += 30) {
    candidates.push(m);
  }
  for (let m = 7 * 60; m < preferredStartMin; m += 30) {
    if (m <= 24 * 60 - dur) candidates.push(m);
  }
  for (let m = 0; m < 7 * 60; m += 30) {
    if (m <= 24 * 60 - dur) candidates.push(m);
  }

  for (const startMin of candidates) {
    const endMin = startMin + dur;
    if (endMin > 24 * 60) continue;
    const overlaps = findOverlappingActivities(dayActivities, startMin, endMin);
    if (overlaps.length === 0) {
      return minutesToTime(startMin);
    }
  }

  return null;
}

