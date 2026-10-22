import { Injectable, signal, computed, inject } from '@angular/core';
import { PhysicsEngineService } from './physics-engine.service';
import { DataBridgeService } from './data-bridge.service';
import { RecordedWorkoutActivity } from '../models/biometrics.interface';

export interface SportActivityDef {
  id: string;
  name: string;
  icon: string;
  met: number;
  category: 'team' | 'strength' | 'cardio' | 'recovery';
}

export const AVAILABLE_SPORTS: SportActivityDef[] = [
  { id: 'volleyball', name: 'Volleyball', icon: '🏐', met: 6.0, category: 'team' },
  { id: 'walking', name: 'Walking', icon: '🚶', met: 3.5, category: 'cardio' },
  { id: 'strength', name: 'Strength Training', icon: '🏋️', met: 5.0, category: 'strength' },
  { id: 'running', name: 'Running', icon: '🏃', met: 9.0, category: 'cardio' },
  { id: 'cycling', name: 'Cycling', icon: '🚴', met: 7.5, category: 'cardio' },
  { id: 'hiit', name: 'HIIT / Circuit', icon: '🔥', met: 8.5, category: 'cardio' },
  { id: 'tennis', name: 'Tennis / Pickleball', icon: '🎾', met: 7.0, category: 'team' },
  { id: 'basketball', name: 'Basketball', icon: '🏀', met: 8.0, category: 'team' },
  { id: 'badminton', name: 'Badminton', icon: '🏸', met: 6.5, category: 'team' },
  { id: 'yoga', name: 'Yoga & Mobility', icon: '🧘', met: 2.5, category: 'recovery' },
  { id: 'swimming', name: 'Swimming', icon: '🏊', met: 8.0, category: 'cardio' },
  { id: 'boxing', name: 'Boxing / MMA', icon: '🥊', met: 9.5, category: 'cardio' },
];

export interface BleScanSession {
  isActive: boolean;
  durationSeconds: number;
  remainingSeconds: number;
  capturedRRIntervals: number[];
  capturedBpmSamples: number[];
  currentRMSSD: number;
  meanBpm: number;
}

export interface BleWorkoutTimelinePoint {
  timeSec: number;
  bpm: number;
  zone: 1 | 2 | 3 | 4 | 5;
}

export interface BleVagalRecoveryTest {
  isActive: boolean;
  completed: boolean;
  startingPeakBpm: number;
  currentBpm: number;
  remainingSeconds: number; // 60 -> 0
  samples: { sec: number; bpm: number }[];
  dropBpm: number;
  vagalToneGrade: 'ELITE' | 'OPTIMAL' | 'MODERATE' | 'BLUNTED';
}

export interface BleCompletedWorkoutSummary {
  sport: SportActivityDef;
  durationSeconds: number;
  avgBpm: number;
  maxBpm: number;
  accumulatedStrain: number;
  caloriesBurned: number;
  zoneSeconds: {
    z1: number;
    z2: number;
    z3: number;
    z4: number;
    z5: number;
  };
  timeline: BleWorkoutTimelinePoint[];
  recoveryDropBpm?: number;
  vagalGrade?: 'ELITE' | 'OPTIMAL' | 'MODERATE' | 'BLUNTED';
  completedAt: Date;
}

export interface BleWorkoutSession {
  isActive: boolean;
  sport: SportActivityDef;
  elapsedSeconds: number;
  currentBpm: number;
  maxBpm: number;
  avgBpm: number;
  accumulatedStrain: number;
  caloriesBurned: number;
  bpmSamples: number[];
  currentZone: 1 | 2 | 3 | 4 | 5;
  zoneSeconds: {
    z1: number;
    z2: number;
    z3: number;
    z4: number;
    z5: number;
  };
  timeline: BleWorkoutTimelinePoint[];
  recoveryTest: BleVagalRecoveryTest;
  lastSummary: BleCompletedWorkoutSummary | null;
}

