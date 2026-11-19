export type TravelStyle = 'Adventure' | 'Relaxed' | 'Balanced' | 'Custom';

export type DayPace = 'Relaxed' | 'Balanced' | 'Activity-heavy';

export type StayMode = 'without-hotel' | 'with-hotel';

export type CommuteMode = 'DRIVING' | 'TRANSIT' | 'WALKING' | 'TWO_WHEELER';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface SavedAddress {
  label: string;
  formattedAddress: string;
  city?: string;
  placeId?: string;
  location?: GeoPoint;
  updatedAt: string;
}

export interface HotelInfo {
  name: string;
  formattedAddress: string;
  placeId?: string;
  location: GeoPoint;
  rating?: number;
}

export type ActivityCategory =
  | 'Food'
  | 'Attraction'
  | 'Transport'
  | 'Leisure'
  | 'Nature'
  | 'Culture';

export type ExpenseBucket = 'Food' | 'Attraction' | 'Transport' | 'Leisure';

export interface Activity {
  id: string;
  title: string;
  description: string;
  category: ActivityCategory;
  location: string;
  imageUrl: string;
  startTime: string; // HH:MM (24-hour)
  endTime: string;   // HH:MM (24-hour)
  durationMinutes: number;
  cost: number;      // INR
  day: number;       // 1-indexed
  isChildFriendly?: boolean;
  crowdLevel?: 'Low' | 'Moderate' | 'High';
  notes?: string;
  // Maps & Hotel-anchored scheduling metadata
  placeId?: string;
  coordinates?: GeoPoint;
  travelFromHotelMinutes?: number;
  travelFromPrevMinutes?: number;
  waitingTimeMinutes?: number;
  distanceFromHotelKm?: number;
  isFarFromHotel?: boolean;
  departureFromHotelTime?: string;
}

export interface DayPlan {
  dayNumber: number;
  title: string;
  pace: DayPace;
  notes: string[];
}

export interface BudgetBreakdown {
  total: number;
  daily: number;
  food: number;
  transport: number;
  attraction: number;
}

export interface ActualExpenseItem {
  id: string;
  name: string;
  amount: number;
  day: number;
  category: ExpenseBucket;
  notes?: string;
  createdAt: string;
}

export interface Trip {
  id: string;
  name: string;
  origin: string;
  destination: string;
  daysCount: number;
  adults: number;
  children: number;
  budget: BudgetBreakdown;
  travelStyle: TravelStyle;
  dayPlans: DayPlan[];
  activities: Activity[];
  actualExpenses?: ActualExpenseItem[];
  generalNotes: string[];
  stayMode?: StayMode;
  hotel?: HotelInfo | null;
  commuteMode?: CommuteMode;
  maxHotelRadiusKm?: number;
  waitingBufferMinutes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  uid: string;
  name: string;
  email: string;
  homeCity: string;
  defaultTravelStyle: TravelStyle;
  preferredNotes: string[];
  activeTripId?: string | null;
  photoURL?: string | null;
  authProvider?: string;
  rememberMe: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppSettings {
  budgetWarningThresholdPct: number; // e.g. 90
  enableConflictDetection: boolean;
  autoSortByTime: boolean;
  defaultDayStartTime: string;
}

export interface WizardDraft {
  origin: string;
  destination: string;
  daysCount: number;
  startDate?: string;
  endDate?: string;
  adults: number;
  children: number;
  budget: BudgetBreakdown;
  travelStyle: TravelStyle;
  dayPlans: DayPlan[];
  generalNotes: string[];
  accommodationPreference?: string;
  transportPreference?: string;
  accessibilityNeeds?: string;
  stayMode: StayMode;
  hotel: HotelInfo | null;
  commuteMode: CommuteMode;
  maxHotelRadiusKm: number;
  waitingBufferMinutes: number;
}

export interface ActivityConflict {
  activityId: string;
  conflictingWithIds: string[];
  conflictingTitles: string[];
  message: string;
}

export interface DayMetrics {
  dayNumber: number;
  activitiesCount: number;
  totalMinutes: number;
  totalHours: number;
  totalTravelMinutes: number;
  totalWaitingMinutes: number;
  farawayCount: number;
  totalExpense: number;
  conflicts: ActivityConflict[];
}

export interface TripMetrics {
  totalEstimatedExpense: number;
  remainingBudget: number;
  isOverBudget: boolean;
  budgetUtilizationPct: number;
  totalActivities: number;
  totalMinutes: number;
  totalHours: number;
  categoryTotals: Record<ExpenseBucket, number>;
  dayMetrics: DayMetrics[];
  totalConflictsCount: number;
}

export interface AlternativeActivityOption {
  id: string;
  title: string;
  description: string;
  category: ActivityCategory;
  location: string;
  imageUrl: string;
  durationMinutes: number;
  cost: number;
  isChildFriendly: boolean;
  crowdLevel: 'Low' | 'Moderate' | 'High';
  tags: ('Similar' | 'Lower Cost' | 'Child-Friendly' | 'Shorter Duration' | 'Different Type')[];
  coordinates?: GeoPoint;
  placeId?: string;
}

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  type: 'warning' | 'info' | 'success';
  read: boolean;
  createdAt: string;
  actionRoute?: string;
}
