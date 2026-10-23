import { Injectable, inject, signal, NgZone } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { CapacitorPedometer, Measurement } from '@capgo/capacitor-pedometer';
import { HealthFitness } from '@capacitor/health-fitness';
import { DataBridgeService } from './data-bridge.service';

export type SensorEngine =
  | 'IOS_CORE_MOTION'
  | 'ANDROID_HARDWARE_PEDOMETER'
  | 'MOBILE_ACCELEROMETER'
  | 'STANDBY';

@Injectable({
  providedIn: 'root',
})
export class PedometerService {
  private readonly dataBridge = inject(DataBridgeService);
  private readonly ngZone = inject(NgZone);

  // Reactive state signals
  public readonly isTracking = signal<boolean>(false);
  public readonly currentSteps = signal<number>(0);
  public readonly activeCadence = signal<number>(0); // steps per minute
  public readonly activeEngine = signal<SensorEngine>('STANDBY');
  public readonly platformLabel = signal<string>('Detecting OS...');
  public readonly statusMessage = signal<string>('Auto-syncing background steps...');
  public readonly permissionState = signal<'GRANTED' | 'PROMPT' | 'DENIED'>('PROMPT');

  // Platform flags
  public isIOS = false;
  public isAndroid = false;

  // Accelerometer gait filter variables
  private lastStepTimestamp = 0;
  private readonly minStepIntervalMs = 280; // ~214 steps/min physiological gait threshold
  private readonly stepAccelerationThreshold = 11.6; // Peak m/s^2 (gravity 9.8 + walking impulse)
  private motionListener: ((event: DeviceMotionEvent) => void) | null = null;
  private nativeListenerHandle: PluginListenerHandle | null = null;
  private recentStepTimes: number[] = [];

  // Active user / date context
  private currentUserId = '';
  private currentDateStr = new Date().toISOString().slice(0, 10);
  private readonly storageKey = 'vagus_step_counter_state';

