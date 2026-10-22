import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth.service';
import { DataBridgeService } from '../../services/data-bridge.service';
import { PhysicsEngineService } from '../../services/physics-engine.service';
import { PedometerService } from '../../services/pedometer.service';
import { BleHeartRateService } from '../../services/ble-heart-rate.service';
import { CameraPpgService } from '../../services/camera-ppg.service';
import { XiaomiIntegrationService } from '../../services/xiaomi-integration.service';
import { DailyBiometricLog, JournalHabits } from '../../models/biometrics.interface';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  public readonly authService = inject(AuthService);
  private readonly dataBridge = inject(DataBridgeService);
  private readonly physicsEngine = inject(PhysicsEngineService);
  public readonly pedometer = inject(PedometerService);
  public readonly bleHR = inject(BleHeartRateService);
  public readonly ppg = inject(CameraPpgService);
  public readonly xiaomi = inject(XiaomiIntegrationService);

  // Active user ID derived from Auth state
  public readonly activeUserId = computed(() => {
    return this.authService.currentUser()?.uid || 'pilot_athlete_01';
  });

  // Reactive state signals
  public readonly todayLog = signal<DailyBiometricLog | null>(null);
  public readonly historyLogs = signal<DailyBiometricLog[]>([]);
  public readonly isSeeding = signal<boolean>(false);
  public readonly permissionGranted = signal<boolean>(false);

  // Computed properties
  public readonly recoveryScore = computed(() => this.todayLog()?.scores.calculatedRecovery ?? 0);
  public readonly strainScore = computed(() => this.todayLog()?.scores.calculatedStrain ?? 0.0);

  // Live Step telemetry
  public readonly stepGoal = computed(() => {
    return this.authService.userProfile()?.settings?.dailyStepGoal || 10000;
  });
  public readonly liveSteps = computed(() => {
    return this.pedometer.currentSteps() || (this.todayLog()?.biometrics.steps ?? 0);
  });
  public readonly stepProgressPercent = computed(() => {
    return Math.min(100, Math.round((this.liveSteps() / this.stepGoal()) * 100));
  });
  public readonly estimatedDistanceKm = computed(() => {
    const km = (this.liveSteps() * 0.762) / 1000;
    return (Math.round(km * 100) / 100).toFixed(2);
  });
  public readonly estimatedActiveCalories = computed(() => {
    return Math.round(this.liveSteps() * 0.04);
  });

  public readonly recoveryColor = computed(() => {
    const score = this.recoveryScore();
    if (score === 0) return { text: 'text-slate-400', stroke: '#475569', bg: 'bg-slate-800/20', border: 'border-slate-700/30' };
    if (score > 66) return { text: 'text-emerald-400', stroke: '#34d399', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' };
    if (score >= 34) return { text: 'text-amber-400', stroke: '#fbbf24', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
    return { text: 'text-rose-500', stroke: '#f43f5e', bg: 'bg-rose-500/10', border: 'border-rose-500/30' };
  });

  public readonly recoveryStatusText = computed(() => {
    const score = this.recoveryScore();
    if (score === 0) return 'AWAITING TELEMETRY';
    if (score > 66) return 'PRIME RECOVERY';
    if (score >= 34) return 'STEADY ADAPTATION';
    return 'REST & RECHARGE';
  });

  public readonly targetStrain = computed(() => {
    return this.physicsEngine.calculateTargetStrain(this.recoveryScore());
  });

  // SVG Radial progress calculations
  public readonly circleRadius = 72;
  public readonly circumference = 2 * Math.PI * this.circleRadius;
  public readonly strokeDashoffset = computed(() => {
    const score = this.recoveryScore();
    const progress = Math.min(100, Math.max(0, score)) / 100;
    return this.circumference * (1 - progress);
  });

  // 7-day recent logs for trend view
  public readonly recentLogs = computed(() => {
    const logs = this.historyLogs();
    return logs.slice(-7);
  });

  constructor() {
    // Whenever active user changes, sync DataBridge and reload daily logs
    effect(() => {
      const uid = this.activeUserId();
      this.dataBridge.setActiveUserId(uid);
      this.dataBridge.getDailyLogs(uid).subscribe((logs) => {
        this.historyLogs.set(logs);
        if (logs.length > 0) {
          this.todayLog.set(logs[logs.length - 1]);
        }
      });
    });
  }

  public ngOnInit(): void {
    this.dataBridge.logs$.subscribe((logs) => {
      this.historyLogs.set(logs);
      if (logs.length > 0) {
        this.todayLog.set(logs[logs.length - 1]);
      }
    });

    this.dataBridge.todayLog$.subscribe((log) => {
      if (log) {
        this.todayLog.set(log);
      }
    });
  }

  public async resetAllData(): Promise<void> {
    const uid = this.activeUserId();
    this.pedometer.resetSteps();
    const clean = await this.dataBridge.resetAllData(uid);
    this.todayLog.set(clean);
    this.historyLogs.set([clean]);
  }

  public async loginGoogle(): Promise<void> {
    await this.authService.loginWithGoogle();
  }

  public async loginDemo(): Promise<void> {
    const user = await this.authService.loginAsDemoAthlete();
    if (user) {
      await this.seedInitialData();
    }
  }

  public async logout(): Promise<void> {
    await this.authService.logout();
    await this.seedInitialData();
  }

  public async togglePhoneSteps(): Promise<void> {
    if (this.pedometer.isTracking()) {
      await this.pedometer.stopTracking();
    } else {
      const today = this.todayLog()?.date;
      await this.pedometer.autoStartTracking(this.activeUserId(), today);
    }
  }

  public async authorizeIOSMotion(): Promise<void> {
    await this.pedometer.requestIOSMotionPermission();
  }

  public simulateTestSteps(): void {
    this.pedometer.simulateStride(25);
  }

  public async requestPermissions(): Promise<void> {
    const result = await this.dataBridge.requestHealthPermissions();
    this.permissionGranted.set(result.success);
    await this.pedometer.autoStartTracking(this.activeUserId(), this.todayLog()?.date);
  }

  public async seedInitialData(): Promise<void> {
    this.isSeeding.set(true);
    try {
      const seeded = await this.dataBridge.seed30DayHistory(this.activeUserId());
      if (seeded && seeded.length > 0) {
        this.todayLog.set(seeded[seeded.length - 1]);
      }
    } finally {
      this.isSeeding.set(false);
    }
  }

  public async toggleHabit(habitKey: keyof JournalHabits): Promise<void> {
    const current = this.todayLog();
    if (!current) return;

    const currentValue = current.journalHabits[habitKey];
    const updated = await this.dataBridge.updateJournalHabits(
      this.activeUserId(),
      current.date,
      { [habitKey]: !currentValue }
    );
    this.todayLog.set(updated);
  }

  public async togglePolarConnection(): Promise<void> {
    if (this.bleHR.isConnected()) {
      this.bleHR.disconnect();
    } else {
      await this.bleHR.connect();
    }
  }

  public startMorningReadinessScan(duration: number = 60): void {
    this.bleHR.startReadinessScan(duration);
  }

  public stopMorningReadinessScan(save: boolean = true): void {
    this.bleHR.stopReadinessScan(save);
  }

  public toggleWorkoutTracker(): void {
    if (this.bleHR.workoutSession().isActive) {
      this.bleHR.stopWorkout(true);
    } else {
      this.bleHR.startWorkout();
    }
  }

  // Camera PPG Actions
  public async startCameraPpg(duration: number = 45): Promise<void> {
    await this.ppg.startPpgScan(duration);
  }

  public stopCameraPpg(save: boolean = true): void {
    this.ppg.stopPpgScan(save);
  }

  // Xiaomi JSON file importer
  public onXiaomiFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      if (content) {
        await this.xiaomi.parseAndIngestXiaomiJson(content, this.activeUserId());
      }
    };
    reader.readAsText(file);
  }

  public formatMinutesToHours(minutes: number): string {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hrs}h ${mins}m`;
  }
}
