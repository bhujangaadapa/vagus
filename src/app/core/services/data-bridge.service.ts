import { Injectable, inject } from '@angular/core';
import { Firestore, doc, docData, setDoc, collection, collectionData, query, orderBy } from '@angular/fire/firestore';
import { Observable, BehaviorSubject, of, from } from 'rxjs';
import { map, catchError, switchMap, tap } from 'rxjs/operators';
import { Capacitor } from '@capacitor/core';
import {
  DailyBiometricLog,
  DailyBiometrics,
  JournalHabits,
  DailyScores,
  AdvancedKPIs,
  UserPhysiologyBaseline,
  RollingDayMetric,
} from '../models/biometrics.interface';
import { PhysicsEngineService } from './physics-engine.service';

@Injectable({
  providedIn: 'root',
})
export class DataBridgeService {
  private readonly firestore = inject(Firestore);
  private readonly physicsEngine = inject(PhysicsEngineService);

  // Default baseline physiology parameters
  private readonly userBaseline: UserPhysiologyBaseline = {
    baselineRMSSD: 58.0,
    baselineRHR: 52.0,
    maxHR: 190.0,
  };

  // Local in-memory reactive cache to ensure instant reactivity and offline/fallback support
  private readonly logsSubject = new BehaviorSubject<DailyBiometricLog[]>([]);
  public readonly logs$: Observable<DailyBiometricLog[]> = this.logsSubject.asObservable();

  private readonly todayLogSubject = new BehaviorSubject<DailyBiometricLog | null>(null);
  public readonly todayLog$: Observable<DailyBiometricLog | null> = this.todayLogSubject.asObservable();

  /**
   * Request native permissions for HeartRate and SleepSession via Health Connect
   * Falls back gracefully if running in a standard web browser environment.
   */
  public async requestHealthPermissions(): Promise<{ success: boolean; granted: string[]; isNative: boolean }> {
    const isNative = Capacitor.isNativePlatform();

    if (!isNative) {
      console.info('[DataBridge] Running in browser sandbox. Native Health Connect bridged via mock telemetry generator.');
      return {
        success: true,
        granted: ['HeartRate', 'SleepSession'],
        isNative: false,
      };
    }

    try {
      // Dynamic import to avoid runtime failures on unsupported platforms
      const { HealthConnect } = await import('@capacitor-community/health-connect');
      const availability = await HealthConnect.checkAvailability();

      if (!availability.available) {
        console.warn('[DataBridge] Health Connect is unavailable on this device.');
        return { success: false, granted: [], isNative: true };
      }

      const result = await HealthConnect.requestPermissions({
        permissions: ['HeartRate', 'SleepSession'],
      });

      return {
        success: result.granted.length > 0,
        granted: result.granted,
        isNative: true,
      };
    } catch (error) {
      console.warn('[DataBridge] Health Connect permission request failed or plugin not installed:', error);
      return { success: false, granted: [], isNative: true };
    }
  }

  /**
   * Listen to real-time daily biometric logs from Firestore: users/{userId}/daily_logs
   */
  public getDailyLogs(userId: string): Observable<DailyBiometricLog[]> {
    try {
      const logsCollectionRef = collection(this.firestore, `users/${userId}/daily_logs`);
      const logsQuery = query(logsCollectionRef, orderBy('date', 'asc'));

      return (collectionData(logsQuery, { idField: 'date' }) as Observable<DailyBiometricLog[]>).pipe(
        tap((logs) => {
          if (logs && logs.length > 0) {
            this.logsSubject.next(logs);
            const todayStr = this.getFormattedDate(new Date());
            const today = logs.find((l) => l.date === todayStr) || logs[logs.length - 1];
            this.todayLogSubject.next(today);
          }
        }),
        catchError((err) => {
          console.warn('[DataBridge] Firestore sync fallback to reactive local cache:', err);
          return this.logs$;
        })
      );
    } catch (err) {
      console.warn('[DataBridge] Firestore init error, returning local cache:', err);
      return this.logs$;
    }
  }

