import { Injectable, inject, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { CapacitorPedometer, Measurement } from '@capgo/capacitor-pedometer';
import { DataBridgeService } from './data-bridge.service';

export type SensorEngine = 'NATIVE_PEDOMETER' | 'ANDROID_ACCELEROMETER' | 'SIMULATED';

@Injectable({
  providedIn: 'root',
})
export class PedometerService {
  private readonly dataBridge = inject(DataBridgeService);

  // Reactive state signals
  public readonly isTracking = signal<boolean>(false);
  public readonly currentSteps = signal<number>(0);
  public readonly activeCadence = signal<number>(0); // steps per minute
  public readonly activeEngine = signal<SensorEngine>('ANDROID_ACCELEROMETER');
  public readonly statusMessage = signal<string>('Sensor standby. Tap to connect Android steps.');

  // Motion analysis variables for Android Accelerometer peak-detection
  private lastStepTimestamp = 0;
  private readonly minStepIntervalMs = 280; // Maximum ~214 steps/min human physiological gait
  private readonly stepAccelerationThreshold = 11.8; // Peak m/s^2 (gravity 9.8 + walking thrust 2.0)
  private motionListener: ((event: DeviceMotionEvent) => void) | null = null;
  private nativeListenerHandle: PluginListenerHandle | null = null;
  private recentStepTimes: number[] = [];

  // Active user / date context
  private currentUserId = 'pilot_athlete_01';
  private currentDateStr = new Date().toISOString().slice(0, 10);

  constructor() {
    this.dataBridge.todayLog$.subscribe((log) => {
      if (log && log.biometrics && typeof log.biometrics.steps === 'number') {
        if (!this.isTracking() || this.currentSteps() === 0) {
          this.currentSteps.set(log.biometrics.steps);
        }
      }
    });
  }

  /**
   * Primary entry point: Request permissions and start live step tracking
   * Supports both Native Android Health Connect / Pedometer and Android Chrome Web Sensor API.
   */
  public async startTracking(userId: string = 'pilot_athlete_01', dateStr?: string): Promise<boolean> {
    this.currentUserId = userId;
    this.currentDateStr = dateStr || new Date().toISOString().slice(0, 10);

    const isNative = Capacitor.isNativePlatform();

    if (isNative) {
      try {
        const available = await CapacitorPedometer.isAvailable();
        if (available && available.stepCounting) {
          const perm = await CapacitorPedometer.requestPermissions();
          if (perm.activityRecognition === 'granted') {
            this.nativeListenerHandle = await CapacitorPedometer.addListener(
              'measurement',
              (data: Measurement) => {
                if (typeof data.numberOfSteps === 'number') {
                  this.onStepDetected(data.numberOfSteps, true);
                }
              }
            );
            await CapacitorPedometer.startMeasurementUpdates();
            this.activeEngine.set('NATIVE_PEDOMETER');
            this.isTracking.set(true);
            this.statusMessage.set('Android hardware step sensor active.');
            return true;
          }
        }
      } catch (err) {
        console.warn('[PedometerService] Native pedometer fallback to Web Accelerometer:', err);
      }
    }

    // Android Web / PWA Accelerometer Integration
    return this.startWebMotionSensor();
  }

  /**
   * Stop tracking step stream
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
    this.statusMessage.set('Step tracking paused.');
  }

  /**
   * Fallback for Android Chrome PWA: Uses DeviceMotionEvent 3-axis accelerometer
   */
  private async startWebMotionSensor(): Promise<boolean> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
      this.statusMessage.set('Device motion sensor not supported on this browser.');
      return false;
    }

    const deviceMotion = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof deviceMotion.requestPermission === 'function') {
      try {
        const response = await deviceMotion.requestPermission();
        if (response !== 'granted') {
          this.statusMessage.set('Permission denied for device motion sensors.');
          return false;
        }
      } catch (e) {
        console.warn('[PedometerService] Sensor permission error:', e);
      }
    }

    this.motionListener = (event: DeviceMotionEvent) => this.handleDeviceMotion(event);
    window.addEventListener('devicemotion', this.motionListener, { passive: true });

    this.activeEngine.set('ANDROID_ACCELEROMETER');
    this.isTracking.set(true);
    this.statusMessage.set('Android 3-axis accelerometer connected & tracking steps.');
    return true;
  }

  /**
   * Accelerometer Signal Processing & Peak Detection
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

    const now = performance.now();
    this.recentStepTimes.push(now);
    this.recentStepTimes = this.recentStepTimes.filter((t) => now - t <= 5000);
    const cadence = Math.round((this.recentStepTimes.length / 5) * 60);
    this.activeCadence.set(cadence);

    this.dataBridge.updateLiveSteps(this.currentUserId, this.currentDateStr, newTotal);
  }

  public simulateStride(count: number = 10): void {
    for (let i = 0; i < count; i++) {
      this.onStepDetected(1, false);
    }
  }
}
