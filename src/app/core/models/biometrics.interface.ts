/**
 * AntiGravity Biometrics Data Model
 * Strict TypeScript interfaces for Daily Telemetry, Physiological Scores,
 * and Advanced Neurological Key Performance Indicators.
 */

export interface DailyBiometrics {
  overnightRMSSD: number;      // Root Mean Square of Successive Differences in ms
  restingHR: number;           // Resting Heart Rate in bpm
  sleepMinutes: number;        // Total sleep duration in minutes
  deepSleepMinutes: number;    // Slow-wave deep sleep in minutes
  remSleepMinutes: number;     // Rapid Eye Movement sleep in minutes
  avgSleepHR: number;          // Average heart rate during nocturnal sleep in bpm
  steps: number;               // Accumulated daily footsteps from Android device sensor
}

export interface JournalHabits {
  drankAlcohol: boolean;       // Consumed alcohol within 4 hours before bedtime
  lateMeal: boolean;           // Consumed a meal within 2-3 hours before sleep
  viewedSunlight: boolean;     // Viewed early morning sunlight for circadian anchoring
  caffeineAfter2PM: boolean;   // Adenosine receptor antagonist consumed post-14:00
}

export interface DailyScores {
  calculatedRecovery: number;  // 0 - 100 percentage composite score
  calculatedStrain: number;    // 0.0 - 21.0 asymptotic logarithmic strain
}

export interface AdvancedKPIs {
  cumulativeFatigueDrag: number;       // 7-day rolling balance of strain vs recovery
  autonomicSteeringIndex: number;      // ln(RMSSD / RHR) * 10 (parasympathetic vs sympathetic dominance)
  sleepEfficiencyCoefficient: number;  // ((deep + rem) / totalBed) * (RHR / avgSleepHR)
}

export interface RecordedWorkoutActivity {
  id: string;
  sport: string;           // 'volleyball' | 'walking' | 'strength' | 'running' | ...
  sportName: string;       // e.g. 'Volleyball', 'Walking', 'Strength Training'
  sportIcon: string;       // e.g. '🏐', '🚶', '🏋️'
  durationSeconds: number; // e.g. 2400 (40 mins)
  avgBpm: number;
  maxBpm: number;
  strain: number;          // Banister TRIMP accumulated
  caloriesBurned: number;
  vagalRecoveryDropBpm?: number;
  vagalToneGrade?: string;
  timestamp: string;       // ISO 8601
}

/**
 * Canonical Firestore Daily Log Document
 * Located at: users/{userId}/daily_logs/YYYY-MM-DD
 */
export interface DailyBiometricLog {
  date: string;                // Format: YYYY-MM-DD
  biometrics: DailyBiometrics;
  journalHabits: JournalHabits;
  scores: DailyScores;
  advancedKPIs: AdvancedKPIs;
  activities?: RecordedWorkoutActivity[]; // List of recorded workouts / sports today
  updatedAt?: string;          // ISO 8601 timestamp of last calculation
}

/**
 * Historical Rolling Metric used for fatigue drag and baseline calculation
 */
export interface RollingDayMetric {
  date: string;
  strain: number;
  recovery: number;
}

/**
 * User Demographics for Personalized Physiological Calibration
 */
export interface UserDemographics {
  gender: 'male' | 'female' | 'other';
  age: number;        // in years (e.g. 26)
  weightKg: number;   // in kilograms (e.g. 75)
  heightCm: number;   // in centimeters (e.g. 180)
}

/**
 * User Biometric Baseline Profile
 */
export interface UserPhysiologyBaseline {
  baselineRMSSD: number;       // Rolling 30-day baseline RMSSD (default e.g. 55ms)
  baselineRHR: number;         // Rolling 30-day baseline resting HR (default e.g. 52bpm)
  maxHR: number;               // Physiological max heart rate (Tanaka formula or laboratory test)
}

/**
 * Ingestion sample streams
 */
export interface RawHeartRateSample {
  timestamp: string;
  bpm: number;
}

export interface RawSleepSession {
  startTime: string;
  endTime: string;
  deepSleepMinutes: number;
  remSleepMinutes: number;
  lightSleepMinutes: number;
  awakeMinutes: number;
  avgHeartRate: number;
}

/**
 * Canonical Firestore User Document
 * Located at: users/{userId}
 */
export interface UserProfileDocument {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  createdAt: string;
  lastLoginAt: string;
  demographics?: UserDemographics;
  baseline: UserPhysiologyBaseline;
  settings?: {
    dailyStepGoal: number;
    metricUnits: boolean;
  };
}
