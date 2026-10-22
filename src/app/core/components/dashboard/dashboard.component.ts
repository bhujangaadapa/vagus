import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Capacitor } from '@capacitor/core';
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
  public readonly Math = Math;
  public readonly isNativeApp = Capacitor.isNativePlatform();
  public readonly authService = inject(AuthService);
  private readonly dataBridge = inject(DataBridgeService);
  private readonly physicsEngine = inject(PhysicsEngineService);
  public readonly pedometer = inject(PedometerService);
  public readonly bleHR = inject(BleHeartRateService);
  public readonly ppg = inject(CameraPpgService);
  public readonly xiaomi = inject(XiaomiIntegrationService);

  // Active user ID derived from Auth state
  public readonly activeUserId = computed(() => {
    return this.authService.currentUser()?.uid || '';
  });

  // Reactive state signals
  public readonly todayLog = signal<DailyBiometricLog | null>(null);
  public readonly historyLogs = signal<DailyBiometricLog[]>([]);
  public readonly isSeeding = signal<boolean>(false);
  public readonly permissionGranted = signal<boolean>(false);

  // Computed properties
  public readonly recoveryScore = computed(() => this.todayLog()?.scores.calculatedRecovery ?? 0);
  public readonly strainScore = computed(() => this.todayLog()?.scores.calculatedStrain ?? 0.0);

  // Athlete Demographics
  public readonly athleteDemographics = computed(() => {
    return this.authService.userProfile()?.demographics || {
      gender: 'male' as const,
      age: 26,
      weightKg: 75,
      heightCm: 180,
    };
  });

  public readonly calibratedMaxHR = computed(() => {
    return this.authService.userProfile()?.baseline.maxHR || this.physicsEngine.calculateMaxHeartRate(this.athleteDemographics().age);
  });

  // Live Step telemetry calibrated with real height & weight
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
    const height = this.athleteDemographics().heightCm;
    const gender = this.athleteDemographics().gender;
    const strideMeters = this.physicsEngine.calculateStrideLengthMeters(height, gender);
    const km = (this.liveSteps() * strideMeters) / 1000;
    return (Math.round(km * 100) / 100).toFixed(2);
  });
  public readonly estimatedActiveCalories = computed(() => {
    const weight = this.athleteDemographics().weightKg;
    return this.physicsEngine.calculateStepCalories(this.liveSteps(), weight);
  });

  // Active Pillar Navigation (WHOOP 4.0 Tabs: Overview, Recovery, Strain, Sleep, Sensors)
  public readonly activePillar = signal<'overview' | 'recovery' | 'strain' | 'sleep' | 'sensors'>('overview');
  public setPillar(pillar: 'overview' | 'recovery' | 'strain' | 'sleep' | 'sensors'): void {
    this.activePillar.set(pillar);
  }

  // Active Hardware Sub-Tab
  public readonly activeHardwareTab = signal<'polar' | 'ppg' | 'xiaomi' | 'steps'>('polar');
  public setHardwareTab(tab: 'polar' | 'ppg' | 'xiaomi' | 'steps'): void {
    this.activeHardwareTab.set(tab);
  }

  // Profile Settings Modal State
  public readonly showProfileModal = signal<boolean>(false);
  public readonly editGender = signal<'male' | 'female' | 'other'>('male');
  public readonly editAge = signal<number>(26);
  public readonly editWeightKg = signal<number>(75);
  public readonly editHeightCm = signal<number>(180);
  public readonly editStepGoal = signal<number>(10000);
  public readonly isProfileSaving = signal<boolean>(false);

  public readonly recoveryColor = computed(() => {
    const score = this.recoveryScore();
    if (score === 0) {
      return {
        text: 'text-slate-400',
        stroke: '#475569',
        glow: 'rgba(100, 116, 139, 0.25)',
        bg: 'bg-slate-800/20',
        border: 'border-slate-700/30',
        gradient: 'from-slate-500 to-slate-700',
        zone: 'UNSCANNED'
      };
    }
    if (score > 66) {
      return {
        text: 'text-[#00F5A0]',
        stroke: '#00F5A0',
        glow: 'rgba(0, 245, 160, 0.4)',
        bg: 'bg-[#00F5A0]/10',
        border: 'border-[#00F5A0]/30',
        gradient: 'from-[#00F5A0] to-[#00B875]',
        zone: 'GREEN RECOVERY'
      };
    }
    if (score >= 34) {
      return {
        text: 'text-[#FFB800]',
        stroke: '#FFB800',
        glow: 'rgba(255, 184, 0, 0.4)',
        bg: 'bg-[#FFB800]/10',
        border: 'border-[#FFB800]/30',
        gradient: 'from-[#FFB800] to-[#E59400]',
        zone: 'YELLOW RECOVERY'
      };
    }
    return {
      text: 'text-[#FF334B]',
      stroke: '#FF334B',
      glow: 'rgba(255, 51, 75, 0.4)',
      bg: 'bg-[#FF334B]/10',
      border: 'border-[#FF334B]/30',
      gradient: 'from-[#FF334B] to-[#D91B33]',
      zone: 'RED RECOVERY'
    };
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

  public readonly strainZoneText = computed(() => {
    const s = this.strainScore();
    if (s >= 18) return 'ALL OUT';
    if (s >= 14) return 'STRENUOUS';
    if (s >= 10) return 'MODERATE';
    if (s >= 5) return 'LIGHT';
    return 'RESTORATIVE';
  });

  // SVG Radial progress calculations (Thick WHOOP Hero Ring)
  public readonly circleRadius = 80;
  public readonly circumference = 2 * Math.PI * this.circleRadius;
  public readonly strokeDashoffset = computed(() => {
    const score = this.recoveryScore();
    const progress = Math.min(100, Math.max(0, score)) / 100;
    return this.circumference * (1 - progress);
  });

  // Sleep Performance percentage
  public readonly sleepPerformancePercent = computed(() => {
    const logged = this.todayLog()?.biometrics?.sleepMinutes || 460;
    const need = this.tonightSleepNeedMinutes() || 480;
    return Math.min(100, Math.round((logged / need) * 100));
  });

  // 7-day recent logs for trend view
  public readonly recentLogs = computed(() => {
    const logs = this.historyLogs();
    return logs.slice(-7);
  });

  // Unique Feature 1: Circadian Rhythm & Sleep Need Predictor
  public readonly tonightSleepNeedMinutes = computed(() => {
    const base = 450; // 7.5 hrs baseline
    const strainExtra = Math.round(this.strainScore() * 8.5); // 8.5 min per strain unit
    const alcoholPenalty = this.todayLog()?.journalHabits.drankAlcohol ? 35 : 0;
    return base + strainExtra + alcoholPenalty;
  });

  public readonly circadianMelatoninWindow = computed(() => {
    const hadSunlight = this.todayLog()?.journalHabits.viewedSunlight ?? false;
    return hadSunlight ? '22:15 – 23:00 (Anchored)' : '23:45 – 00:30 (Delayed / Drift)';
  });

  public readonly peakAthleticWindow = computed(() => '16:30 – 18:30 (Core Temp Peak)');

  // Unique Feature 2: Glass-Box Algorithm Inspector Modal
  public readonly showAlgorithmInspector = signal<boolean>(false);

  // Unique Feature 3: Interactive Resonance Vagus Breathing Pacer
  public readonly showVagusPacer = signal<boolean>(false);
  public readonly pacerPhase = signal<'INHALE' | 'HOLD' | 'EXHALE'>('INHALE');
  public readonly pacerSecondsLeft = signal<number>(4);
  private pacerIntervalId: any = null;

  constructor() {
    // Whenever active user changes, sync DataBridge and reload daily logs
    effect(() => {
      const uid = this.activeUserId();
      if (!uid) {
        this.historyLogs.set([]);
        this.todayLog.set(null);
        return;
      }
      this.dataBridge.setActiveUserId(uid);
      this.bleHR.setActiveUserId(uid);
      this.ppg.setActiveUserId(uid);
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
    if (this.isNativeApp) {
      // In native Android WebView, Google blocks popup windows for OAuth security.
      // Open the athlete sign-in modal with email/password
      this.showEmailLoginModal.set(true);
      return;
    }
    await this.authService.loginWithGoogle();
  }

  public async loginDemo(): Promise<void> {
    await this.authService.loginAsDemoAthlete();
  }

  public async logout(): Promise<void> {
    await this.authService.logout();
    this.todayLog.set(null);
    this.historyLogs.set([]);
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
    await this.pedometer.requestNativePermission();
  }

  public async requestStepPermission(): Promise<void> {
    await this.pedometer.requestNativePermission();
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
    this.ppg.setActiveUserId(this.activeUserId());
    await this.ppg.startPpgScan(duration);
  }

  public stopCameraPpg(save: boolean = true): void {
    if (save) {
      this.ppg.completePpgScan(this.activeUserId());
    } else {
      this.ppg.stopPpgScan(false);
    }
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
    const mins = Math.round(minutes % 60);
    return `${hrs}h ${mins}m`;
  }

  // Vagus Resonance Pacer Logic (0.1 Hz Baroreflex Cadence: 4s Inhale, 2s Hold, 6s Exhale)
  public toggleVagusPacer(): void {
    if (this.showVagusPacer()) {
      this.stopVagusPacer();
    } else {
      this.startVagusPacer();
    }
  }

  public startVagusPacer(): void {
    this.showVagusPacer.set(true);
    this.pacerPhase.set('INHALE');
    this.pacerSecondsLeft.set(4);

    if (this.pacerIntervalId) clearInterval(this.pacerIntervalId);

    this.pacerIntervalId = setInterval(() => {
      const remaining = this.pacerSecondsLeft() - 1;
      if (remaining > 0) {
        this.pacerSecondsLeft.set(remaining);
      } else {
        // Cycle phase
        const currentPhase = this.pacerPhase();
        if (currentPhase === 'INHALE') {
          this.pacerPhase.set('HOLD');
          this.pacerSecondsLeft.set(2);
        } else if (currentPhase === 'HOLD') {
          this.pacerPhase.set('EXHALE');
          this.pacerSecondsLeft.set(6);
        } else {
          this.pacerPhase.set('INHALE');
          this.pacerSecondsLeft.set(4);
        }
      }
    }, 1000);
  }

  public stopVagusPacer(): void {
    this.showVagusPacer.set(false);
    if (this.pacerIntervalId) {
      clearInterval(this.pacerIntervalId);
      this.pacerIntervalId = null;
    }
  }

  public toggleAlgorithmInspector(): void {
    this.showAlgorithmInspector.set(!this.showAlgorithmInspector());
  }

  // Athlete Profile Modal Methods
  public openProfileModal(): void {
    const demo = this.athleteDemographics();
    this.editGender.set(demo.gender);
    this.editAge.set(demo.age);
    this.editWeightKg.set(demo.weightKg);
    this.editHeightCm.set(demo.heightCm);
    this.editStepGoal.set(this.stepGoal());
    this.showProfileModal.set(true);
  }

  public closeProfileModal(): void {
    this.showProfileModal.set(false);
  }

  public async saveProfileSettings(): Promise<void> {
    this.isProfileSaving.set(true);
    try {
      const uid = this.activeUserId();
      await this.authService.updateDemographics(
        uid,
        {
          gender: this.editGender(),
          age: Number(this.editAge()),
          weightKg: Number(this.editWeightKg()),
          heightCm: Number(this.editHeightCm()),
        },
        {
          dailyStepGoal: Number(this.editStepGoal()),
        }
      );
      this.closeProfileModal();
    } finally {
      this.isProfileSaving.set(false);
    }
  }

  // Step Sync from StepUp / Health Modal
  public readonly showStepSyncModal = signal<boolean>(false);
  public readonly manualStepsInput = signal<number>(0);

  public openStepSyncModal(): void {
    this.manualStepsInput.set(this.liveSteps());
    this.showStepSyncModal.set(true);
  }

  public closeStepSyncModal(): void {
    this.showStepSyncModal.set(false);
  }

  public confirmStepSync(): void {
    const steps = Math.max(0, Math.round(this.manualStepsInput()));
    this.pedometer.setManualStepCount(steps, this.activeUserId(), this.todayLog()?.date);
    this.closeStepSyncModal();
  }

  public quickAddSteps(amount: number): void {
    this.manualStepsInput.set(Math.max(0, this.manualStepsInput() + amount));
  }

  // Email Login Modal
  public readonly showEmailLoginModal = signal<boolean>(false);
  public readonly emailInput = signal<string>('');
  public readonly passwordInput = signal<string>('');

  public async submitEmailLogin(): Promise<void> {
    if (!this.emailInput() || !this.passwordInput()) return;
    const user = await this.authService.loginWithEmail(this.emailInput(), this.passwordInput());
    if (user) {
      this.showEmailLoginModal.set(false);
      this.emailInput.set('');
      this.passwordInput.set('');
    }
  }
}
