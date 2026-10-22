import { Injectable, signal, computed, inject } from '@angular/core';
import { PhysicsEngineService } from './physics-engine.service';
import { DataBridgeService } from './data-bridge.service';

export interface BleScanSession {
  isActive: boolean;
  durationSeconds: number;
  remainingSeconds: number;
  capturedRRIntervals: number[];
  capturedBpmSamples: number[];
  currentRMSSD: number;
  meanBpm: number;
}

export interface BleWorkoutSession {
  isActive: boolean;
  elapsedSeconds: number;
  currentBpm: number;
  maxBpm: number;
  avgBpm: number;
  accumulatedStrain: number;
  bpmSamples: number[];
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

  // Live Workout Strain session
  public readonly workoutSession = signal<BleWorkoutSession>({
    isActive: false,
    elapsedSeconds: 0,
    currentBpm: 0,
    maxBpm: 0,
    avgBpm: 0,
    accumulatedStrain: 0,
    bpmSamples: [],
  });
  private workoutTimerInterval: any = null;

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

      this.workoutSession.set({
        ...workout,
        currentBpm: bpm,
        maxBpm,
        avgBpm,
        bpmSamples: updatedSamples,
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
   * Start Live Workout Strain Tracking
   */
  public startWorkout(): void {
    if (!this.isConnected()) return;

    this.workoutSession.set({
      isActive: true,
      elapsedSeconds: 0,
      currentBpm: this.liveBpm() || 0,
      maxBpm: this.liveBpm() || 0,
      avgBpm: this.liveBpm() || 0,
      accumulatedStrain: 0,
      bpmSamples: [],
    });

    if (this.workoutTimerInterval) {
      clearInterval(this.workoutTimerInterval);
    }

    this.workoutTimerInterval = setInterval(async () => {
      const current = this.workoutSession();
      if (!current.isActive) {
        clearInterval(this.workoutTimerInterval);
        return;
      }

      const nextElapsed = current.elapsedSeconds + 1;

      // Every 10 seconds, compute strain increment
      let strain = current.accumulatedStrain;
      if (nextElapsed % 10 === 0 && current.bpmSamples.length > 0) {
        strain = this.physicsEngine.calculateAccumulatedStrain(
          current.bpmSamples,
          50, // Default resting HR
          190 // Default max HR
        );
      }

      this.workoutSession.set({
        ...current,
        elapsedSeconds: nextElapsed,
        accumulatedStrain: strain,
      });
    }, 1000);
  }

  /**
   * Stop Workout and sync accumulated strain into today's log
   */
  public async stopWorkout(saveStrain: boolean = true): Promise<number> {
    if (this.workoutTimerInterval) {
      clearInterval(this.workoutTimerInterval);
      this.workoutTimerInterval = null;
    }

    const session = this.workoutSession();
    this.workoutSession.set({ ...session, isActive: false });

    if (saveStrain && session.bpmSamples.length > 0) {
      const finalStrain = this.physicsEngine.calculateAccumulatedStrain(
        session.bpmSamples,
        50,
        190
      );
      await this.dataBridge.accumulateWorkoutStrain(finalStrain);
      return finalStrain;
    }

    return 0;
  }
}
