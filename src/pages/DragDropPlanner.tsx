import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CollisionDetection,
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  Clock,
  GripVertical,
  Loader2,
  MapPin,
  Navigation,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { ActivityModal } from '../components/ActivityModal';
import { useTripContext } from '../context/TripContext';
import { getRecommendationsAi } from '../services/aiService';
import { Activity, ActivityConflict, AlternativeActivityOption } from '../types/trip';
import { formatCommuteLabel } from '../utils/mapsConfig';
import { getAlternativesForTrip, getRecommendedActivitiesForTrip } from '../utils/itineraryGenerator';
import {
  findOverlappingActivities,
  formatDuration,
  formatINR,
  minutesToTime,
  parseTimeToMinutes,
  sortActivitiesByTime,
} from '../utils/scheduleUtils';

const HOUR_HEIGHT = 48; // 24 hours * 48px = 1152px
const SLOT_HEIGHT = HOUR_HEIGHT / 2; // 30-min granularity

const DAY_SAGE_THEME = {
  columnBg: 'bg-[#EEF4F0]',
  columnBorder: 'border-[#B5CBBF]',
  headerBg: 'bg-[#E1ECE5]',
  headerBorder: 'border-[#B5CBBF]',
  accentText: 'text-[#174B3A]',
  timelineBg: 'bg-[#FCFEFC]',
  timelineHeaderActive: 'bg-[#DCE9E1]',
  timelineHeaderIdle: 'bg-[#EEF4F0] hover:bg-[#E1ECE5]',
};

const ACTIVITY_BOX_THEMES: Record<
  Activity['category'],
  {
    cardBorder: string;
    cardHeader: string;
    timelineBlock: string;
  }
> = {
  Food: {
    cardBorder: 'border-[#DCC38D]',
    cardHeader: 'bg-[#FDF3DC] border-[#E7D19E] text-[#5C410C]',
    timelineBlock: 'bg-[#FEF6E2] border-[#CFA34B] text-[#3B2A07] hover:bg-[#FDECC4]',
  },
  Attraction: {
    cardBorder: 'border-[#AECBB9]',
    cardHeader: 'bg-[#E8F3EC] border-[#B9D6C3] text-[#174B3A]',
    timelineBlock: 'bg-[#EAF5EE] border-[#5E9C78] text-[#123828] hover:bg-[#DCEEE2]',
  },
  Culture: {
    cardBorder: 'border-[#C3B7E0]',
    cardHeader: 'bg-[#EFEBF8] border-[#CEC3E8] text-[#3F2E6B]',
    timelineBlock: 'bg-[#F1EDFA] border-[#8E7CC3] text-[#2F2152] hover:bg-[#E6DFF6]',
  },
  Transport: {
    cardBorder: 'border-[#ABC7E2]',
    cardHeader: 'bg-[#E7F1FA] border-[#B6CFE8] text-[#1A4670]',
    timelineBlock: 'bg-[#EAF3FB] border-[#5E93C7] text-[#133252] hover:bg-[#DCEAF7]',
  },
  Leisure: {
    cardBorder: 'border-[#A7D0C9]',
    cardHeader: 'bg-[#E6F4F2] border-[#B2D8D2] text-[#124E48]',
    timelineBlock: 'bg-[#E8F6F4] border-[#549E94] text-[#103A35] hover:bg-[#D8EEEB]',
  },
  Nature: {
    cardBorder: 'border-[#B4CEAA]',
    cardHeader: 'bg-[#ECF4E8] border-[#C1D8B8] text-[#224C1D]',
    timelineBlock: 'bg-[#EEF6EA] border-[#6A9E5C] text-[#193B15] hover:bg-[#E0EEDB]',
  },
};

type DragPayload =
  | { kind: 'board-activity'; activity: Activity }
  | { kind: 'timeline-activity'; activity: Activity }
  | { kind: 'recommendation'; option: AlternativeActivityOption }
  | { kind: 'alternate'; option: AlternativeActivityOption };

/* -------------------------------------------------------------------------- */
/* Left-Side Library Card (Draggable Recommendation or Alternate)             */
/* -------------------------------------------------------------------------- */

interface LibraryCardProps {
  option: AlternativeActivityOption;
  mode: 'recommendation' | 'alternate';
  selectedActivity: Activity | null;
  targetDayForQuickAdd: number;
  onQuickAdd: (opt: AlternativeActivityOption, day: number) => void;
  onQuickReplace: (targetId: string, opt: AlternativeActivityOption) => void;
}