  /**
   * Get single day's log from Firestore
   */
  public getTodayLog(userId: string, dateStr: string): Observable<DailyBiometricLog | null> {
    try {
      const docRef = doc(this.firestore, `users/${userId}/daily_logs/${dateStr}`);
      return (docData(docRef) as Observable<DailyBiometricLog | undefined>).pipe(
        map((log) => log || this.todayLogSubject.value),
        catchError(() => of(this.todayLogSubject.value))
      );
    } catch {
      return of(this.todayLogSubject.value);
    }
  }

  /**
   * Interactive Lifestyle Journal Toggle
   * Updates habits, immediately calculates physiological impact on biometrics,
   * runs recalculations through PhysicsEngineService, and commits to Firestore.
   */
  public async updateJournalHabits(
    userId: string,
    dateStr: string,
    updatedHabits: Partial<JournalHabits>
  ): Promise<DailyBiometricLog> {
    const currentList = this.logsSubject.value;
    const existingIndex = currentList.findIndex((item) => item.date === dateStr);

    let baseLog: DailyBiometricLog;
    if (existingIndex >= 0) {
      baseLog = JSON.parse(JSON.stringify(currentList[existingIndex]));
    } else if (this.todayLogSubject.value) {
      baseLog = JSON.parse(JSON.stringify(this.todayLogSubject.value));
      baseLog.date = dateStr;
    } else {
      baseLog = this.generateSyntheticDay(dateStr, 0, []);
    }

    // Merge habits
    const previousHabits = { ...baseLog.journalHabits };
    const mergedHabits: JournalHabits = {
      ...previousHabits,
      ...updatedHabits,
    };

    // Calculate physiological delta caused by habits
    // Alcohol suppresses HRV (RMSSD) by ~25% and elevates resting HR by ~5 bpm
    // Late meal elevates sleeping HR and impairs slow-wave sleep
    let adjustedRMSSD = baseLog.biometrics.overnightRMSSD;
    let adjustedRHR = baseLog.biometrics.restingHR;
    let adjustedAvgSleepHR = baseLog.biometrics.avgSleepHR;
    let adjustedDeepSleep = baseLog.biometrics.deepSleepMinutes;

    // Undo prior habit penalties before applying new ones to prevent compound drift
    if (previousHabits.drankAlcohol) {
      adjustedRMSSD /= 0.75;
      adjustedRHR -= 5;
      adjustedAvgSleepHR -= 5;
    }
    if (previousHabits.lateMeal) {
      adjustedRMSSD /= 0.88;
      adjustedAvgSleepHR -= 3;
    }
    if (previousHabits.viewedSunlight) {
      adjustedDeepSleep -= 12;
    }

    // Apply active habits
    if (mergedHabits.drankAlcohol) {
      adjustedRMSSD *= 0.75;
      adjustedRHR += 5;
      adjustedAvgSleepHR += 5;
    }
    if (mergedHabits.lateMeal) {
      adjustedRMSSD *= 0.88;
      adjustedAvgSleepHR += 3;
    }
    if (mergedHabits.viewedSunlight) {
      adjustedDeepSleep += 12;
    }

    // Round adjusted biometrics cleanly
    adjustedRMSSD = Math.max(15, Math.round(adjustedRMSSD * 10) / 10);
    adjustedRHR = Math.max(40, Math.round(adjustedRHR));
    adjustedAvgSleepHR = Math.max(42, Math.round(adjustedAvgSleepHR));
    adjustedDeepSleep = Math.max(10, Math.round(adjustedDeepSleep));

    baseLog.biometrics.overnightRMSSD = adjustedRMSSD;
    baseLog.biometrics.restingHR = adjustedRHR;
    baseLog.biometrics.avgSleepHR = adjustedAvgSleepHR;
    baseLog.biometrics.deepSleepMinutes = adjustedDeepSleep;
    baseLog.journalHabits = mergedHabits;

    // Recalculate Recovery via Physics Engine
    const recalculatedRecovery = this.physicsEngine.computeDailyRecoveryPercent(
      adjustedRMSSD,
      this.userBaseline.baselineRMSSD,
      adjustedRHR,
      this.userBaseline.baselineRHR
    );

    // Recalculate Autonomic Steering
    const recalculatedSteering = this.physicsEngine.calculateAutonomicSteering(
      adjustedRMSSD,
      adjustedRHR
    );

    // Recalculate Sleep Efficiency
    const recalculatedSleepEfficiency = this.physicsEngine.calculateSleepEfficiency(
      adjustedDeepSleep,
      baseLog.biometrics.remSleepMinutes,
      baseLog.biometrics.sleepMinutes,
      adjustedRHR,
      adjustedAvgSleepHR
    );

    baseLog.scores.calculatedRecovery = recalculatedRecovery;
    baseLog.advancedKPIs.autonomicSteeringIndex = recalculatedSteering;
    baseLog.advancedKPIs.sleepEfficiencyCoefficient = recalculatedSleepEfficiency;
    baseLog.updatedAt = new Date().toISOString();

    // Recalculate 7-day fatigue drag
    const historyLogs = currentList.filter((l) => l.date !== dateStr);
    const rolling7 = [...historyLogs.slice(-6), baseLog].map((l) => ({
      strain: l.scores.calculatedStrain,
      recovery: l.scores.calculatedRecovery,
    }));
    baseLog.advancedKPIs.cumulativeFatigueDrag = this.physicsEngine.calculateFatigueDrag(rolling7);

    // Update local cache
    const updatedList = [...currentList];
    if (existingIndex >= 0) {
      updatedList[existingIndex] = baseLog;
    } else {
      updatedList.push(baseLog);
    }
    this.logsSubject.next(updatedList);
    this.todayLogSubject.next(baseLog);

    // Persist to Firestore
    try {
      const docRef = doc(this.firestore, `users/${userId}/daily_logs/${dateStr}`);
      await setDoc(docRef, baseLog, { merge: true });
    } catch (err) {
      console.warn('[DataBridge] Firestore write bypassed, state retained in local memory:', err);
    }

    return baseLog;
  }