  constructor() {
    this.detectOperatingSystem();
    this.restorePersistedStepCount();

    // Listen to today's log to reconcile counts and calibrate native hardware baseline
    this.dataBridge.todayLog$.subscribe((log) => {
      if (log && log.biometrics && typeof log.biometrics.steps === 'number') {
        const cloudSteps = log.biometrics.steps;
        if (cloudSteps > this.currentSteps()) {
          this.currentSteps.set(cloudSteps);
          this.persistStepCount(cloudSteps);

          const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
          if (bridge && typeof bridge.setInitialBaseline === 'function') {
            bridge.setInitialBaseline(cloudSteps);
          }
        }
      }
    });

    // Handle app visibility change (resuming app from background on iOS / Android)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.onAppForegrounded();
        }
      });
    }

    // Direct Android Hardware Step Sensor Listener (Dispatched from native MainActivity)
    if (typeof window !== 'undefined') {
      window.addEventListener('androidHardwareStep', (event: any) => {
        if (event && event.detail && typeof event.detail.steps === 'number') {
          const steps = event.detail.steps;
          if (steps > 0 && steps >= this.currentSteps()) {
            this.ngZone.run(() => {
              this.currentSteps.set(steps);
              this.persistStepCount(steps);

              // Real-time cadence calculation
              const now = performance.now();
              this.recentStepTimes.push(now);
              this.recentStepTimes = this.recentStepTimes.filter((t) => now - t <= 5000);
              const cadence = Math.round((this.recentStepTimes.length / 5) * 60);
              this.activeCadence.set(cadence);

              this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, steps);
              this.activeEngine.set('ANDROID_HARDWARE_PEDOMETER');
              this.isTracking.set(true);
              this.permissionState.set('GRANTED');
              this.statusMessage.set('Hardware Step Sensor: Live');
            });
          }
        }
      });
    }

    // Auto-start tracking on initialization like StepUp
    this.autoStartTracking();

    // Check hardware bridge and Health Connect with short delays in case WebView interface attaches right after bundle evaluation
    if (typeof window !== 'undefined') {
      [300, 800, 2000].forEach((delay) => {
        setTimeout(() => {
          const b = (window as any).AndroidHardwarePedometer;
          if (b && typeof b.getLiveSteps === 'function') {
            const steps = b.getLiveSteps();
            if (steps > 0 && steps > this.currentSteps()) {
              this.currentSteps.set(steps);
              this.persistStepCount(steps);
              this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, steps);
              this.activeEngine.set('ANDROID_HARDWARE_PEDOMETER');
              this.isTracking.set(true);
              this.permissionState.set('GRANTED');
            } else if (this.currentSteps() > 0 && steps === 0 && typeof b.setInitialBaseline === 'function') {
              // Synchronize native baseline with restored steps
              b.setInitialBaseline(this.currentSteps());
            }
          }
          if (Capacitor.isNativePlatform()) {
            this.syncWithHealthConnect().catch(() => {});
          }
        }, delay);
      });
    }
  }

  /**
   * Detect OS (iOS vs Android vs Web)
   */
  private detectOperatingSystem(): void {
    if (typeof navigator === 'undefined') return;

    const ua = navigator.userAgent || '';
    this.isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.isAndroid = /Android/.test(ua);

    if (this.isIOS) {
      this.platformLabel.set('Apple iOS (CoreMotion / HealthKit)');
    } else if (this.isAndroid) {
      this.platformLabel.set('Google Android (Health Connect / Sensor)');
    } else {
      this.platformLabel.set('Cross-Platform Biometric Sensor');
    }
  }

  /**
   * Automatically start step collection without requiring manual toggle
   */
  public async autoStartTracking(userId?: string, dateStr?: string): Promise<boolean> {
    if (userId) this.currentUserId = userId;
    if (dateStr) this.currentDateStr = dateStr;

    const isNative = Capacitor.isNativePlatform();

    // 0. Direct Android Hardware Sensor Bridge (reads low-power Sensor.TYPE_STEP_COUNTER from phone hardware)
    const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
    if (bridge && typeof bridge.getLiveSteps === 'function') {
      const steps = bridge.getLiveSteps();
      if (steps > 0 && steps >= this.currentSteps()) {
        this.currentSteps.set(steps);
        this.persistStepCount(steps);
        this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, steps);
      }
      this.activeEngine.set('ANDROID_HARDWARE_PEDOMETER');
      this.isTracking.set(true);
      this.permissionState.set('GRANTED');
      this.statusMessage.set('Hardware Step Sensor Active');
      // Background auto-sync with StepUp / Google Health Connect
      this.syncWithHealthConnect().catch(() => {});
      return true;
    }

    // 1. Native iOS / Android Capacitor Layer
    if (isNative) {
      try {
        const available = await CapacitorPedometer.isAvailable();
        if (available && available.stepCounting) {
          const perm = await CapacitorPedometer.checkPermissions();

          if (perm.activityRecognition === 'granted') {
            this.permissionState.set('GRANTED');
            return this.initializeNativePedometer();
          } else {
            const requested = await CapacitorPedometer.requestPermissions();
            if (requested.activityRecognition === 'granted') {
              this.permissionState.set('GRANTED');
              return this.initializeNativePedometer();
            }
          }
        }
      } catch (err) {
        console.warn('[PedometerService] Native pedometer check failed, checking web sensors:', err);
      }
    }

    // 2. Mobile Web / PWA Accelerometer Layer (iOS Safari & Android Chrome)
    return this.initializeWebMotionSensor();
  }

  /**
   * Stop or pause step collection
   */
  public async stopTracking(): Promise<void> {
    if (this.motionListener && typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this.motionListener);
      this.motionListener = null;
    }

    if (Capacitor.isNativePlatform()) {
      try {
        if (this.nativeListenerHandle) {
          await this.nativeListenerHandle.remove();
          this.nativeListenerHandle = null;
        }
        await CapacitorPedometer.stopMeasurementUpdates();
      } catch {}
    }

    this.isTracking.set(false);
    this.activeCadence.set(0);
    this.activeEngine.set('STANDBY');
    this.statusMessage.set('Auto-sync paused.');
  }

  /**
   * Native iOS CoreMotion & Android Step Counter integration
   */
  private async initializeNativePedometer(): Promise<boolean> {
    try {
      // Query steps taken today from start of day (midnight) to now
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      try {
        const todayMeasurement = await CapacitorPedometer.getMeasurement({
          start: startOfDay.getTime(),
          end: Date.now(),
        });

        if (typeof todayMeasurement.numberOfSteps === 'number' && todayMeasurement.numberOfSteps > 0) {
          this.currentSteps.set(todayMeasurement.numberOfSteps);
          this.persistStepCount(todayMeasurement.numberOfSteps);
          this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, todayMeasurement.numberOfSteps);
        }
      } catch (queryErr) {
        console.info('[PedometerService] Range measurement not supported, streaming updates directly:', queryErr);
      }

      // Listen to continuous live updates
      this.nativeListenerHandle = await CapacitorPedometer.addListener('measurement', (data: Measurement) => {
        if (typeof data.numberOfSteps === 'number') {
          this.onStepDetected(data.numberOfSteps, true);
        }
      });

      await CapacitorPedometer.startMeasurementUpdates();

      const engine: SensorEngine = this.isIOS ? 'IOS_CORE_MOTION' : 'ANDROID_HARDWARE_PEDOMETER';
      this.activeEngine.set(engine);
      this.isTracking.set(true);
      this.statusMessage.set(`Connected: ${this.platformLabel()}`);
      return true;
    } catch (err) {
      console.warn('[PedometerService] Native setup failed, falling back to Web Accelerometer:', err);
      return this.initializeWebMotionSensor();
    }
  }

  /**
   * Web Sensor API (Android Chrome & iOS Safari Motion Sensors)
   */
  private async initializeWebMotionSensor(): Promise<boolean> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
      this.statusMessage.set('Motion sensors unavailable on this client.');
      return false;
    }

    // iOS 13+ requires user gesture permission
    const deviceMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof deviceMotion.requestPermission === 'function') {
      this.permissionState.set('PROMPT');
      this.statusMessage.set('iOS Safari: Tap "Authorize Motion" to enable automatic step sync.');
      return false;
    }

    // Android Chrome auto-activates immediately without prompt
    this.bindDeviceMotionListener();
    this.permissionState.set('GRANTED');
    this.activeEngine.set('MOBILE_ACCELEROMETER');
    this.isTracking.set(true);
    this.statusMessage.set(`Auto-sync active via ${this.platformLabel()}`);
    return true;
  }

  /**
   * Request Native Android Activity Recognition & iOS CoreMotion Permission
   */
  public async requestNativePermission(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
      if (bridge && typeof bridge.requestPermission === 'function') {
        bridge.requestPermission();
      }

      // Also trigger Health Connect permission prompt / sync
      this.syncWithHealthConnect().catch(() => {});

      try {
        const requested = await CapacitorPedometer.requestPermissions();
        if (requested.activityRecognition === 'granted') {
          this.permissionState.set('GRANTED');
          return this.initializeNativePedometer();
        } else {
          this.permissionState.set('DENIED');
          this.statusMessage.set('Physical activity permission denied in Android Settings.');
          return false;
        }
      } catch (e) {
        console.warn('[PedometerService] Request permission error:', e);
        return false;
      }
    }
    return this.requestIOSMotionPermission();
  }

  /**
   * Request iOS Safari DeviceMotion Permission (invoked by user tap)
   */
  public async requestIOSMotionPermission(): Promise<boolean> {
    const deviceMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof deviceMotion.requestPermission === 'function') {
      try {
        const response = await deviceMotion.requestPermission();
        if (response === 'granted') {
          this.permissionState.set('GRANTED');
          this.bindDeviceMotionListener();
          this.activeEngine.set('MOBILE_ACCELEROMETER');
          this.isTracking.set(true);
          this.statusMessage.set('Apple iOS motion sensor authorized & auto-syncing steps.');
          return true;
        } else {
          this.permissionState.set('DENIED');
          this.statusMessage.set('Motion access denied in iOS Settings.');
          return false;
        }
      } catch (err) {
        console.warn('[PedometerService] iOS permission request error:', err);
        return false;
      }
    }
    return false;
  }

  private bindDeviceMotionListener(): void {
    if (this.motionListener) {
      window.removeEventListener('devicemotion', this.motionListener);
    }
    this.motionListener = (event: DeviceMotionEvent) => this.handleDeviceMotion(event);
    window.addEventListener('devicemotion', this.motionListener, { passive: true });
  }

  /**
   * High-accuracy peak detection algorithm
   */
  private handleDeviceMotion(event: DeviceMotionEvent): void {
    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) {
      return;
    }

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;

    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const now = performance.now();

    if (magnitude > this.stepAccelerationThreshold) {
      if (now - this.lastStepTimestamp > this.minStepIntervalMs) {
        this.lastStepTimestamp = now;
        this.onStepDetected(1, false);
      }
    }
  }

  private onStepDetected(deltaOrTotal: number, isAbsoluteTotal: boolean): void {
    const newTotal = isAbsoluteTotal ? deltaOrTotal : this.currentSteps() + deltaOrTotal;
    this.currentSteps.set(newTotal);
    this.persistStepCount(newTotal);

    // Calculate Cadence (steps/minute over sliding 5-second window)
    const now = performance.now();
    this.recentStepTimes.push(now);
    this.recentStepTimes = this.recentStepTimes.filter((t) => now - t <= 5000);
    const cadence = Math.round((this.recentStepTimes.length / 5) * 60);
    this.activeCadence.set(cadence);

    // Sync to Firestore
    this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, newTotal);
  }

  private async onAppForegrounded(): Promise<void> {
    // 0. Re-check Android Hardware Pedometer
    const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
    if (bridge && typeof bridge.getLiveSteps === 'function') {
      const steps = bridge.getLiveSteps();
      if (steps > 0 && steps >= this.currentSteps()) {
        this.currentSteps.set(steps);
        this.persistStepCount(steps);
        this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, steps);
      }
    }

    // 1. Re-sync with Google Health Connect & Apple HealthKit (e.g. from StepUp or Google Fit)
    await this.syncWithHealthConnect();

    // 2. Re-check native measurement on app wake
    if (Capacitor.isNativePlatform()) {
      try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const measurement = await CapacitorPedometer.getMeasurement({
          start: startOfDay.getTime(),
          end: Date.now(),
        });
        if (typeof measurement.numberOfSteps === 'number' && measurement.numberOfSteps > this.currentSteps()) {
          this.onStepDetected(measurement.numberOfSteps, true);
        }
      } catch {}
    }
  }

  /**
   * Automatically synchronize cumulative daily steps from Health Connect / Apple HealthKit
   */
  public async syncWithHealthConnect(): Promise<number | null> {
    if (!Capacitor.isNativePlatform()) return null;

    try {
      // 1. Request read permissions for fitness variables if needed
      try {
        await HealthFitness.requestHealthPermissions({
          customPermissions: '[]',
          allVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          fitnessVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          healthVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          profileVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          workoutVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
        });
      } catch (permErr) {
        console.warn('[PedometerService] Health permissions query info:', permErr);
      }

      // 2. Query today's steps from 00:00:00 to now
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const now = new Date();

      const isoDate = (d: Date) => d.toISOString().split('.')[0] + 'Z';

      const res = await HealthFitness.getData({
        parameters: JSON.stringify({
          Variable: 'STEPS',
          StartDate: isoDate(startOfDay),
          EndDate: isoDate(now),
          TimeUnit: 'DAY',
          OperationType: 'SUM',
          TimeUnitLength: 1,
          AdvancedQueryReturnType: 'ALL_DATA',
          AdvancedQueryResultType: 'RAW_DATA',
        }),
      });

      if (res && res.results) {
        let parsed: any;
        try {
          parsed = typeof res.results === 'string' ? JSON.parse(res.results) : res.results;
        } catch {
          parsed = null;
        }

        let totalSteps = 0;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const val =
              item?.value ??
              item?.steps ??
              item?.count ??
              item?.sum ??
              item?.quantity ??
              (typeof item === 'number' ? item : 0);
            if (typeof val === 'number') {
              totalSteps += Math.round(val);
            }
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          const val =
            parsed?.value ??
            parsed?.steps ??
            parsed?.count ??
            parsed?.sum ??
            parsed?.quantity ??
            0;
          if (typeof val === 'number') totalSteps = Math.round(val);
        }

        if (totalSteps > 0 && totalSteps >= this.currentSteps()) {
          console.info(`[PedometerService] Auto-synced ${totalSteps} steps from Health Connect / StepUp`);
          this.currentSteps.set(totalSteps);
          this.persistStepCount(totalSteps);
          this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, totalSteps);

          // Calibrate native Android hardware baseline so future steps continue seamlessly from StepUp's count
          const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
          if (bridge && typeof bridge.setInitialBaseline === 'function') {
            bridge.setInitialBaseline(totalSteps);
          }

          this.statusMessage.set(`Auto-synced with Health Connect (${totalSteps.toLocaleString()} steps)`);
          return totalSteps;
        }
      }
    } catch (err) {
      console.warn('[PedometerService] Health Connect query skipped:', err);
    }
    return null;
  }

  private persistStepCount(steps: number): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const data = {
        date: this.currentDateStr,
        steps,
        timestamp: Date.now(),
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch {}
  }

  private restorePersistedStepCount(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.date === this.currentDateStr && typeof data.steps === 'number') {
          this.currentSteps.set(data.steps);
          const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
          if (bridge && typeof bridge.setInitialBaseline === 'function') {
            bridge.setInitialBaseline(data.steps);
          }
        } else if (data.date !== this.currentDateStr) {
          // Midnight has passed: automatically start today's fresh counter at 0
          this.currentSteps.set(0);
          this.activeCadence.set(0);
          this.persistStepCount(0);
        }
      }
    } catch {}
  }

  /**
   * Directly set or synchronize step count (e.g. from StepUp, Apple Health, or Google Fit)
   */
  public setManualStepCount(steps: number, userId?: string, dateStr?: string): void {
    const targetSteps = Math.max(0, Math.round(steps));
    const targetUid = userId || this.currentUserId;
    const targetDate = dateStr || this.currentDateStr;

    // Calibrate native Android hardware baseline so hardware steps continue smoothly from targetSteps
    const bridge = typeof window !== 'undefined' ? (window as any).AndroidHardwarePedometer : null;
    if (bridge && typeof bridge.setInitialBaseline === 'function') {
      bridge.setInitialBaseline(targetSteps);
    }

    this.currentSteps.set(targetSteps);
    this.persistStepCount(targetSteps);
    this.dataBridge.updateLiveSteps(targetUid, targetDate, targetSteps);
    this.statusMessage.set(`Hardware Calibrated: ${targetSteps.toLocaleString()} steps today.`);
  }

  /**
   * Reset step counter to zero and clear persistent cache
   */
  public resetSteps(): void {
    this.currentSteps.set(0);
    this.activeCadence.set(0);
    this.recentStepTimes = [];
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this.storageKey);
    }
  }

  public simulateStride(count: number = 10): void {
    for (let i = 0; i < count; i++) {
      this.onStepDetected(1, false);
    }
  }
}