@Injectable({
  providedIn: 'root',
})
export class BleHeartRateService {
  private readonly physicsEngine = inject(PhysicsEngineService);
  private readonly dataBridge = inject(DataBridgeService);

  // Bluetooth device & GATT state
  private bluetoothDevice: any = null;
  private gattServer: any = null;
  private hrCharacteristic: any = null;

  // Reactive signals
  public readonly isSupported = signal<boolean>(
    typeof navigator !== 'undefined' && 'bluetooth' in navigator
  );
  public readonly isConnecting = signal<boolean>(false);
  public readonly isConnected = signal<boolean>(false);
  public readonly deviceName = signal<string | null>(null);
  public readonly batteryLevel = signal<number | null>(null);
  public readonly liveBpm = signal<number>(0);
  public readonly lastRRIntervalMs = signal<number | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  private activeUserId = '';

  public setActiveUserId(uid: string): void {
    this.activeUserId = uid;
  }

  // Morning Readiness Scan session
  public readonly scanSession = signal<BleScanSession>({
    isActive: false,
    durationSeconds: 60,
    remainingSeconds: 60,
    capturedRRIntervals: [],
    capturedBpmSamples: [],
    currentRMSSD: 0,
    meanBpm: 0,
  });
  private scanTimerInterval: any = null;

  // Athlete biometrics for heart rate zones
  public readonly athleteAge = signal<number>(26);
  public readonly athleteMaxHr = computed(() => {
    const age = this.athleteAge();
    return Math.round(208 - (0.7 * age));
  });

  public setAthleteAge(age: number): void {
    if (age > 10 && age < 110) {
      this.athleteAge.set(age);
    }
  }

  public calculateZone(bpm: number, maxHr?: number): 1 | 2 | 3 | 4 | 5 {
    const max = maxHr || this.athleteMaxHr() || 190;
    if (max <= 0) return 1;
    const ratio = bpm / max;
    if (ratio < 0.60) return 1;
    if (ratio < 0.70) return 2;
    if (ratio < 0.80) return 3;
    if (ratio < 0.90) return 4;
    return 5;
  }

  public getZoneColor(zone: number): string {
    switch (zone) {
      case 1: return '#3B82F6'; // Electric Blue
      case 2: return '#00F5A0'; // Neon Emerald
      case 3: return '#FACC15'; // Bright Amber
      case 4: return '#FB923C'; // Vivid Orange
      case 5: return '#F43F5E'; // Neon Rose
      default: return '#71717A';
    }
  }

  public getZoneName(zone: number): string {
    switch (zone) {
      case 1: return 'Zone 1: Active Recovery';
      case 2: return 'Zone 2: Aerobic Base';
      case 3: return 'Zone 3: Aerobic Tempo';
      case 4: return 'Zone 4: Anaerobic Threshold';
      case 5: return 'Zone 5: Peak Neuromuscular';
      default: return 'Zone 1: Active Recovery';
    }
  }

  // Sport Activities Library
  public readonly availableSports = AVAILABLE_SPORTS;
  public readonly selectedSport = signal<SportActivityDef>(AVAILABLE_SPORTS[0]);

  public setSelectedSport(sport: SportActivityDef): void {
    this.selectedSport.set(sport);
  }

  // Live Workout Strain session (Digifit-style Zones + Vagal Recovery)
  public readonly workoutSession = signal<BleWorkoutSession>({
    isActive: false,
    sport: AVAILABLE_SPORTS[0],
    elapsedSeconds: 0,
    currentBpm: 0,
    maxBpm: 0,
    avgBpm: 0,
    accumulatedStrain: 0,
    caloriesBurned: 0,
    bpmSamples: [],
    currentZone: 1,
    zoneSeconds: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    timeline: [],
    recoveryTest: {
      isActive: false,
      completed: false,
      startingPeakBpm: 0,
      currentBpm: 0,
      remainingSeconds: 60,
      samples: [],
      dropBpm: 0,
      vagalToneGrade: 'OPTIMAL',
    },
    lastSummary: null,
  });
  private workoutTimerInterval: any = null;
  private recoveryTimerInterval: any = null;

