import { Component, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BleHeartRateService } from '../../services/ble-heart-rate.service';
import { CameraPpgService } from '../../services/camera-ppg.service';
import { FitbitIntegrationService } from '../../services/fitbit-integration.service';
import { PhysicsEngineService } from '../../services/physics-engine.service';
import { DataBridgeService } from '../../services/data-bridge.service';

export interface TelemetryComparisonRecord {
  timestamp: string;
  polarBpm: number | null;
  polarRRMs: number | null;
  ppgBpm: number | null;
  ppgIBIMs: number | null;
  bpmDelta: number | null;
  errorPercent: number | null;
}

@Component({
  selector: 'app-developer-lab',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './developer-lab.component.html',
  styleUrls: ['./developer-lab.component.css'],
})
export class DeveloperLabComponent {
  public readonly bleHR = inject(BleHeartRateService);
  public readonly ppg = inject(CameraPpgService);
  public readonly fitbit = inject(FitbitIntegrationService);
  public readonly physicsEngine = inject(PhysicsEngineService);
  public readonly dataBridge = inject(DataBridgeService);

  // Benchmarking and live comparison stream
  public readonly isBenchmarking = signal<boolean>(false);
  public readonly comparisonLogs = signal<TelemetryComparisonRecord[]>([]);
  private benchmarkInterval: any = null;

  // Chaos / Stress Simulation Variables
  public readonly simHR = signal<number>(145);
  public readonly simRMSSD = signal<number>(24);
  public readonly simRestingHR = signal<number>(58);
  public readonly simCalculatedRecovery = computed(() => {
    return this.physicsEngine.computeDailyRecoveryPercent(
      this.simRMSSD(),
      58.0,
      this.simRestingHR(),
      52.0
    );
  });
  public readonly simCalculatedStrain = computed(() => {
    return this.physicsEngine.calculateAccumulatedStrain(
      Array(45).fill(this.simHR()),
      this.simRestingHR(),
      190
    );
  });
  public readonly simAutonomicSteering = computed(() => {
    return this.physicsEngine.calculateAutonomicSteering(this.simRMSSD(), this.simRestingHR());
  });

  // Current Live Deltas between Polar ECG and Phone Camera PPG
  public readonly currentBpmDelta = computed(() => {
    const polar = this.bleHR.liveBpm();
    const camera = this.ppg.scanState().liveBpm;
    if (polar > 0 && camera > 0) {
      return Math.abs(polar - camera);
    }
    return null;
  });

  public readonly currentBpmErrorPercent = computed(() => {
    const delta = this.currentBpmDelta();
    const polar = this.bleHR.liveBpm();
    if (delta !== null && polar > 0) {
      return Math.round((delta / polar) * 1000) / 10;
    }
    return null;
  });

  public readonly rmssdComparison = computed(() => {
    const polarRMSSD = this.bleHR.scanSession().currentRMSSD;
    const ppgRMSSD = this.ppg.scanState().currentRMSSD;
    const fitbitEstimated = this.fitbit.lastImport()?.calculatedRecovery ?? null;

    let delta: number | null = null;
    if (polarRMSSD > 0 && ppgRMSSD > 0) {
      delta = Math.round(Math.abs(polarRMSSD - ppgRMSSD) * 10) / 10;
    }

    return {
      polar: polarRMSSD > 0 ? polarRMSSD : null,
      ppg: ppgRMSSD > 0 ? ppgRMSSD : null,
      fitbit: fitbitEstimated,
      delta,
    };
  });

  // Raw JSON Inspector Output
  public readonly currentTelemetryPayload = computed(() => {
    return {
      timestamp: new Date().toISOString(),
      sensors: {
        polarECG: {
          connected: this.bleHR.isConnected(),
          deviceName: this.bleHR.deviceName(),
          batteryLevel: this.bleHR.batteryLevel(),
          liveBpm: this.bleHR.liveBpm(),
          lastRRMs: this.bleHR.lastRRIntervalMs(),
          sessionRMSSD: this.bleHR.scanSession().currentRMSSD,
          beatsLogged: this.bleHR.scanSession().capturedRRIntervals.length,
        },
        cameraPPG: {
          active: this.ppg.scanState().isActive,
          fingerLocked: this.ppg.scanState().isFingerDetected,
          liveBpm: this.ppg.scanState().liveBpm,
          liveRMSSD: this.ppg.scanState().currentRMSSD,
          beatsLogged: this.ppg.scanState().capturedIBIs.length,
          waveformSamples: this.ppg.scanState().signalWaveform.slice(-10),
        },
        fitbitHub: {
          lastImportDate: this.fitbit.lastImport()?.date || null,
          totalSleepMin: this.fitbit.lastImport()?.totalSleepMin || null,
          deepSleepMin: this.fitbit.lastImport()?.deepSleepMin || null,
          remSleepMin: this.fitbit.lastImport()?.remSleepMin || null,
          restingHR: this.fitbit.lastImport()?.restingHR || null,
        },
      },
      comparison: {
        bpmDelta: this.currentBpmDelta(),
        errorPercent: this.currentBpmErrorPercent(),
      },
    };
  });

  constructor() {
    // Record comparison telemetry when both sensors are active
    effect(() => {
      const isBenchmarking = this.isBenchmarking();
      if (!isBenchmarking && this.benchmarkInterval) {
        clearInterval(this.benchmarkInterval);
        this.benchmarkInterval = null;
      }
    });
  }

  public toggleBenchmarkStream(): void {
    if (this.isBenchmarking()) {
      this.isBenchmarking.set(false);
      if (this.benchmarkInterval) clearInterval(this.benchmarkInterval);
    } else {
      this.isBenchmarking.set(true);
      this.benchmarkInterval = setInterval(() => {
        const polarBpm = this.bleHR.liveBpm() || null;
        const polarRR = this.bleHR.lastRRIntervalMs();
        const ppgBpm = this.ppg.scanState().liveBpm || null;
        const ppgIBI = this.ppg.scanState().capturedIBIs.slice(-1)[0] || null;

        let delta: number | null = null;
        let errPct: number | null = null;

        if (polarBpm !== null && ppgBpm !== null) {
          delta = Math.abs(polarBpm - ppgBpm);
          errPct = Math.round((delta / polarBpm) * 1000) / 10;
        }

        const newEntry: TelemetryComparisonRecord = {
          timestamp: new Date().toLocaleTimeString(),
          polarBpm,
          polarRRMs: polarRR,
          ppgBpm,
          ppgIBIMs: ppgIBI,
          bpmDelta: delta,
          errorPercent: errPct,
        };

        const current = [...this.comparisonLogs(), newEntry];
        if (current.length > 25) current.shift();
        this.comparisonLogs.set(current);
      }, 1000);
    }
  }

  public clearLogs(): void {
    this.comparisonLogs.set([]);
  }

  public exportTelemetryJson(): void {
    const payload = JSON.stringify(this.currentTelemetryPayload(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vagus_telemetry_dump_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  public exportBenchmarkCsv(): void {
    const logs = this.comparisonLogs();
    if (logs.length === 0) return;

    let csv = 'Timestamp,Polar_BPM,Polar_RR_ms,PPG_BPM,PPG_IBI_ms,BPM_Delta,Error_Pct\n';
    for (const row of logs) {
      csv += `${row.timestamp},${row.polarBpm ?? ''},${row.polarRRMs ?? ''},${row.ppgBpm ?? ''},${row.ppgIBIMs ?? ''},${row.bpmDelta ?? ''},${row.errorPercent ?? ''}\n`;
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vagus_benchmark_comparison_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