const DraggableLibraryCard: React.FC<LibraryCardProps> = ({
  option,
  mode,
  selectedActivity,
  targetDayForQuickAdd,
  onQuickAdd,
  onQuickReplace,
}) => {
  const dragId = `${mode === 'recommendation' ? 'rec' : 'alt'}-${option.id}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: dragId,
    data: {
      kind: mode,
      option,
    },
  });

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.4 : 1,
      }
    : { opacity: isDragging ? 0.4 : 1 };

  const costDiff = selectedActivity ? option.cost - selectedActivity.cost : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-xl border border-[#252B28]/12 bg-white p-3 hover:border-[#174B3A]/45 transition-colors"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="p-1 -ml-1 mt-0.5 rounded-md text-[#5A645F] hover:text-[#174B3A] hover:bg-[#F8F5EC] cursor-grab active:cursor-grabbing shrink-0"
          aria-label={`Drag ${option.title}`}
        >
          <GripVertical className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 text-[11px] text-[#5A645F]">
            <span className="truncate">
              {option.category} · {formatDuration(option.durationMinutes)}
            </span>
            <span className="font-mono font-semibold text-[#174B3A] tabular-nums shrink-0">
              {formatINR(option.cost)}
            </span>
          </div>

          <h4 className="mt-0.5 text-xs font-semibold text-[#252B28] leading-snug">
            {option.title}
          </h4>

          <div className="mt-0.5 text-[11px] text-[#5A645F] flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">{option.location}</span>
          </div>

          {mode === 'alternate' && selectedActivity && costDiff !== 0 && (
            <div
              className={`mt-1 text-[11px] font-mono tabular-nums ${
                costDiff < 0 ? 'text-[#174B3A]' : 'text-amber-700'
              }`}
            >
              {costDiff < 0
                ? `Saves ${formatINR(Math.abs(costDiff))} vs selected`
                : `+${formatINR(costDiff)} vs selected`}
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-1.5">
            {mode === 'alternate' && selectedActivity ? (
              <button
                type="button"
                onClick={() => onQuickReplace(selectedActivity.id, option)}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#174B3A] text-white text-[11px] font-semibold hover:bg-[#123B2D] transition-colors whitespace-nowrap"
              >
                <ArrowLeftRight className="w-3 h-3" />
                <span>Replace Selected</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onQuickAdd(option, targetDayForQuickAdd)}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#F8F5EC] text-[#174B3A] border border-[#174B3A]/20 text-[11px] font-semibold hover:bg-[#174B3A] hover:text-white transition-colors whitespace-nowrap"
              >
                <Plus className="w-3 h-3" />
                <span>Add to Day {targetDayForQuickAdd}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Board Mode: Sortable Activity Card & Day Column                            */
/* -------------------------------------------------------------------------- */

interface SortableCardProps {
  activity: Activity;
  conflict?: ActivityConflict;
  isSelected: boolean;
  isDraggingAlternate: boolean;
  daysCount: number;
  onSelect: (act: Activity) => void;
  onUpdateTime: (id: string, startTime: string) => void;
  onUpdateDuration: (id: string, durationMinutes: number) => void;
  onMoveToDay: (id: string, targetDay: number) => void;
  onDelete: (id: string) => void;
}

const SortablePlannerCard: React.FC<SortableCardProps> = ({
  activity,
  conflict,
  isSelected,
  isDraggingAlternate,
  daysCount,
  onSelect,
  onUpdateTime,
  onUpdateDuration,
  onMoveToDay,
  onDelete,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: activity.id,
    data: { kind: 'board-activity', day: activity.day, activity },
  });

  const { setNodeRef: setReplaceRef, isOver: isReplaceOver } = useDroppable({
    id: `board-replace-${activity.id}`,
    disabled: !isDraggingAlternate,
    data: { kind: 'replace-target', activity },
  });

  const setCombinedRef = (node: HTMLDivElement | null) => {
    setSortableRef(node);
    setReplaceRef(node);
  };

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  const boxTheme = ACTIVITY_BOX_THEMES[activity.category] || ACTIVITY_BOX_THEMES.Attraction;

  return (
    <div
      ref={setCombinedRef}
      style={style}
      onClick={() => onSelect(activity)}
      className={`rounded-xl border bg-white overflow-hidden transition-all cursor-pointer shadow-[0_2px_6px_rgba(37,43,40,0.08)] ${
        isReplaceOver
          ? 'border-[#174B3A] ring-2 ring-[#174B3A]/40 bg-[#174B3A]/5'
          : isSelected
          ? 'border-[#174B3A] ring-2 ring-[#174B3A]/35 shadow-[0_4px_12px_rgba(23,75,58,0.14)]'
          : conflict
          ? 'border-amber-500 ring-1 ring-amber-400/50 bg-amber-50/40'
          : `${boxTheme.cardBorder} hover:border-[#174B3A]/70`
      }`}
    >
      {/* Distinct light-toned box header so start & end of each destination card are unmistakably clear */}
      <div className={`px-3 py-2 border-b flex items-center justify-between gap-2 ${boxTheme.cardHeader}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="p-0.5 -ml-0.5 rounded hover:bg-black/8 cursor-grab active:cursor-grabbing shrink-0"
            aria-label={`Drag ${activity.title}`}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] font-semibold truncate">
            {activity.category}
          </span>
          <span aria-hidden="true" className="opacity-50">·</span>
          <span className="font-mono text-[11px] font-medium tabular-nums truncate">
            {activity.startTime}–{activity.endTime}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="font-mono text-[11px] font-bold tabular-nums">
            {formatINR(activity.cost)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(activity.id);
            }}
            className="p-0.5 rounded opacity-70 hover:opacity-100 hover:text-red-700 hover:bg-red-100/70 transition-colors"
            aria-label={`Delete ${activity.title}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="p-3">
        <h4 className="text-sm font-semibold text-[#1E2421] leading-snug">
          {activity.title}
        </h4>
        <div className="text-[11px] text-[#525C57] flex items-center gap-1 truncate mt-0.5">
          <MapPin className="w-3 h-3 shrink-0 opacity-75" />
          <span className="truncate">{activity.location}</span>
        </div>

        {/* Inline Time, Duration & Move Day Controls */}
        <div
          className="mt-2.5 pt-2.5 border-t border-[#252B28]/10 grid grid-cols-3 gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <label className="block text-[10px] font-medium text-[#5A645F] mb-0.5">Start</label>
            <input
              type="time"
              value={activity.startTime}
              onChange={(e) => onUpdateTime(activity.id, e.target.value)}
              className="w-full px-1.5 py-1 rounded-lg border border-[#252B28]/18 bg-[#FCFBF7] text-[11px] font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
            />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-[#5A645F] mb-0.5">Duration</label>
            <select
              value={activity.durationMinutes}
              onChange={(e) => onUpdateDuration(activity.id, Number(e.target.value))}
              className="w-full px-1.5 py-1 rounded-lg border border-[#252B28]/18 bg-[#FCFBF7] text-[11px] font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
            >
              {[30, 45, 60, 75, 90, 120, 150, 180, 240].map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-[#5A645F] mb-0.5">Day</label>
            <select
              value={activity.day}
              onChange={(e) => onMoveToDay(activity.id, Number(e.target.value))}
              aria-label={`Move ${activity.title} to day`}
              className="w-full px-1.5 py-1 rounded-lg border border-[#252B28]/18 bg-[#FCFBF7] text-[11px] font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
            >
              {Array.from({ length: daysCount }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  Day {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-[#5A645F] tabular-nums">
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3 text-[#174B3A]" />
            {formatDuration(activity.durationMinutes)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(activity);
            }}
            className="text-[11px] font-sans font-semibold text-[#174B3A] hover:underline inline-flex items-center gap-1"
          >
            <ArrowLeftRight className="w-3 h-3" />
            <span>Swap</span>
          </button>
        </div>

        {(activity.travelFromPrevMinutes !== undefined ||
          activity.travelFromHotelMinutes !== undefined ||
          activity.waitingTimeMinutes !== undefined ||
          activity.distanceFromHotelKm !== undefined) && (
          <div className="mt-2 pt-1.5 border-t border-[#252B28]/8 flex flex-wrap items-center gap-2 text-[10px] font-mono text-[#5A645F] tabular-nums">
            {(activity.travelFromPrevMinutes ?? activity.travelFromHotelMinutes) !== undefined && (
              <span className="inline-flex items-center gap-1 text-[#174B3A] font-medium">
                <Navigation className="w-2.5 h-2.5" />
                ~{activity.travelFromPrevMinutes ?? activity.travelFromHotelMinutes}m est.
              </span>
            )}
            {activity.waitingTimeMinutes !== undefined && activity.waitingTimeMinutes > 0 && (
              <span>+{activity.waitingTimeMinutes}m wait</span>
            )}
            {activity.distanceFromHotelKm !== undefined && (
              <span>{activity.distanceFromHotelKm} km</span>
            )}
          </div>
        )}

        {activity.isFarFromHotel && (
          <div className="mt-1.5 px-2 py-1 rounded-md bg-amber-100/80 text-[10px] font-semibold text-amber-900 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 shrink-0 text-amber-700" />
            <span>Far from hotel ({activity.distanceFromHotelKm} km)</span>
          </div>
        )}

        {conflict && (
          <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-100 text-[11px] font-medium text-amber-900 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{conflict.message}</span>
          </div>
        )}
      </div>
    </div>
  );
};

interface DayColumnProps {
  dayNumber: number;
  title: string;
  activities: Activity[];
  conflicts: ActivityConflict[];
  totalExpense: number;
  totalHours: number;
  daysCount: number;
  enableConflictDetection: boolean;
  isHighlightedOver: boolean;
  isDraggingAlternate: boolean;
  selectedActivityId: string | null;
  onSelectActivity: (act: Activity) => void;
  onAddToDay: (day: number) => void;
  onAutoResolve: (day: number) => void;
  onUpdateTime: (id: string, startTime: string) => void;
  onUpdateDuration: (id: string, durationMinutes: number) => void;
  onMoveToDay: (id: string, targetDay: number) => void;
  onDelete: (id: string) => void;
}

const DayColumn: React.FC<DayColumnProps> = ({
  dayNumber,
  title,
  activities,
  conflicts,
  totalExpense,
  totalHours,
  daysCount,
  enableConflictDetection,
  isHighlightedOver,
  isDraggingAlternate,
  selectedActivityId,
  onSelectActivity,
  onAddToDay,
  onAutoResolve,
  onUpdateTime,
  onUpdateDuration,
  onMoveToDay,
  onDelete,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `day-col-${dayNumber}`,
    data: { kind: 'day-column', day: dayNumber },
  });

  const conflictMap = new Map(conflicts.map((c) => [c.activityId, c]));
  const hasConflicts = enableConflictDetection && conflicts.length > 0;
  const activeHighlight = isOver || isHighlightedOver;
  const dayTheme = DAY_SAGE_THEME;

  return (
    <div
      ref={setNodeRef}
      className={`w-[300px] sm:w-[320px] shrink-0 rounded-2xl border flex flex-col transition-colors shadow-[0_1px_4px_rgba(37,43,40,0.06)] ${
        activeHighlight
          ? 'bg-[#174B3A]/10 border-[#174B3A] ring-2 ring-[#174B3A]/25'
          : `${dayTheme.columnBg} ${dayTheme.columnBorder}`
      }`}
    >
      <div className={`p-4 border-b ${dayTheme.headerBorder} ${dayTheme.headerBg} rounded-t-2xl`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className={`text-[11px] font-mono font-bold tracking-wide ${dayTheme.accentText}`}>
              DAY {dayNumber}
            </div>
            <h3 className="font-display text-base font-semibold text-[#1E2421] truncate max-w-[200px]">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onAddToDay(dayNumber)}
            className={`p-1.5 rounded-lg bg-white/85 border border-black/10 ${dayTheme.accentText} hover:bg-[#174B3A] hover:text-white transition-colors`}
            aria-label={`Add activity to Day ${dayNumber}`}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-2.5 flex items-center justify-between text-xs font-mono text-[#4A544F] tabular-nums">
          <span>
            {activities.length} stops · {totalHours}h
          </span>
          <span className={`font-semibold ${dayTheme.accentText}`}>{formatINR(totalExpense)}</span>
        </div>

        {hasConflicts && (
          <div className="mt-2.5 pt-2.5 border-t border-black/10 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-amber-900 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              Time overlap
            </span>
            <button
              type="button"
              onClick={() => onAutoResolve(dayNumber)}
              className="text-[11px] font-semibold text-[#174B3A] hover:underline inline-flex items-center gap-1"
            >
              <Wand2 className="w-3 h-3" />
              <span>Auto-Fix</span>
            </button>
          </div>
        )}
      </div>

      <div className="p-3.5 space-y-3.5 flex-1 min-h-[280px]">
        <SortableContext
          id={`day-sortable-${dayNumber}`}
          items={activities.map((a) => a.id)}
          strategy={verticalListSortingStrategy}
        >
          {activities.length === 0 ? (
            <div className="h-44 rounded-xl border border-dashed border-[#252B28]/20 flex flex-col items-center justify-center text-center p-4 text-xs text-[#5A645F]">
              <p>Drop an activity or recommendation here for Day {dayNumber}.</p>
            </div>
          ) : (
            activities.map((act) => (
              <SortablePlannerCard
                key={act.id}
                activity={act}
                conflict={enableConflictDetection ? conflictMap.get(act.id) : undefined}
                isSelected={selectedActivityId === act.id}
                isDraggingAlternate={isDraggingAlternate}
                daysCount={daysCount}
                onSelect={onSelectActivity}
                onUpdateTime={onUpdateTime}
                onUpdateDuration={onUpdateDuration}
                onMoveToDay={onMoveToDay}
                onDelete={onDelete}
              />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Timeline Mode (24-Hour Day-Wise Grid with Non-Overlapping DnD)             */
/* -------------------------------------------------------------------------- */

interface TimelineSlotProps {
  day: number;
  hour: number;
  minute: number;
}

const TimelineDroppableSlot: React.FC<TimelineSlotProps> = ({ day, hour, minute }) => {
  const { setNodeRef } = useDroppable({
    id: `slot-${day}-${hour}-${minute}`,
    data: { kind: 'timeline-slot', day, hour, minute },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ height: `${SLOT_HEIGHT}px` }}
      className={`w-full ${
        minute === 0 ? 'border-t border-[#D8D4C7]' : 'border-t border-dashed border-[#E6E3D9]'
      }`}
    />
  );
};

interface TimelineActivityBlockProps {
  activity: Activity;
  isSelected: boolean;
  isDraggingAny: boolean;
  isDraggingAlternate: boolean;
  hasConflict: boolean;
  onSelect: (act: Activity) => void;
  onDelete: (id: string) => void;
}

const TimelineActivityBlock: React.FC<TimelineActivityBlockProps> = ({
  activity,
  isSelected,
  isDraggingAny,
  isDraggingAlternate,
  hasConflict,
  onSelect,
  onDelete,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `tl-act-${activity.id}`,
    data: { kind: 'timeline-activity', activity },
  });

  const { setNodeRef: setReplaceRef, isOver: isReplaceOver } = useDroppable({
    id: `tl-replace-${activity.id}`,
    disabled: !isDraggingAlternate,
    data: { kind: 'replace-target', activity },
  });

  const setCombinedRef = (node: HTMLDivElement | null) => {
    setDragRef(node);
    setReplaceRef(node);
  };

  const startMin = parseTimeToMinutes(activity.startTime);
  const endMin = parseTimeToMinutes(activity.endTime);
  const durMin = Math.max(30, endMin - startMin);
  const topPx = (startMin / 60) * HOUR_HEIGHT + 1;
  const heightPx = Math.max(26, (durMin / 60) * HOUR_HEIGHT - 4);
  const isCompact = heightPx < 46;
  const boxTheme = ACTIVITY_BOX_THEMES[activity.category] || ACTIVITY_BOX_THEMES.Attraction;

  const style: React.CSSProperties = {
    top: `${topPx}px`,
    height: `${heightPx}px`,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.35 : 1,
    pointerEvents: isDraggingAny && !isDraggingAlternate ? 'none' : 'auto',
  };

  return (
    <div
      ref={setCombinedRef}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(activity);
      }}
      className={`absolute left-2 right-2 rounded-lg px-2.5 py-1 border text-left transition-colors z-10 flex flex-col justify-between overflow-hidden cursor-pointer shadow-[0_1px_3px_rgba(37,43,40,0.1)] ${
        isReplaceOver
          ? 'bg-[#FDECC4] border-[#174B3A] ring-2 ring-[#174B3A] text-[#1E2421]'
          : hasConflict
          ? 'bg-red-50 border-red-400 text-red-950'
          : isSelected
          ? `${boxTheme.timelineBlock} ring-2 ring-[#174B3A] border-[#174B3A] shadow-md`
          : boxTheme.timelineBlock
      }`}
      title={`${activity.title} (${activity.startTime}–${activity.endTime}) · ${formatINR(activity.cost)}`}
    >
      <div className="flex items-start justify-between gap-1 min-w-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="p-0.5 rounded hover:bg-black/8 cursor-grab active:cursor-grabbing shrink-0"
            aria-label={`Drag ${activity.title} on timeline`}
          >
            <GripVertical className="w-3 h-3" />
          </button>
          <span className="text-[11px] font-semibold truncate">{activity.title}</span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(activity.id);
          }}
          className="p-0.5 rounded opacity-70 hover:opacity-100 hover:bg-black/10 shrink-0"
          aria-label={`Remove ${activity.title}`}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {!isCompact && (
        <div className="flex items-center justify-between gap-1 text-[10px] font-mono opacity-85 tabular-nums">
          <span className="truncate">
            {activity.category} · {activity.startTime}–{activity.endTime}
          </span>
          <span className="shrink-0 font-semibold">{formatINR(activity.cost)}</span>
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Main Planner Component                                                     */
/* -------------------------------------------------------------------------- */

export const DragDropPlanner: React.FC = () => {
  const {
    activeTrip,
    activeTripMetrics,
    moveOrReorderActivity,
    scheduleActivityAtSlot,
    addRecommendedAtSlot,
    replaceActivityWithAlternative,
    updateActivity,
    deleteActivity,
    addActivity,
    autoResolveDay,
    settings,
  } = useTripContext();

  const [viewMode, setViewMode] = useState<'board' | 'timeline'>('board');
  const [libraryTab, setLibraryTab] = useState<'recommendations' | 'alternates'>('recommendations');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [focusedDay, setFocusedDay] = useState(1);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);

  const [activeDrag, setActiveDrag] = useState<DragPayload | null>(null);
  const [boardHoverDay, setBoardHoverDay] = useState<number | null>(null);
  const [timelineHoverSlot, setTimelineHoverSlot] = useState<{
    day: number;
    hour: number;
    minute: number;
  } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalDay, setModalDay] = useState(1);
  const [aiLibraryPicks, setAiLibraryPicks] = useState<AlternativeActivityOption[]>([]);
  const [aiLibraryLoading, setAiLibraryLoading] = useState(false);
  const [aiLibraryError, setAiLibraryError] = useState<string | null>(null);

  const timelineScrollRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Scroll 24h timeline to 07:00 when entering timeline view
  useEffect(() => {
    if (viewMode === 'timeline' && timelineScrollRef.current) {
      timelineScrollRef.current.scrollTop = 7 * HOUR_HEIGHT - 12;
    }
  }, [viewMode]);

  const selectedActivity = useMemo(() => {
    if (!activeTrip || activeTrip.activities.length === 0) return null;
    if (selectedActivityId) {
      const found = activeTrip.activities.find((a) => a.id === selectedActivityId);
      if (found) return found;
    }
    const dayAct = activeTrip.activities.find((a) => a.day === focusedDay);
    return dayAct || activeTrip.activities[0];
  }, [activeTrip, selectedActivityId, focusedDay]);

  const recommendedList = useMemo(() => {
    if (!activeTrip) return [];
    const base = getRecommendedActivitiesForTrip(activeTrip);
    const existingSet = new Set(activeTrip.activities.map((a) => a.title.trim().toLowerCase()));
    const combined = [
      ...aiLibraryPicks.filter((p) => !existingSet.has(p.title.trim().toLowerCase())),
      ...base,
    ];
    const seen = new Set<string>();
    const deduped = combined.filter((item) => {
      const k = item.title.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const q = libraryQuery.trim().toLowerCase();
    if (!q) return deduped;
    return deduped.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q)
    );
  }, [activeTrip, aiLibraryPicks, libraryQuery]);

  const alternatesList = useMemo(() => {
    if (!activeTrip) return [];
    const base = getAlternativesForTrip(activeTrip.destination);
    const combined = [...aiLibraryPicks, ...base];
    const q = libraryQuery.trim().toLowerCase();
    const filtered = !q
      ? combined
      : combined.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q) ||
            item.location.toLowerCase().includes(q)
        );
    // Filter out exact same title as currently selected activity
    return selectedActivity
      ? filtered.filter((a) => a.title.toLowerCase() !== selectedActivity.title.toLowerCase())
      : filtered;
  }, [activeTrip, aiLibraryPicks, libraryQuery, selectedActivity]);

  const handleLoadAiPicks = async () => {
    if (!activeTrip || aiLibraryLoading) return;
    setAiLibraryError(null);
    setAiLibraryLoading(true);
    try {
      const { data } = await getRecommendationsAi({
        destination: activeTrip.destination,
        category: libraryTab === 'alternates' && selectedActivity ? 'alternatives' : 'activities',
        daysCount: activeTrip.daysCount,
        adults: activeTrip.adults,
        children: activeTrip.children,
        travelStyle: activeTrip.travelStyle,
        budgetTotal: activeTrip.budget.total,
        interests: activeTrip.generalNotes,
        existingTitles: activeTrip.activities.map((a) => a.title),
        excludeTitles: aiLibraryPicks.map((p) => p.title),
        stayMode: activeTrip.stayMode || 'without-hotel',
        hotel: activeTrip.hotel || null,
        targetActivity:
          libraryTab === 'alternates' && selectedActivity
            ? {
                id: selectedActivity.id,
                title: selectedActivity.title,
                category: selectedActivity.category,
                location: selectedActivity.location,
                durationMinutes: selectedActivity.durationMinutes,
                cost: selectedActivity.cost,
              }
            : undefined,
      });

      const mapped: AlternativeActivityOption[] = data.recommendations.map((item) => ({
        id: item.id,
        title: item.name,
        description: item.shortExplanation,
        category: item.category,
        location: item.locationHint,
        imageUrl: item.imageUrl,
        durationMinutes: item.suggestedDurationMinutes,
        cost: item.estimatedCostMid,
        isChildFriendly: item.isChildFriendly,
        crowdLevel: item.crowdLevel,
        tags: item.tags,
      }));
      setAiLibraryPicks((prev) => {
        const seen = new Set(prev.map((p) => p.title.trim().toLowerCase()));
        return [...mapped.filter((m) => !seen.has(m.title.trim().toLowerCase())), ...prev];
      });
    } catch (err) {
      setAiLibraryError(
        err instanceof Error ? err.message : 'Unable to fetch AI suggestions right now.'
      );
    } finally {
      setAiLibraryLoading(false);
    }
  };

  const collisionDetection: CollisionDetection = (args) => {
    const pointerHits = pointerWithin(args);

    if (viewMode === 'timeline') {
      if (activeDrag?.kind === 'alternate') {
        const replaceHit = pointerHits.find((h) => String(h.id).startsWith('tl-replace-'));
        if (replaceHit) return [replaceHit];
      }
      const slotHits = pointerHits.filter((h) => String(h.id).startsWith('slot-'));
      if (slotHits.length > 0) return slotHits;
      return rectIntersection(args).filter((h) => String(h.id).startsWith('slot-'));
    }

    // Board view
    if (activeDrag?.kind === 'alternate') {
      const replaceHit = pointerHits.find((h) => String(h.id).startsWith('board-replace-'));
      if (replaceHit) return [replaceHit];
    }

    const cardHit = pointerHits.find(
      (h) => !String(h.id).startsWith('day-col-') && !String(h.id).startsWith('board-replace-')
    );
    if (cardHit) return [cardHit];

    const colHit = pointerHits.find((h) => String(h.id).startsWith('day-col-'));
    if (colHit) return [colHit];

    return closestCorners(args);
  };

  if (!activeTrip || !activeTripMetrics) {
    return (
      <AppLayout title="Interactive Drag-and-Drop Planner">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-10 text-center text-sm text-[#5A645F]">
          Create or select a trip to use the drag-and-drop planner.
        </div>
      </AppLayout>
    );
  }

  const handleSelectActivity = (act: Activity) => {
    setSelectedActivityId(act.id);
    setFocusedDay(act.day);
    setLibraryTab('alternates');
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragPayload | undefined;
    if (data) {
      setActiveDrag(data);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setBoardHoverDay(null);
      setTimelineHoverSlot(null);
      return;
    }

    const overId = String(over.id);
    const overData = over.data.current as
      | { kind?: string; day?: number; hour?: number; minute?: number }
      | undefined;

    if (viewMode === 'board') {
      if (overId.startsWith('day-col-')) {
        setBoardHoverDay(Number(overId.replace('day-col-', '')));
      } else if (overData?.day) {
        setBoardHoverDay(overData.day);
      } else {
        setBoardHoverDay(null);
      }
      return;
    }

    if (viewMode === 'timeline' && overData?.kind === 'timeline-slot') {
      setTimelineHoverSlot({
        day: Number(overData.day),
        hour: Number(overData.hour),
        minute: Number(overData.minute),
      });
    } else {
      setTimelineHoverSlot(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const payload = active.data.current as DragPayload | undefined;

    setActiveDrag(null);
    setBoardHoverDay(null);
    setTimelineHoverSlot(null);

    if (!over || !payload) return;

    const overId = String(over.id);
    const overData = over.data.current as
      | { kind?: string; day?: number; hour?: number; minute?: number; activity?: Activity }
      | undefined;

    // 1. Replacement target (dropping an alternate onto an existing activity card/block)
    if (
      (overId.startsWith('tl-replace-') || overId.startsWith('board-replace-')) &&
      overData?.activity &&
      payload.kind === 'alternate'
    ) {
      replaceActivityWithAlternative(overData.activity.id, payload.option, {
        preventOverlap: true,
      });
      setSelectedActivityId(overData.activity.id);
      return;
    }

    // 2. Timeline Visualization Drops (24h slot grid)
    if (viewMode === 'timeline' && overData?.kind === 'timeline-slot') {
      const targetDay = Number(overData.day);
      const startTime = `${String(overData.hour).padStart(2, '0')}:${String(overData.minute).padStart(2, '0')}`;

      if (payload.kind === 'timeline-activity') {
        scheduleActivityAtSlot(payload.activity.id, targetDay, startTime);
      } else if (payload.kind === 'recommendation' || payload.kind === 'alternate') {
        addRecommendedAtSlot(payload.option, targetDay, startTime);
      }
      return;
    }

    // 3. Day Columns View Drops
    let targetDay: number | null = null;
    let targetIndex: number | undefined = undefined;

    if (overId.startsWith('day-col-')) {
      targetDay = Number(overId.replace('day-col-', ''));
    } else {
      const overAct = activeTrip.activities.find((a) => a.id === overId);
      if (overAct) {
        targetDay = overAct.day;
        const excludeId = payload.kind === 'board-activity' ? payload.activity.id : undefined;
        const fullTargetDayActs = sortActivitiesByTime(
          activeTrip.activities.filter((a) => a.day === targetDay)
        );
        const origActiveIdx = excludeId
          ? fullTargetDayActs.findIndex((a) => a.id === excludeId)
          : -1;
        const origOverIdx = fullTargetDayActs.findIndex((a) => a.id === overId);

        const targetDayActs = excludeId
          ? fullTargetDayActs.filter((a) => a.id !== excludeId)
          : fullTargetDayActs;
        const idx = targetDayActs.findIndex((a) => a.id === overId);

        if (idx >= 0) {
          const isMovingDownSameDay = origActiveIdx >= 0 && origOverIdx > origActiveIdx;
          targetIndex = isMovingDownSameDay ? idx + 1 : idx;
        }
      }
    }

    if (targetDay === null) return;

    if (payload.kind === 'board-activity') {
      if (String(active.id) === overId) return;
      moveOrReorderActivity(payload.activity.id, targetDay, targetIndex);
    } else if (payload.kind === 'recommendation' || payload.kind === 'alternate') {
      addRecommendedAtSlot(payload.option, targetDay);
    }
  };

  // Compute live ghost preview & overlap validation for Timeline drag-over
  const timelinePreview = useMemo(() => {
    if (!timelineHoverSlot || !activeDrag) return null;
    const duration =
      activeDrag.kind === 'timeline-activity'
        ? Math.max(15, activeDrag.activity.durationMinutes || 60)
        : activeDrag.kind === 'recommendation' || activeDrag.kind === 'alternate'
        ? Math.max(15, activeDrag.option.durationMinutes || 60)
        : 60;

    const startMin = timelineHoverSlot.hour * 60 + timelineHoverSlot.minute;
    const endMin = startMin + duration;
    const excludeId =
      activeDrag.kind === 'timeline-activity' ? activeDrag.activity.id : undefined;

    const dayActs = activeTrip.activities.filter((a) => a.day === timelineHoverSlot.day);
    const conflicts = findOverlappingActivities(dayActs, startMin, endMin, excludeId);
    const outOfBounds = endMin > 24 * 60;
    const isBlocked = outOfBounds || conflicts.length > 0;

    return {
      day: timelineHoverSlot.day,
      startMin,
      duration,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(Math.min(24 * 60 - 1, endMin)),
      isBlocked,
      reason: outOfBounds
        ? 'Extends past 24:00'
        : conflicts.length > 0
        ? `Overlaps ${conflicts[0].title}`
        : 'Available slot',
    };
  }, [timelineHoverSlot, activeDrag, activeTrip.activities]);

  const handleOpenAddForDay = (day: number) => {
    setModalDay(day);
    setModalOpen(true);
  };

  const jumpTimelineToHour = (hour: number) => {
    if (timelineScrollRef.current) {
      timelineScrollRef.current.scrollTo({
        top: Math.max(0, hour * HOUR_HEIGHT - 12),
        behavior: 'smooth',
      });
    }
  };

  const isDraggingAlternate = activeDrag?.kind === 'alternate';

  return (
    <AppLayout
      title="Interactive Drag-and-Drop Planner"
      subtitle={`Drag activities across days, add recommendations, or schedule on the 24-hour timeline for ${activeTrip.name}`}
    >
      <div className="space-y-5">
        {/* Top Controls & Mode Switch */}
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-xs text-[#5A645F] flex-wrap">
            <span className="font-semibold text-[#252B28]">
              {activeTrip.activities.length} total activities
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono font-semibold text-[#174B3A] tabular-nums">
              Trip Total: {formatINR(activeTripMetrics.totalEstimatedExpense)}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-mono tabular-nums ${
                activeTripMetrics.isOverBudget ? 'text-red-700 font-semibold' : 'text-[#5A645F]'
              }`}
            >
              {activeTripMetrics.isOverBudget
                ? `Over budget by ${formatINR(Math.abs(activeTripMetrics.remainingBudget))}`
                : `${formatINR(activeTripMetrics.remainingBudget)} remaining`}
            </span>
            {activeTrip.stayMode === 'with-hotel' && activeTrip.hotel && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-medium text-[#174B3A]">
                  <Building2 className="w-3.5 h-3.5" />
                  {activeTrip.hotel.name} ({formatCommuteLabel(activeTrip.commuteMode || 'DRIVING')})
                </span>
              </>
            )}
            {activeTripMetrics.totalConflictsCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-700 font-semibold inline-flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {activeTripMetrics.totalConflictsCount} overlap(s)
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#F8F5EC] border border-[#252B28]/10">
              <button
                type="button"
                onClick={() => setViewMode('board')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  viewMode === 'board' ? 'bg-white text-[#174B3A] shadow-sm' : 'text-[#5A645F]'
                }`}
              >
                Day Columns
              </button>
              <button
                type="button"
                onClick={() => setViewMode('timeline')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  viewMode === 'timeline' ? 'bg-white text-[#174B3A] shadow-sm' : 'text-[#5A645F]'
                }`}
              >
                Timeline Visualization (24h)
              </button>
            </div>

            <button
              type="button"
              onClick={() => handleOpenAddForDay(focusedDay)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Activity</span>
            </button>
          </div>
        </div>

        {/* Main 2-Zone DndContext: Left Recommendations/Alternates + Right Columns/24h Timeline */}
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setActiveDrag(null);
            setBoardHoverDay(null);
            setTimelineHoverSlot(null);
          }}
        >
          <div className="flex flex-col lg:flex-row gap-5 items-start">
            {/* Left Side Panel: Additional Recommendations & Alternates */}
            <aside className="w-full lg:w-[310px] shrink-0 bg-[#F8F5EC]/85 rounded-2xl border border-[#252B28]/10 p-4 lg:sticky lg:top-20">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-1.5 text-[#174B3A]">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <h2 className="font-display text-base font-semibold text-[#252B28]">
                    Activity Library
                  </h2>
                </div>
                <select
                  value={focusedDay}
                  onChange={(e) => setFocusedDay(Number(e.target.value))}
                  aria-label="Target day for quick add"
                  className="px-2 py-1 rounded-lg border border-[#252B28]/15 bg-white text-[11px] font-mono font-semibold text-[#174B3A]"
                >
                  {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      Day {d}
                    </option>
                  ))}
                </select>
              </div>

              {/* Tabs: Recommendations vs Alternates */}
              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-white border border-[#252B28]/10 mb-3">
                <button
                  type="button"
                  onClick={() => setLibraryTab('recommendations')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    libraryTab === 'recommendations'
                      ? 'bg-[#174B3A] text-white'
                      : 'text-[#5A645F] hover:text-[#252B28]'
                  }`}
                >
                  Recommended ({recommendedList.length})
                </button>
                <button
                  type="button"
                  onClick={() => setLibraryTab('alternates')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    libraryTab === 'alternates'
                      ? 'bg-[#174B3A] text-white'
                      : 'text-[#5A645F] hover:text-[#252B28]'
                  }`}
                >
                  Alternates ({alternatesList.length})
                </button>
              </div>

              {/* Search box */}
              <div className="relative mb-3">
                <Search className="w-3.5 h-3.5 text-[#5A645F] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={libraryQuery}
                  onChange={(e) => setLibraryQuery(e.target.value)}
                  placeholder="Filter by title or category..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-[#252B28]/15 bg-white text-xs focus:outline-none focus:border-[#174B3A]"
                />
              </div>

              {libraryTab === 'alternates' && (
                <div className="mb-3 p-2.5 rounded-xl bg-white border border-[#252B28]/10">
                  <label className="block text-[10px] font-semibold text-[#5A645F] mb-1">
                    Replacing Activity
                  </label>
                  {activeTrip.activities.length > 0 ? (
                    <select
                      value={selectedActivity?.id || ''}
                      onChange={(e) => {
                        const found = activeTrip.activities.find((a) => a.id === e.target.value);
                        if (found) {
                          setSelectedActivityId(found.id);
                          setFocusedDay(found.day);
                        }
                      }}
                      className="w-full px-2 py-1.5 rounded-lg border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-medium text-[#252B28] focus:outline-none focus:border-[#174B3A]"
                    >
                      {sortActivitiesByTime(activeTrip.activities)
                        .sort((a, b) => a.day - b.day)
                        .map((act) => (
                          <option key={act.id} value={act.id}>
                            Day {act.day} ({act.startTime}): {act.title}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="text-xs text-[#5A645F]">No scheduled activities yet.</div>
                  )}
                  <p className="mt-1.5 text-[11px] text-[#5A645F] leading-snug">
                    Drag onto an activity card to swap, or drop onto a free slot. Overlaps are automatically blocked.
                  </p>
                </div>
              )}

              <div className="mb-3 space-y-2">
                <button
                  type="button"
                  disabled={aiLibraryLoading}
                  onClick={() => void handleLoadAiPicks()}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60 transition-colors"
                >
                  {aiLibraryLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {aiLibraryLoading
                      ? 'Fetching AI Picks...'
                      : libraryTab === 'alternates'
                      ? 'Fetch AI Alternates'
                      : 'Fetch AI Recommendations'}
                  </span>
                </button>
                {aiLibraryError && (
                  <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-700">
                    {aiLibraryError}
                  </div>
                )}
              </div>

              {libraryTab === 'recommendations' && (
                <p className="mb-3 text-[11px] text-[#5A645F] leading-snug">
                  Drag any activity into a Day Column or Timeline hour slot. Totals update automatically.
                </p>
              )}

              <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1 planner-scroll">
                {libraryTab === 'recommendations' ? (
                  recommendedList.length === 0 ? (
                    <div className="p-5 rounded-xl bg-white border border-[#252B28]/10 text-center text-xs text-[#5A645F]">
                      All curated activities for {activeTrip.destination} are already in your itinerary or match your filter.
                    </div>
                  ) : (
                    recommendedList.map((opt) => (
                      <DraggableLibraryCard
                        key={opt.id}
                        option={opt}
                        mode="recommendation"
                        selectedActivity={selectedActivity}
                        targetDayForQuickAdd={focusedDay}
                        onQuickAdd={(item, day) => addRecommendedAtSlot(item, day)}
                        onQuickReplace={(targetId, item) =>
                          replaceActivityWithAlternative(targetId, item, { preventOverlap: true })
                        }
                      />
                    ))
                  )
                ) : alternatesList.length === 0 ? (
                  <div className="p-5 rounded-xl bg-white border border-[#252B28]/10 text-center text-xs text-[#5A645F]">
                    No matching alternate activities found.
                  </div>
                ) : (
                  alternatesList.map((opt) => (
                    <DraggableLibraryCard
                      key={opt.id}
                      option={opt}
                      mode="alternate"
                      selectedActivity={selectedActivity}
                      targetDayForQuickAdd={focusedDay}
                      onQuickAdd={(item, day) => addRecommendedAtSlot(item, day)}
                      onQuickReplace={(targetId, item) =>
                        replaceActivityWithAlternative(targetId, item, { preventOverlap: true })
                      }
                    />
                  ))
                )}
              </div>
            </aside>

            {/* Right Main Viewport: Either Day Columns OR 24-Hour Day-Wise Timeline */}
            <div className="flex-1 min-w-0 w-full">
              {viewMode === 'board' ? (
                <div className="flex gap-4 overflow-x-auto pb-4 planner-scroll items-start">
                  {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((dayNum) => {
                    const dp = activeTrip.dayPlans.find((d) => d.dayNumber === dayNum);
                    const dm = activeTripMetrics.dayMetrics.find((m) => m.dayNumber === dayNum);
                    const dayActs = sortActivitiesByTime(
                      activeTrip.activities.filter((a) => a.day === dayNum)
                    );

                    return (
                      <DayColumn
                        key={dayNum}
                        dayNumber={dayNum}
                        title={dp?.title || `Day ${dayNum}`}
                        activities={dayActs}
                        conflicts={dm?.conflicts || []}
                        totalExpense={dm?.totalExpense || 0}
                        totalHours={dm?.totalHours || 0}
                        daysCount={activeTrip.daysCount}
                        enableConflictDetection={settings.enableConflictDetection}
                        isHighlightedOver={boardHoverDay === dayNum}
                        isDraggingAlternate={isDraggingAlternate}
                        selectedActivityId={selectedActivity?.id || null}
                        onSelectActivity={handleSelectActivity}
                        onAddToDay={handleOpenAddForDay}
                        onAutoResolve={autoResolveDay}
                        onUpdateTime={(id, startTime) => updateActivity(id, { startTime })}
                        onUpdateDuration={(id, durationMinutes) =>
                          updateActivity(id, { durationMinutes })
                        }
                        onMoveToDay={(id, targetDay) => moveOrReorderActivity(id, targetDay)}
                        onDelete={deleteActivity}
                      />
                    );
                  })}
                </div>
              ) : (
                /* 24-Hour Day-Wise Timeline Visualization */
                <div className="bg-white rounded-2xl border border-[#252B28]/10 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#252B28]/10 bg-[#FCFBF7] flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-[#5A645F]">
                      <span className="font-semibold text-[#252B28]">24-Hour Day-Wise Timeline</span>
                      <span className="mx-2" aria-hidden="true">·</span>
                      <span>Drag blocks within or across days. Overlapping time slots are blocked automatically.</span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] font-mono">
                      <span className="text-[#5A645F] mr-1">Jump to:</span>
                      {[0, 8, 12, 16, 20].map((hr) => (
                        <button
                          key={hr}
                          type="button"
                          onClick={() => jumpTimelineToHour(hr)}
                          className="px-2 py-1 rounded-md bg-white border border-[#252B28]/12 text-[#252B28] hover:border-[#174B3A] hover:text-[#174B3A] transition-colors tabular-nums"
                        >
                          {String(hr).padStart(2, '0')}:00
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="overflow-x-auto planner-scroll">
                    <div
                      style={{
                        minWidth: `${76 + activeTrip.daysCount * 220}px`,
                      }}
                    >
                      {/* Sticky Day Headers */}
                      <div
                        className="grid border-b border-[#252B28]/10 bg-white"
                        style={{
                          gridTemplateColumns: `76px repeat(${activeTrip.daysCount}, minmax(220px, 1fr))`,
                        }}
                      >
                        <div className="p-3 text-[11px] font-mono font-semibold text-[#5A645F] border-r border-[#252B28]/10 flex items-center justify-center">
                          24H
                        </div>
                        {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map(
                          (dayNum) => {
                            const dp = activeTrip.dayPlans.find((d) => d.dayNumber === dayNum);
                            const dm = activeTripMetrics.dayMetrics.find(
                              (m) => m.dayNumber === dayNum
                            );
                            const dayTheme = DAY_SAGE_THEME;
                            return (
                              <div
                                key={dayNum}
                                onClick={() => setFocusedDay(dayNum)}
                                className={`p-3 border-r border-[#C9C5B8] last:border-r-0 cursor-pointer transition-colors ${
                                  focusedDay === dayNum ? dayTheme.timelineHeaderActive : dayTheme.timelineHeaderIdle
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className={`text-xs font-mono font-bold ${dayTheme.accentText}`}>
                                    DAY {dayNum}
                                  </span>
                                  <span className="text-xs font-mono font-semibold text-[#1E2421] tabular-nums">
                                    {formatINR(dm?.totalExpense || 0)}
                                  </span>
                                </div>
                                <div className="text-xs font-medium text-[#1E2421] truncate mt-0.5">
                                  {dp?.title || `Day ${dayNum}`}
                                </div>
                                <div className="text-[11px] font-mono text-[#4A544F] tabular-nums mt-0.5">
                                  {dm?.activitiesCount || 0} stops · {dm?.totalHours || 0}h
                                </div>
                              </div>
                            );
                          }
                        )}
                      </div>

                      {/* 24-Hour Scrollable Grid */}
                      <div
                        ref={timelineScrollRef}
                        className="max-h-[680px] overflow-y-auto planner-scroll"
                      >
                        <div
                          className="grid relative"
                          style={{
                            gridTemplateColumns: `76px repeat(${activeTrip.daysCount}, minmax(220px, 1fr))`,
                            height: `${24 * HOUR_HEIGHT}px`,
                          }}
                        >
                          {/* Left Hour Axis (00:00 to 23:00) */}
                          <div className="border-r border-[#C9C5B8] bg-[#F8F6F0]">
                            {Array.from({ length: 24 }, (_, hour) => (
                              <div
                                key={hour}
                                style={{ height: `${HOUR_HEIGHT}px` }}
                                className="border-t border-[#D8D4C7] px-2 pt-1 text-[11px] font-mono text-[#4A544F] tabular-nums text-right"
                              >
                                {String(hour).padStart(2, '0')}:00
                              </div>
                            ))}
                          </div>

                          {/* Day Columns with 48 half-hour slots + Positioned Activity Blocks */}
                          {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map(
                            (dayNum) => {
                              const dayActs = sortActivitiesByTime(
                                activeTrip.activities.filter((a) => a.day === dayNum)
                              );
                              const dm = activeTripMetrics.dayMetrics.find(
                                (m) => m.dayNumber === dayNum
                              );
                              const conflictIds = new Set(
                                (dm?.conflicts || []).map((c) => c.activityId)
                              );
                              const dayTheme = DAY_SAGE_THEME;

                              return (
                                <div
                                  key={dayNum}
                                  className={`relative border-r border-[#C9C5B8] last:border-r-0 ${dayTheme.timelineBg}`}
                                >
                                  {/* 48 half-hour droppable rows */}
                                  {Array.from({ length: 24 }, (_, hour) => (
                                    <React.Fragment key={hour}>
                                      <TimelineDroppableSlot day={dayNum} hour={hour} minute={0} />
                                      <TimelineDroppableSlot day={dayNum} hour={hour} minute={30} />
                                    </React.Fragment>
                                  ))}

                                  {/* Live Drag Preview (Green = Valid, Red = Overlap Blocked) */}
                                  {timelinePreview && timelinePreview.day === dayNum && (
                                    <div
                                      style={{
                                        top: `${(timelinePreview.startMin / 60) * HOUR_HEIGHT}px`,
                                        height: `${Math.max(
                                          24,
                                          (timelinePreview.duration / 60) * HOUR_HEIGHT - 2
                                        )}px`,
                                      }}
                                      className={`absolute left-1.5 right-1.5 rounded-lg px-2 py-1 border-2 border-dashed z-20 pointer-events-none flex flex-col justify-center ${
                                        timelinePreview.isBlocked
                                          ? 'bg-red-100/90 border-red-500 text-red-900'
                                          : 'bg-[#174B3A]/15 border-[#174B3A] text-[#174B3A]'
                                      }`}
                                    >
                                      <div className="text-[11px] font-mono font-semibold truncate tabular-nums">
                                        {timelinePreview.startTime}–{timelinePreview.endTime}
                                      </div>
                                      <div className="text-[10px] font-semibold truncate">
                                        {timelinePreview.reason}
                                      </div>
                                    </div>
                                  )}

                                  {/* Scheduled Activity Blocks */}
                                  {dayActs.map((act) => (
                                    <TimelineActivityBlock
                                      key={act.id}
                                      activity={act}
                                      isSelected={selectedActivity?.id === act.id}
                                      isDraggingAny={Boolean(activeDrag)}
                                      isDraggingAlternate={isDraggingAlternate}
                                      hasConflict={
                                        settings.enableConflictDetection && conflictIds.has(act.id)
                                      }
                                      onSelect={handleSelectActivity}
                                      onDelete={deleteActivity}
                                    />
                                  ))}
                                </div>
                              );
                            }
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DragOverlay>
            {activeDrag ? (
              activeDrag.kind === 'board-activity' || activeDrag.kind === 'timeline-activity' ? (
                <div className="w-[260px] rounded-xl border-2 border-[#174B3A] bg-white p-3 shadow-2xl">
                  <div className="text-[11px] text-[#5A645F] flex justify-between">
                    <span>{activeDrag.activity.category}</span>
                    <span className="font-mono font-semibold text-[#174B3A] tabular-nums">
                      {formatINR(activeDrag.activity.cost)}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#252B28]">
                    {activeDrag.activity.title}
                  </div>
                  <div className="mt-1 text-xs font-mono text-[#5A645F] tabular-nums">
                    {activeDrag.activity.startTime} – {activeDrag.activity.endTime} (
                    {formatDuration(activeDrag.activity.durationMinutes)})
                  </div>
                </div>
              ) : (
                <div className="w-[260px] rounded-xl border-2 border-[#174B3A] bg-white p-3 shadow-2xl">
                  <div className="text-[11px] text-[#5A645F] flex justify-between">
                    <span>
                      {activeDrag.kind === 'alternate' ? 'Alternate Swap' : 'Add Activity'}
                    </span>
                    <span className="font-mono font-semibold text-[#174B3A] tabular-nums">
                      {formatINR(activeDrag.option.cost)}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#252B28]">
                    {activeDrag.option.title}
                  </div>
                  <div className="mt-1 text-xs font-mono text-[#5A645F] tabular-nums">
                    Duration: {formatDuration(activeDrag.option.durationMinutes)}
                  </div>
                </div>
              )
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <ActivityModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        daysCount={activeTrip.daysCount}
        defaultDay={modalDay}
        destination={activeTrip.destination}
        hotel={activeTrip.stayMode === 'with-hotel' ? activeTrip.hotel : null}
        commuteMode={activeTrip.commuteMode || 'DRIVING'}
        maxHotelRadiusKm={activeTrip.maxHotelRadiusKm || 10}
        waitingBufferMinutes={activeTrip.waitingBufferMinutes ?? 15}
        onSave={(payload) => {
          if (viewMode === 'timeline') {
            addRecommendedAtSlot(
              {
                id: `custom-${Date.now()}`,
                title: payload.title,
                description: payload.description,
                category: payload.category,
                location: payload.location,
                imageUrl: payload.imageUrl,
                durationMinutes: payload.durationMinutes,
                cost: payload.cost,
                isChildFriendly: true,
                crowdLevel: 'Low',
                tags: ['Similar'],
                coordinates: payload.coordinates,
                placeId: payload.placeId,
              },
              payload.day,
              payload.startTime
            );
            return;
          }
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
        }}
      />
    </AppLayout>
  );
};