  constructor() {}

  /**
   * Pair with Polar chest strap or any standard Bluetooth LE Heart Rate monitor
   */
  public async connect(): Promise<boolean> {
    this.errorMessage.set(null);

    if (!this.isSupported()) {
      this.errorMessage.set(
        'Web Bluetooth is not supported on this browser. Please use Google Chrome or Microsoft Edge on Android, Windows, Mac, or Linux.'
      );
      return false;
    }

    try {
      this.isConnecting.set(true);

      const nav = navigator as any;
      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['battery_service'],
      });

      this.bluetoothDevice = device;
      this.deviceName.set(device.name || 'Polar Heart Rate Monitor');

      device.addEventListener('gattserverdisconnected', () => {
        this.handleDisconnect();
      });

      this.gattServer = await device.gatt.connect();

      // Read Heart Rate Measurement Service
      const hrService = await this.gattServer.getPrimaryService('heart_rate');
      this.hrCharacteristic = await hrService.getCharacteristic('heart_rate_measurement');

      await this.hrCharacteristic.startNotifications();
      this.hrCharacteristic.addEventListener(
        'characteristicvaluechanged',
        (event: any) => this.handleHeartRateNotification(event)
      );

      // Attempt to read Battery Level if available
      try {
        const batteryService = await this.gattServer.getPrimaryService('battery_service');
        const batteryChar = await batteryService.getCharacteristic('battery_level');
        const batteryVal = await batteryChar.readValue();
        this.batteryLevel.set(batteryVal.getUint8(0));
      } catch {
        // Battery service is optional on some monitors
      }

