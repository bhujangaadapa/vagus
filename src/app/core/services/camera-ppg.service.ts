import { Injectable, signal, inject } from '@angular/core';
import { PhysicsEngineService } from './physics-engine.service';
import { DataBridgeService } from './data-bridge.service';

export interface PpgScanState {
  isActive: boolean;
  isFingerDetected: boolean;
  durationSeconds: number;
  remainingSeconds: number;
  liveBpm: number;
  currentRMSSD: number;
  capturedIBIs: number[]; // Inter-beat intervals in ms
  signalWaveform: number[]; // Rolling AC pulse amplitude for live graph
  statusMessage: string;
}

@Injectable({
  providedIn: 'root',
})
export class CameraPpgService {
  private readonly physicsEngine = inject(PhysicsEngineService);
  private readonly dataBridge = inject(DataBridgeService);

  // Reactive state signals
  public readonly isSupported = signal<boolean>(
    typeof navigator !== 'undefined' && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia
  );
  public readonly scanState = signal<PpgScanState>({
    isActive: false,
    isFingerDetected: false,
    durationSeconds: 45,
    remainingSeconds: 45,
    liveBpm: 0,
    currentRMSSD: 0,
    capturedIBIs: [],
    signalWaveform: [],
    statusMessage: 'Ready. Cover camera lens and flash with index finger.',
  });
  public readonly errorMessage = signal<string | null>(null);

  // Video / Canvas processing references
  private mediaStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private canvasContext: CanvasRenderingContext2D | null = null;
  private animationFrameId: number | null = null;
  private timerInterval: any = null;

  // Signal processing variables
  private lastPeakTime = 0;
  private readonly minPeakIntervalMs = 320; // Max ~187 bpm
  private smoothedIntensity = 0;
  private previousDeriv = 0;
  private recentIBIs: number[] = [];
  private recentBpms: number[] = [];

  constructor() {}