  /**
   * Robust Mock Fallback Generator
   * Seeds a realistic 30-day chronological timeline of biometrics directly into Firestore.
   */
  public async seed30DayHistory(userId: string): Promise<DailyBiometricLog[]> {
    const seededLogs: DailyBiometricLog[] = [];
    const now = new Date();

    for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
      const currentDate = new Date(now);
      currentDate.setDate(now.getDate() - dayOffset);
      const dateStr = this.getFormattedDate(currentDate);

      // Extract prior rolling logs for fatigue drag calculation
      const rollingLogs: RollingDayMetric[] = seededLogs.slice(-6).map((l) => ({
        date: l.date,
        strain: l.scores.calculatedStrain,
        recovery: l.scores.calculatedRecovery,
      }));

      const syntheticLog = this.generateSyntheticDay(dateStr, dayOffset, rollingLogs);
      seededLogs.push(syntheticLog);

      // Persist to Firestore
      try {
        const docRef = doc(this.firestore, `users/${userId}/daily_logs/${dateStr}`);
        await setDoc(docRef, syntheticLog);
      } catch (err) {
        // Fallback for sandboxed offline browser run
      }
    }

    this.logsSubject.next(seededLogs);
    this.todayLogSubject.next(seededLogs[seededLogs.length - 1]);
    return seededLogs;
  }

  /**
   * Helper: Generate a single physiologically realistic day with synthetic HR streams
   */
  private generateSyntheticDay(
    dateStr: string,
    dayOffset: number,
    rollingDays: RollingDayMetric[]
  ): DailyBiometricLog {
    // Oscillate biometrics realistically (simulate rest days, workout days, circadian rhythm)
    const isWeekend = dayOffset % 7 === 0 || dayOffset % 7 === 6;
    const isHardWorkoutDay = dayOffset % 3 === 0;

    // Habits distribution
    const drankAlcohol = dayOffset % 5 === 0;
    const lateMeal = dayOffset % 4 === 0;
    const viewedSunlight = dayOffset % 2 === 0;
    const caffeineAfter2PM = dayOffset % 3 === 0;

    // Physiological baseline variation
    const baseRMSSD = this.userBaseline.baselineRMSSD;
    const baseRHR = this.userBaseline.baselineRHR;

    // Simulate natural variance
    const rhrVariation = (Math.sin(dayOffset * 0.8) * 3) + (drankAlcohol ? 5 : 0) + (lateMeal ? 2 : 0);
    const restingHR = Math.round(baseRHR + rhrVariation);

    const rmssdVariation = (Math.cos(dayOffset * 0.6) * 7) - (drankAlcohol ? 14 : 0) - (lateMeal ? 5 : 0);
    const overnightRMSSD = Math.max(22, Math.round((baseRMSSD + rmssdVariation) * 10) / 10);

    const totalSleepMinutes = Math.round(420 + Math.sin(dayOffset * 1.1) * 45 - (drankAlcohol ? 35 : 0));
    const deepSleepMinutes = Math.round(totalSleepMinutes * (viewedSunlight ? 0.22 : 0.17));
    const remSleepMinutes = Math.round(totalSleepMinutes * 0.24);
    const avgSleepHR = Math.round(restingHR + 3 + (drankAlcohol ? 4 : 0));

    // Calculate Recovery % via Physics Engine
    const calculatedRecovery = this.physicsEngine.computeDailyRecoveryPercent(
      overnightRMSSD,
      this.userBaseline.baselineRMSSD,
      restingHR,
      this.userBaseline.baselineRHR
    );

    // Simulate a full day's daytime HR stream to feed Banister's TRIMP algorithm
    const heartRateSamples = this.generateSyntheticDayHRStream(restingHR, this.userBaseline.maxHR, isHardWorkoutDay);
    const calculatedStrain = this.physicsEngine.calculateAccumulatedStrain(
      heartRateSamples,
      restingHR,
      this.userBaseline.maxHR
    );

    // Calculate Autonomic Steering Index
    const autonomicSteeringIndex = this.physicsEngine.calculateAutonomicSteering(
      overnightRMSSD,
      restingHR
    );

    // Calculate Sleep Efficiency Coefficient
    const sleepEfficiencyCoefficient = this.physicsEngine.calculateSleepEfficiency(
      deepSleepMinutes,
      remSleepMinutes,
      totalSleepMinutes,
      restingHR,
      avgSleepHR
    );

    // Calculate 7-day cumulative fatigue drag
    const rollingWithToday = [
      ...rollingDays.map((r) => ({ strain: r.strain, recovery: r.recovery })),
      { strain: calculatedStrain, recovery: calculatedRecovery },
    ];
    const cumulativeFatigueDrag = this.physicsEngine.calculateFatigueDrag(rollingWithToday);

    const biometrics: DailyBiometrics = {
      overnightRMSSD,
      restingHR,
      sleepMinutes: totalSleepMinutes,
      deepSleepMinutes,
      remSleepMinutes,
      avgSleepHR,
    };

    const journalHabits: JournalHabits = {
      drankAlcohol,
      lateMeal,
      viewedSunlight,
      caffeineAfter2PM,
    };

    const scores: DailyScores = {
      calculatedRecovery,
      calculatedStrain,
    };

    const advancedKPIs: AdvancedKPIs = {
      cumulativeFatigueDrag,
      autonomicSteeringIndex,
      sleepEfficiencyCoefficient,
    };

    return {
      date: dateStr,
      biometrics,
      journalHabits,
      scores,
      advancedKPIs,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Generates a 60-sample discrete heart rate stream (e.g. 1 sample every 10-15 minutes or 1-hr training block)
   */
  private generateSyntheticDayHRStream(rhr: number, maxHR: number, isWorkoutDay: boolean): number[] {
    const samples: number[] = [];
    // 60 daytime samples
    for (let i = 0; i < 60; i++) {
      if (isWorkoutDay && i >= 20 && i <= 35) {
        // Workout block: elevated HR between 65% and 92% of MaxHR
        const intensity = 0.65 + Math.random() * 0.27;
        samples.push(Math.round(rhr + (maxHR - rhr) * intensity));
      } else {
        // Sedentary / active walking activity
        const baselineFluctuation = rhr + Math.random() * 25;
        samples.push(Math.round(baselineFluctuation));
      }
    }
    return samples;
  }

  private getFormattedDate(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