      this.isConnected.set(true);
      this.isConnecting.set(false);
      return true;
    } catch (err: any) {
      console.warn('[BleHeartRate] Connection cancelled or failed:', err);
      this.isConnecting.set(false);
      this.isConnected.set(false);
      if (err.name !== 'NotFoundError') {
        this.errorMessage.set(err.message || 'Failed to connect to Bluetooth device.');
      }
      return false;
    }
  }

  /**
   * Disconnect from active Bluetooth device
   */
  public disconnect(): void {
    this.stopReadinessScan(false);
    this.stopWorkout(false);

    if (this.gattServer && this.gattServer.connected) {
      this.gattServer.disconnect();
    }
    this.handleDisconnect();
  }

  private handleDisconnect(): void {
    this.isConnected.set(false);
    this.isConnecting.set(false);
    this.deviceName.set(null);
    this.batteryLevel.set(null);
    this.liveBpm.set(0);
    this.lastRRIntervalMs.set(null);
  }

  /**
   * Parse Heart Rate Measurement according to Bluetooth SIG Specification (0x2A37)
   */
  private handleHeartRateNotification(event: any): void {
    const value: DataView = event.target.value;
    if (!value || value.byteLength === 0) return;

    const flags = value.getUint8(0);
    const is16Bit = (flags & 0x01) !== 0;
    let offset = 1;
    let bpm: number;

    if (is16Bit) {
      bpm = value.getUint16(offset, true); // Little-endian
      offset += 2;
    } else {
      bpm = value.getUint8(offset);
      offset += 1;
    }

    this.liveBpm.set(bpm);

    // Skip Energy Expended if present (bit 3)
    if ((flags & 0x08) !== 0) {
      offset += 2;
    }

    // Extract RR-Intervals (bit 4)
    const rrIntervals: number[] = [];
    if ((flags & 0x10) !== 0) {
      while (offset + 1 < value.byteLength) {
        const rawRR = value.getUint16(offset, true);
        // Units are 1/1024 second. Convert to milliseconds:
        const rrMs = (rawRR / 1024.0) * 1000.0;
        const roundedMs = Math.round(rrMs * 10) / 10;
        rrIntervals.push(roundedMs);
        this.lastRRIntervalMs.set(roundedMs);
        offset += 2;
      }
    }

    // If a Morning Readiness Scan is active, ingest RR intervals and BPM
    if (this.scanSession().isActive) {
      const session = this.scanSession();
      const updatedRRs = [...session.capturedRRIntervals, ...rrIntervals];
      const updatedBpms = [...session.capturedBpmSamples, bpm];
      const currentRMSSD = this.physicsEngine.calculateRMSSD(updatedRRs);
      const meanBpm = Math.round(
        updatedBpms.reduce((acc, curr) => acc + curr, 0) / updatedBpms.length
      );

      this.scanSession.set({
        ...session,
        capturedRRIntervals: updatedRRs,
        capturedBpmSamples: updatedBpms,
        currentRMSSD,
        meanBpm,
      });
    }

    // If a Live Workout is active, accumulate BPM samples and strain
    if (this.workoutSession().isActive) {
      const workout = this.workoutSession();
      const updatedSamples = [...workout.bpmSamples, bpm];
      const maxBpm = Math.max(workout.maxBpm, bpm);
      const avgBpm = Math.round(
        updatedSamples.reduce((acc, curr) => acc + curr, 0) / updatedSamples.length
      );
      const currentZone = this.calculateZone(bpm);

      this.workoutSession.set({
        ...workout,
        currentBpm: bpm,
        currentZone,
        maxBpm,
        avgBpm,
        bpmSamples: updatedSamples,
      });
    }

    // If a Vagal Recovery Test is active, track real-time deceleration
    if (this.workoutSession().recoveryTest.isActive) {
      const current = this.workoutSession();
      const rec = current.recoveryTest;
      const dropBpm = Math.max(0, rec.startingPeakBpm - bpm);
      let vagalToneGrade: 'ELITE' | 'OPTIMAL' | 'MODERATE' | 'BLUNTED' = 'MODERATE';
      if (dropBpm >= 35) vagalToneGrade = 'ELITE';
      else if (dropBpm >= 25) vagalToneGrade = 'OPTIMAL';
      else if (dropBpm >= 15) vagalToneGrade = 'MODERATE';
      else vagalToneGrade = 'BLUNTED';

      this.workoutSession.set({
        ...current,
        recoveryTest: {
          ...rec,
          currentBpm: bpm,
          dropBpm,
          vagalToneGrade,
        },
      });
    }
  }

  /**
   * Start 60s or 120s Morning Readiness Scan
   */
  public startReadinessScan(durationSeconds: number = 60): void {
    if (!this.isConnected()) return;

    this.scanSession.set({
      isActive: true,
      durationSeconds,
      remainingSeconds: durationSeconds,
      capturedRRIntervals: [],
      capturedBpmSamples: [],
      currentRMSSD: 0,
      meanBpm: this.liveBpm() || 60,
    });

    if (this.scanTimerInterval) {
      clearInterval(this.scanTimerInterval);
    }

    this.scanTimerInterval = setInterval(() => {
      const current = this.scanSession();
      if (!current.isActive) {
        clearInterval(this.scanTimerInterval);
        return;
      }

      const nextRemaining = current.remainingSeconds - 1;
      if (nextRemaining <= 0) {
        clearInterval(this.scanTimerInterval);
        this.completeReadinessScan();
      } else {
        this.scanSession.set({
          ...current,
          remainingSeconds: nextRemaining,
        });
      }
    }, 1000);
  }

  /**
   * Stop readiness scan prematurely
   */
  public stopReadinessScan(saveData: boolean = false): void {
    if (this.scanTimerInterval) {
      clearInterval(this.scanTimerInterval);
      this.scanTimerInterval = null;
    }

    if (saveData && this.scanSession().capturedRRIntervals.length >= 10) {
      this.completeReadinessScan();
    } else {
      this.scanSession.set({
        ...this.scanSession(),
        isActive: false,
      });
    }
  }

  /**
   * Finalize Morning Readiness Scan and persist medical-grade RMSSD into Vagus
   */
  public async completeReadinessScan(userId?: string): Promise<{ rmssd: number; rhr: number }> {
    const session = this.scanSession();
    this.scanSession.set({ ...session, isActive: false });

    const finalRMSSD = this.physicsEngine.calculateRMSSD(session.capturedRRIntervals);
    const finalRHR = session.meanBpm || this.liveBpm() || 55;
    const targetUid = userId || this.activeUserId;

    // Push into DataBridge / Firestore
    await this.dataBridge.recordReadinessScan(finalRMSSD, finalRHR, targetUid);

    return { rmssd: finalRMSSD, rhr: finalRHR };
  }

  /**
   * Start Live Workout Strain Tracking (Digifit-style Zones + Telemetry + Sport Activity)
   */
  public startWorkout(sport?: SportActivityDef): void {
    if (this.workoutTimerInterval) {
      clearInterval(this.workoutTimerInterval);
      this.workoutTimerInterval = null;
    }
    if (this.recoveryTimerInterval) {
      clearInterval(this.recoveryTimerInterval);
      this.recoveryTimerInterval = null;
    }

    const chosenSport = sport || this.selectedSport();
    this.selectedSport.set(chosenSport);

    const initBpm = this.liveBpm() || 70;
    const initZone = this.calculateZone(initBpm);

    this.workoutSession.set({
      isActive: true,
      sport: chosenSport,
      elapsedSeconds: 0,
      currentBpm: initBpm,
      maxBpm: initBpm,
      avgBpm: initBpm,
      accumulatedStrain: 0,
      caloriesBurned: 0,
      bpmSamples: [initBpm],
      currentZone: initZone,
      zoneSeconds: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
      timeline: [{ timeSec: 0, bpm: initBpm, zone: initZone }],
      recoveryTest: {
        isActive: false,
        completed: false,
        startingPeakBpm: 0,
        currentBpm: 0,
        remainingSeconds: 60,
        samples: [],
        dropBpm: 0,
        vagalToneGrade: 'OPTIMAL',
      },
      lastSummary: null,
    });

    this.workoutTimerInterval = setInterval(async () => {
      const current = this.workoutSession();
      if (!current.isActive) {
        clearInterval(this.workoutTimerInterval);
        return;
      }

      const nextElapsed = current.elapsedSeconds + 1;
      const activeBpm = this.liveBpm() || current.currentBpm || 70;
      const zone = this.calculateZone(activeBpm);

      // Accumulate zone duration
      const nextZones = { ...current.zoneSeconds };
      if (zone === 1) nextZones.z1++;
      else if (zone === 2) nextZones.z2++;
      else if (zone === 3) nextZones.z3++;
      else if (zone === 4) nextZones.z4++;
      else if (zone === 5) nextZones.z5++;

      // Downsampled timeline: capture point every 2 seconds
      const nextTimeline = [...current.timeline];
      if (nextElapsed % 2 === 0 || nextTimeline.length === 0) {
        nextTimeline.push({
          timeSec: nextElapsed,
          bpm: activeBpm,
          zone: zone,
        });
        if (nextTimeline.length > 250) {
          nextTimeline.shift();
        }
      }

      // Every 5 seconds, compute TRIMP strain & active calories
      let strain = current.accumulatedStrain;
      let calories = current.caloriesBurned;
      if (nextElapsed % 5 === 0 && current.bpmSamples.length > 0) {
        strain = this.physicsEngine.calculateAccumulatedStrain(
          current.bpmSamples,
          50,
          this.athleteMaxHr()
        );
        const durationMins = nextElapsed / 60;
        calories = Math.round(current.sport.met * 75 * (durationMins / 60));
      }

      this.workoutSession.set({
        ...current,
        elapsedSeconds: nextElapsed,
        currentBpm: activeBpm,
        currentZone: zone,
        zoneSeconds: nextZones,
        timeline: nextTimeline,
        accumulatedStrain: strain,
        caloriesBurned: calories,
      });
    }, 1000);
  }

  /**
   * Finish Workout and immediately initiate the 60s Vagal Heart Rate Recovery Test
   */
  public finishWorkoutAndStartRecoveryTest(): void {
    if (this.workoutTimerInterval) {
      clearInterval(this.workoutTimerInterval);
      this.workoutTimerInterval = null;
    }

    const session = this.workoutSession();
    if (!session.isActive) return;

    const startBpm = this.liveBpm() || session.currentBpm || session.maxBpm || 140;

    this.workoutSession.set({
      ...session,
      isActive: false,
      recoveryTest: {
        isActive: true,
        completed: false,
        startingPeakBpm: startBpm,
        currentBpm: startBpm,
        remainingSeconds: 60,
        samples: [{ sec: 0, bpm: startBpm }],
        dropBpm: 0,
        vagalToneGrade: 'OPTIMAL',
      },
    });

    if (this.recoveryTimerInterval) {
      clearInterval(this.recoveryTimerInterval);
    }

    this.recoveryTimerInterval = setInterval(() => {
      const cur = this.workoutSession();
      if (!cur.recoveryTest.isActive) {
        clearInterval(this.recoveryTimerInterval);
        return;
      }

      const nextRemaining = cur.recoveryTest.remainingSeconds - 1;
      const bpm = this.liveBpm() || cur.recoveryTest.currentBpm;
      const secElapsed = 60 - nextRemaining;
      const drop = Math.max(0, cur.recoveryTest.startingPeakBpm - bpm);

      let grade: 'ELITE' | 'OPTIMAL' | 'MODERATE' | 'BLUNTED' = 'MODERATE';
      if (drop >= 35) grade = 'ELITE';
      else if (drop >= 25) grade = 'OPTIMAL';
      else if (drop >= 15) grade = 'MODERATE';
      else grade = 'BLUNTED';

      const nextSamples = [...cur.recoveryTest.samples, { sec: secElapsed, bpm }];

      if (nextRemaining <= 0) {
        clearInterval(this.recoveryTimerInterval);
        this.completeRecoveryTestAndCommit(drop, grade);
      } else {
        this.workoutSession.set({
          ...cur,
          recoveryTest: {
            ...cur.recoveryTest,
            remainingSeconds: nextRemaining,
            currentBpm: bpm,
            dropBpm: drop,
            vagalToneGrade: grade,
            samples: nextSamples,
          },
        });
      }
    }, 1000);
  }

  /**
   * Finalize the 60s Vagal Recovery Test, compile summary, and commit strain to today's log
   */
  public async completeRecoveryTestAndCommit(
    finalDrop?: number,
    finalGrade?: 'ELITE' | 'OPTIMAL' | 'MODERATE' | 'BLUNTED'
  ): Promise<void> {
    if (this.recoveryTimerInterval) {
      clearInterval(this.recoveryTimerInterval);
      this.recoveryTimerInterval = null;
    }

    const cur = this.workoutSession();
    const drop = finalDrop !== undefined ? finalDrop : cur.recoveryTest.dropBpm;
    const grade = finalGrade || cur.recoveryTest.vagalToneGrade;

    const finalStrain = this.physicsEngine.calculateAccumulatedStrain(
      cur.bpmSamples.length > 0 ? cur.bpmSamples : [cur.avgBpm || 120],
      50,
      this.athleteMaxHr()
    );

    const sport = cur.sport || this.selectedSport();
    const durationMins = Math.max(1, Math.round(cur.elapsedSeconds / 60));
    const calories = Math.round(sport.met * 75 * (durationMins / 60));

    const activity: RecordedWorkoutActivity = {
      id: 'workout_' + Date.now(),
      sport: sport.id,
      sportName: sport.name,
      sportIcon: sport.icon,
      durationSeconds: cur.elapsedSeconds,
      avgBpm: cur.avgBpm,
      maxBpm: cur.maxBpm,
      strain: finalStrain,
      caloriesBurned: calories,
      vagalRecoveryDropBpm: drop,
      vagalToneGrade: grade,
      timestamp: new Date().toISOString(),
    };

    const summary: BleCompletedWorkoutSummary = {
      sport,
      durationSeconds: cur.elapsedSeconds,
      avgBpm: cur.avgBpm,
      maxBpm: cur.maxBpm,
      accumulatedStrain: finalStrain,
      caloriesBurned: calories,
      zoneSeconds: { ...cur.zoneSeconds },
      timeline: [...cur.timeline],
      recoveryDropBpm: drop,
      vagalGrade: grade,
      completedAt: new Date(),
    };

    this.workoutSession.set({
      ...cur,
      isActive: false,
      recoveryTest: {
        ...cur.recoveryTest,
        isActive: false,
        completed: true,
        dropBpm: drop,
        vagalToneGrade: grade,
      },
      lastSummary: summary,
    });

    await this.dataBridge.accumulateWorkoutStrain(finalStrain, this.activeUserId, activity);
  }

  /**
   * Direct stop workout without running recovery test
   */
  public async stopWorkout(saveStrain: boolean = true): Promise<number> {
    if (this.workoutTimerInterval) {
      clearInterval(this.workoutTimerInterval);
      this.workoutTimerInterval = null;
    }
    if (this.recoveryTimerInterval) {
      clearInterval(this.recoveryTimerInterval);
      this.recoveryTimerInterval = null;
    }

    const session = this.workoutSession();
    const finalStrain = this.physicsEngine.calculateAccumulatedStrain(
      session.bpmSamples.length > 0 ? session.bpmSamples : [session.avgBpm || 120],
      50,
      this.athleteMaxHr()
    );

    const sport = session.sport || this.selectedSport();
    const durationMins = Math.max(1, Math.round(session.elapsedSeconds / 60));
    const calories = Math.round(sport.met * 75 * (durationMins / 60));

    const activity: RecordedWorkoutActivity = {
      id: 'workout_' + Date.now(),
      sport: sport.id,
      sportName: sport.name,
      sportIcon: sport.icon,
      durationSeconds: session.elapsedSeconds,
      avgBpm: session.avgBpm,
      maxBpm: session.maxBpm,
      strain: finalStrain,
      caloriesBurned: calories,
      timestamp: new Date().toISOString(),
    };

    const summary: BleCompletedWorkoutSummary = {
      sport,
      durationSeconds: session.elapsedSeconds,
      avgBpm: session.avgBpm,
      maxBpm: session.maxBpm,
      accumulatedStrain: finalStrain,
      caloriesBurned: calories,
      zoneSeconds: { ...session.zoneSeconds },
      timeline: [...session.timeline],
      completedAt: new Date(),
    };

    this.workoutSession.set({
      ...session,
      isActive: false,
      lastSummary: summary,
    });

    if (saveStrain && finalStrain > 0) {
      await this.dataBridge.accumulateWorkoutStrain(finalStrain, this.activeUserId, activity);
    }
    return finalStrain;
  }

  public dismissWorkoutSummary(): void {
    const cur = this.workoutSession();
    this.workoutSession.set({
      ...cur,
      lastSummary: null,
      recoveryTest: {
        isActive: false,
        completed: false,
        startingPeakBpm: 0,
        currentBpm: 0,
        remainingSeconds: 60,
        samples: [],
        dropBpm: 0,
        vagalToneGrade: 'OPTIMAL',
      },
    });
  }
}