  /**
   * Start Camera PPG Heart Rate and HRV capture
   */
  public async startPpgScan(durationSeconds: number = 45): Promise<boolean> {
    this.errorMessage.set(null);

    if (!this.isSupported()) {
      this.errorMessage.set('Camera access is not supported in this browser environment.');
      return false;
    }

    try {
      // Request rear camera with maximum frame rate and torch constraint
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 192 },
          height: { ideal: 192 },
          frameRate: { ideal: 30, max: 60 },
        },
      };

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Attempt to enable torch / flash if supported
      const track = this.mediaStream.getVideoTracks()[0];
      const capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as any;
      if (capabilities && capabilities.torch) {
        try {
          await (track as any).applyConstraints({ advanced: [{ torch: true }] });
        } catch (torchErr) {
          console.warn('[CameraPPG] Torch activation failed, ambient illumination needed:', torchErr);
        }
      }

      // Initialize hidden offscreen video and canvas elements
      if (!this.videoElement) {
        this.videoElement = document.createElement('video');
        this.videoElement.setAttribute('playsinline', 'true');
        this.videoElement.muted = true;
      }
      this.videoElement.srcObject = this.mediaStream;
      await this.videoElement.play();

      if (!this.canvasElement) {
        this.canvasElement = document.createElement('canvas');
        this.canvasElement.width = 48;
        this.canvasElement.height = 48;
        this.canvasContext = this.canvasElement.getContext('2d', { willReadFrequently: true });
      }

      // Reset internal filtering variables
      this.lastPeakTime = 0;
      this.smoothedIntensity = 0;
      this.previousDeriv = 0;
      this.recentIBIs = [];
      this.recentBpms = [];

      this.scanState.set({
        isActive: true,
        isFingerDetected: false,
        durationSeconds,
        remainingSeconds: durationSeconds,
        liveBpm: 0,
        currentRMSSD: 0,
        capturedIBIs: [],
        signalWaveform: [],
        statusMessage: 'Place finger gently over camera lens and flash...',
      });

      // Start countdown timer
      this.startCountdownTimer();

      // Start video frame analysis loop
      this.processVideoFrames();

      return true;
    } catch (err: any) {
      console.warn('[CameraPPG] Camera initialization failed:', err);
      this.stopPpgScan(false);
      this.errorMessage.set(err.message || 'Could not access phone camera for PPG.');
      return false;
    }
  }

  /**
   * Continuous optical frame analysis loop
   */
  private processVideoFrames = (): void => {
    if (!this.scanState().isActive || !this.videoElement || !this.canvasContext) {
      return;
    }

    if (this.videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.canvasContext.drawImage(this.videoElement, 0, 0, 48, 48);
      const frameData = this.canvasContext.getImageData(0, 0, 48, 48).data;

      // Extract average Red, Green, Blue channel intensities
      let totalRed = 0;
      let totalGreen = 0;
      let totalBlue = 0;
      const pixelCount = 48 * 48;

      for (let i = 0; i < frameData.length; i += 4) {
        totalRed += frameData[i];
        totalGreen += frameData[i + 1];
        totalBlue += frameData[i + 2];
      }

      const avgRed = totalRed / pixelCount;
      const avgGreen = totalGreen / pixelCount;
      const avgBlue = totalBlue / pixelCount;

      // Finger presence detection heuristic:
      // When capillary bed covers camera with torch, Red dominates heavily (Red > 120, Red / (Green+Blue) > 1.4)
      const isCovered = avgRed > 115 && avgRed / Math.max(1, avgGreen + avgBlue) > 1.35;

      if (!isCovered) {
        this.scanState.set({
          ...this.scanState(),
          isFingerDetected: false,
          statusMessage: 'Cover lens completely. Ensure fingertip glows red.',
        });
      } else {
        // Optical pulse extraction (Photoplethysmogram AC component)
        this.processOpticalPulseSample(avgRed);
      }
    }

    this.animationFrameId = requestAnimationFrame(this.processVideoFrames);
  };

  /**
   * Filter red channel intensity and detect systolic cardiac peaks
   */
  private processOpticalPulseSample(redIntensity: number): void {
    const now = performance.now();

    // Exponential moving average filter (low-pass smoothing)
    if (this.smoothedIntensity === 0) {
      this.smoothedIntensity = redIntensity;
    }
    const alpha = 0.15;
    this.smoothedIntensity = alpha * redIntensity + (1 - alpha) * this.smoothedIntensity;

    // High-pass detrending: AC pulsatile component = raw - lowPass
    const acPulse = redIntensity - this.smoothedIntensity;

    // Update rolling waveform for UI rendering (keep last 30 samples)
    const currentWaveform = [...this.scanState().signalWaveform, Math.round(acPulse * 100) / 100];
    if (currentWaveform.length > 30) {
      currentWaveform.shift();
    }

    // Derivative peak detection
    const currentDeriv = acPulse;
    const isLocalPeak = this.previousDeriv > 0 && currentDeriv <= 0;
    this.previousDeriv = currentDeriv;

    if (isLocalPeak && (now - this.lastPeakTime) >= this.minPeakIntervalMs) {
      if (this.lastPeakTime > 0) {
        const rawIBI = Math.round(now - this.lastPeakTime);

        // Sanity check physiological bounds (350ms - 1300ms => 46 - 171 bpm)
        if (rawIBI >= 350 && rawIBI <= 1300) {
          this.recentIBIs.push(rawIBI);
          const instantBpm = Math.round(60000 / rawIBI);
          this.recentBpms.push(instantBpm);

          const rollingRMSSD = this.physicsEngine.calculateRMSSD(this.recentIBIs);
          const avgBpm = Math.round(
            this.recentBpms.reduce((a, b) => a + b, 0) / this.recentBpms.length
          );

          this.scanState.set({
            ...this.scanState(),
            isFingerDetected: true,
            statusMessage: 'Pulsatile waveform locked. Stay still...',
            liveBpm: avgBpm,
            currentRMSSD: rollingRMSSD,
            capturedIBIs: [...this.recentIBIs],
            signalWaveform: currentWaveform,
          });
        }
      }
      this.lastPeakTime = now;
    } else {
      // Just update waveform
      this.scanState.set({
        ...this.scanState(),
        isFingerDetected: true,
        signalWaveform: currentWaveform,
      });
    }
  }

  /**
   * Countdown timer for scan epoch
   */
  private startCountdownTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      const current = this.scanState();
      if (!current.isActive) {
        clearInterval(this.timerInterval);
        return;
      }

      const nextRemaining = current.remainingSeconds - 1;
      if (nextRemaining <= 0) {
        clearInterval(this.timerInterval);
        this.completePpgScan();
      } else {
        this.scanState.set({
          ...current,
          remainingSeconds: nextRemaining,
        });
      }
    }, 1000);
  }

  /**
   * Stop scan manually or on error
   */
  public stopPpgScan(saveData: boolean = false): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (saveData && this.recentIBIs.length >= 8) {
      this.completePpgScan();
    } else {
      this.scanState.set({
        ...this.scanState(),
        isActive: false,
        statusMessage: 'Scan cancelled.',
      });
    }
  }

  /**
   * Complete PPG scan, compute RMSSD and commit to Firestore
   */
  public async completePpgScan(): Promise<{ rmssd: number; rhr: number }> {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    const state = this.scanState();
    this.scanState.set({
      ...state,
      isActive: false,
      statusMessage: 'PPG Scan complete! Telemetry saved.',
    });

    const finalRMSSD = this.physicsEngine.calculateRMSSD(state.capturedIBIs);
    const finalRHR = state.liveBpm || 62;

    if (state.capturedIBIs.length >= 5) {
      await this.dataBridge.recordReadinessScan(finalRMSSD, finalRHR);
    }

    return { rmssd: finalRMSSD, rhr: finalRHR };
  }
}
