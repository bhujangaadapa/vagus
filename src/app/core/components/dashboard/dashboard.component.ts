import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { AuthService } from '../../services/auth.service';
import { DataBridgeService } from '../../services/data-bridge.service';
import { PhysicsEngineService } from '../../services/physics-engine.service';
import { PedometerService } from '../../services/pedometer.service';
import { BleHeartRateService, BleWorkoutTimelinePoint, SportActivityDef, AVAILABLE_SPORTS } from '../../services/ble-heart-rate.service';
import { CameraPpgService } from '../../services/camera-ppg.service';
import { FitbitIntegrationService } from '../../services/fitbit-integration.service';
import { SmartScaleService } from '../../services/smart-scale.service';
import { DailyBiometricLog, JournalHabits, RecordedWorkoutActivity } from '../../models/biometrics.interface';

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
  public readonly physicsEngine = inject(PhysicsEngineService);
  public readonly pedometer = inject(PedometerService);
  public readonly bleHR = inject(BleHeartRateService);
  public readonly ppg = inject(CameraPpgService);
  public readonly fitbit = inject(FitbitIntegrationService);
  public readonly smartScale = inject(SmartScaleService);

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
    const pSteps = this.pedometer.currentSteps() === 11000 ? 0 : this.pedometer.currentSteps();
    let fbSteps = this.todayLog()?.biometrics?.steps ?? 0;
    if (fbSteps === 11000) fbSteps = 0; // Filter legacy synthetic 11,000
    let fitbitSteps = this.fitbit.lastImport()?.steps ?? 0;
    if (fitbitSteps === 11000 || fitbitSteps === 8420) fitbitSteps = 0;
    const localSteps = this.pedometer.getStoredStepsForToday();
    return Math.max(pSteps, fbSteps, fitbitSteps, localSteps, 0);
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
  public readonly totalCaloriesBurned = computed(() => {
    const demo = this.athleteDemographics();
    const bmr = Math.round(
      10 * demo.weightKg + 6.25 * demo.heightCm - 5 * demo.age + (demo.gender === 'female' ? -161 : 5)
    );
    return bmr + this.estimatedActiveCalories();
  });

  // Authentic WHOOP 4.0 Health Monitor Vitals (All 5 Key Biomarkers)
  public readonly keyVitals = computed(() => {
    const log = this.todayLog();
    const baseHRV = this.authService.userProfile()?.baseline.baselineRMSSD || 58;
    const baseRHR = this.authService.userProfile()?.baseline.baselineRHR || 52;
    const currentRMSSD = log?.biometrics.overnightRMSSD || baseHRV;
    const currentRHR = log?.biometrics.restingHR || baseRHR;
    const respRate = log?.biometrics.respiratoryRate || 14.8;
    const spO2 = log?.biometrics.bloodOxygenSpO2 || 98;
    const skinTempVar = log?.biometrics.skinTempVarianceCelsius ?? -0.1;

    return {
      hrv: {
        value: currentRMSSD,
        unit: 'ms',
        status: currentRMSSD >= baseHRV * 0.9 ? 'TYPICAL' : 'LOW',
        baseline: `${Math.round(baseHRV * 0.88)}–${Math.round(baseHRV * 1.15)} ms`,
      },
      rhr: {
        value: currentRHR,
        unit: 'bpm',
        status: currentRHR <= baseRHR * 1.08 ? 'TYPICAL' : 'ELEVATED',
        baseline: `${Math.round(baseRHR * 0.92)}–${Math.round(baseRHR * 1.08)} bpm`,
      },
      respiratoryRate: {
        value: respRate,
        unit: 'rpm',
        status: respRate <= 16.5 ? 'TYPICAL' : 'ELEVATED',
        baseline: '14.0–15.8 rpm',
      },
      bloodOxygen: {
        value: spO2,
        unit: '%',
        status: spO2 >= 95 ? 'TYPICAL' : 'LOW',
        baseline: '95–99 %',
      },
      skinTemp: {
        value: skinTempVar > 0 ? `+${skinTempVar.toFixed(1)}` : `${skinTempVar.toFixed(1)}`,
        unit: '°C',
        status: Math.abs(skinTempVar) <= 0.5 ? 'TYPICAL' : 'ELEVATED',
        baseline: '-0.5 to +0.5 °C',
      },
    };
  });

  // Active Pillar Navigation (WHOOP 4.0 Tabs: Overview, Recovery, Strain, Sleep, Sensors)
  public readonly activePillar = signal<'overview' | 'recovery' | 'strain' | 'sleep' | 'sensors'>('overview');
  public setPillar(pillar: 'overview' | 'recovery' | 'strain' | 'sleep' | 'sensors'): void {
    this.activePillar.set(pillar);
  }

  // Active Hardware Sub-Tab in Sensors & Lab
  public readonly activeHardwareTab = signal<'polar' | 'ppg' | 'fitbit' | 'scale' | 'steps' | 'pacer' | 'algorithms'>('polar');
  public setHardwareTab(tab: 'polar' | 'ppg' | 'fitbit' | 'scale' | 'steps' | 'pacer' | 'algorithms'): void {
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

  // WHOOP 3-Dial Mini Gauges (Radius 38, Circumference ~238.76)
  public readonly dialRadius = 38;
  public readonly dialCircumference = 2 * Math.PI * 38;

  public readonly sleepStrokeOffset = computed(() => {
    const pct = Math.min(100, Math.max(0, this.sleepPerformancePercent()));
    return this.dialCircumference * (1 - pct / 100);
  });

  public readonly recoveryStrokeOffset = computed(() => {
    const score = Math.min(100, Math.max(0, this.recoveryScore()));
    return this.dialCircumference * (1 - score / 100);
  });

  public readonly strainStrokeOffset = computed(() => {
    // WHOOP Strain is 0 to 21
    const s = Math.min(21, Math.max(0, this.strainScore()));
    return this.dialCircumference * (1 - s / 21);
  });

  // WHOOP Top Date Selector & Battery
  public readonly selectedDayOffset = signal<number>(0);
  public readonly isViewingToday = computed(() => this.selectedDayOffset() === 0);
  public readonly activeDisplayDateLabel = computed(() => {
    const offset = this.selectedDayOffset();
    if (offset === 0) return 'TODAY';
    if (offset === -1) return 'YESTERDAY';
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  });

  public readonly strapBatteryLevel = computed(() => {
    return this.bleHR.isConnected() ? 92 : 54;
  });

  // WHOOP Health & Stress Monitor status
  public readonly allVitalsNormal = computed(() => {
    const v = this.keyVitals();
    return (
      v.hrv.status === 'TYPICAL' &&
      v.rhr.status === 'TYPICAL' &&
      v.respiratoryRate.status === 'TYPICAL' &&
      v.bloodOxygen.status === 'TYPICAL' &&
      v.skinTemp.status === 'TYPICAL'
    );
  });

  public readonly currentStressScore = computed(() => {
    const rhr = this.todayLog()?.biometrics?.restingHR || 58;
    const liveHr = this.bleHR.liveBpm() || rhr;
    const ratio = Math.max(0, (liveHr - rhr) / Math.max(20, this.calibratedMaxHR() - rhr));
    const stress = Math.min(3.0, Math.max(0.4, Math.round((1.0 + ratio * 1.5) * 10) / 10));
    return stress.toFixed(1);
  });

  public readonly currentStressLabel = computed(() => {
    const s = parseFloat(this.currentStressScore());
    if (s < 1.0) return 'LOW';
    if (s <= 2.0) return 'MEDIUM';
    return 'HIGH';
  });

  public readonly currentFormattedTime = signal<string>(
    new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  );

  public readonly showDailyOutlook = signal<boolean>(false);
  public toggleDailyOutlook(): void {
    this.showDailyOutlook.set(!this.showDailyOutlook());
  }

  public goToPreviousDay(): void {
    const logs = this.historyLogs();
    const minOffset = -Math.max(1, logs.length - 1);
    if (this.selectedDayOffset() > minOffset) {
      this.selectedDayOffset.update((o) => o - 1);
      this.syncDisplayLogForOffset();
    }
  }

  public goToNextDay(): void {
    if (this.selectedDayOffset() < 0) {
      this.selectedDayOffset.update((o) => o + 1);
      this.syncDisplayLogForOffset();
    }
  }

  private syncDisplayLogForOffset(): void {
    const offset = this.selectedDayOffset();
    const logs = this.historyLogs();
    if (offset === 0) {
      if (logs.length > 0) this.todayLog.set(logs[logs.length - 1]);
    } else {
      const idx = logs.length - 1 + offset;
      if (idx >= 0 && idx < logs.length) {
        this.todayLog.set(logs[idx]);
      }
    }
  }

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
          const latest = logs[logs.length - 1];
          this.todayLog.set(latest);
          if (latest?.biometrics?.steps) {
            this.pedometer.reconcileSteps(latest.biometrics.steps);
          }
        }
      });
    });

    // Synchronize athlete demographics to BLE heart rate service for exact Digifit zones
    effect(() => {
      const age = this.athleteDemographics().age;
      this.bleHR.setAthleteAge(age);
    });
  }

  public ngOnInit(): void {
    this.dataBridge.logs$.subscribe((logs) => {
      this.historyLogs.set(logs);
      if (logs.length > 0) {
        const latest = logs[logs.length - 1];
        this.todayLog.set(latest);
        if (latest?.biometrics?.steps) {
          this.pedometer.reconcileSteps(latest.biometrics.steps);
        }
      }
    });

    this.dataBridge.todayLog$.subscribe((log) => {
      if (log) {
        this.todayLog.set(log);
        if (log?.biometrics?.steps) {
          this.pedometer.reconcileSteps(log.biometrics.steps);
        }
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

  public async forgetPolarDevice(): Promise<void> {
    await this.bleHR.forgetDevice();
  }

  public startMorningReadinessScan(duration: number = 60): void {
    this.bleHR.startReadinessScan(duration);
  }

  public stopMorningReadinessScan(save: boolean = true): void {
    this.bleHR.stopReadinessScan(save);
  }

  public async toggleWorkoutTracker(): Promise<void> {
    if (this.bleHR.workoutSession().isActive) {
      this.bleHR.finishWorkoutAndStartRecoveryTest();
    } else {
      if (!this.bleHR.isConnected()) {
        await this.bleHR.connect();
      }
      this.bleHR.startWorkout();
    }
  }

  public finishWorkoutWithVagalTest(): void {
    this.bleHR.finishWorkoutAndStartRecoveryTest();
  }

  public directStopWorkout(): void {
    this.bleHR.stopWorkout(true);
  }

  public completeOrSkipVagalTest(): void {
    this.bleHR.completeRecoveryTestAndCommit();
  }

  public dismissWorkoutSummary(): void {
    this.bleHR.dismissWorkoutSummary();
  }

  public selectWorkoutSport(sport: SportActivityDef): void {
    this.bleHR.setSelectedSport(sport);
  }

  // Manual Activity Logger Modal State
  public readonly showManualLogModal = signal<boolean>(false);
  public readonly manualSport = signal<SportActivityDef>(AVAILABLE_SPORTS[0]);
  public readonly manualDurationMinutes = signal<number>(45);
  public readonly manualEffort = signal<'LIGHT' | 'MODERATE' | 'HARD' | 'ALL_OUT'>('MODERATE');

  public openManualLogModal(sport?: SportActivityDef): void {
    if (sport) {
      this.manualSport.set(sport);
    }
    this.showManualLogModal.set(true);
  }

  public closeManualLogModal(): void {
    this.showManualLogModal.set(false);
  }

  public setManualSport(sport: SportActivityDef): void {
    this.manualSport.set(sport);
  }

  public setManualDuration(minutes: number): void {
    this.manualDurationMinutes.set(Math.max(5, Math.min(360, minutes)));
  }

  public setManualEffort(effort: 'LIGHT' | 'MODERATE' | 'HARD' | 'ALL_OUT'): void {
    this.manualEffort.set(effort);
  }

  public async logManualWorkout(): Promise<void> {
    const sport = this.manualSport();
    const duration = this.manualDurationMinutes();
    const effort = this.manualEffort();

    let estAvgBpm = 125;
    let baseStrain = 6.5;
    if (effort === 'LIGHT') {
      estAvgBpm = 105;
      baseStrain = 4.0;
    } else if (effort === 'MODERATE') {
      estAvgBpm = 130;
      baseStrain = 7.5;
    } else if (effort === 'HARD') {
      estAvgBpm = 155;
      baseStrain = 12.0;
    } else if (effort === 'ALL_OUT') {
      estAvgBpm = 175;
      baseStrain = 16.5;
    }

    const durationFactor = Math.pow(duration / 45, 0.7);
    const finalStrain = Math.round(Math.min(20.5, baseStrain * durationFactor) * 10) / 10;

    const weight = this.athleteDemographics().weightKg || 75;
    const calories = Math.round(sport.met * weight * (duration / 60));

    const activity: RecordedWorkoutActivity = {
      id: 'manual_' + Date.now(),
      sport: sport.id,
      sportName: sport.name,
      sportIcon: sport.icon,
      durationSeconds: duration * 60,
      avgBpm: estAvgBpm,
      maxBpm: Math.min(195, estAvgBpm + 25),
      strain: finalStrain,
      caloriesBurned: calories,
      timestamp: new Date().toISOString(),
    };

    await this.dataBridge.accumulateWorkoutStrain(finalStrain, this.activeUserId(), activity);
    this.showManualLogModal.set(false);
  }

  // Digifit Zone Ranges computed from athlete's calibrated max HR
  public readonly zoneRanges = computed(() => {
    const max = this.calibratedMaxHR();
    return {
      z1: `${Math.round(max * 0.50)}–${Math.round(max * 0.60) - 1}`,
      z2: `${Math.round(max * 0.60)}–${Math.round(max * 0.70) - 1}`,
      z3: `${Math.round(max * 0.70)}–${Math.round(max * 0.80) - 1}`,
      z4: `${Math.round(max * 0.80)}–${Math.round(max * 0.90) - 1}`,
      z5: `${Math.round(max * 0.90)}+`,
    };
  });

  public formatZoneDuration(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  public getZonePercent(zoneSec: number, totalSec: number): number {
    if (!totalSec || totalSec <= 0) return 0;
    return Math.round((zoneSec / totalSec) * 100);
  }

  // Generates SVG path for the Digifit multi-colored timeline ribbon
  public getWorkoutSvgPath(timeline: BleWorkoutTimelinePoint[]): string {
    if (!timeline || timeline.length < 2) {
      return 'M 0 50 L 320 50';
    }
    const width = 320;
    const height = 90;
    const paddingY = 8;
    const usableH = height - paddingY * 2;

    const bpms = timeline.map((p) => p.bpm);
    const minB = Math.max(40, Math.min(...bpms) - 5);
    const maxB = Math.max(minB + 20, Math.max(...bpms) + 5);
    const range = maxB - minB;

    const totalPts = timeline.length;
    return timeline.reduce((acc, pt, i) => {
      const x = (i / (totalPts - 1)) * width;
      const normalizedY = (pt.bpm - minB) / range;
      const y = height - paddingY - normalizedY * usableH;
      const roundedX = Math.round(x * 10) / 10;
      const roundedY = Math.round(y * 10) / 10;
      return i === 0 ? `M ${roundedX} ${roundedY}` : `${acc} L ${roundedX} ${roundedY}`;
    }, '');
  }

  public getWorkoutSvgFillPath(timeline: BleWorkoutTimelinePoint[]): string {
    const linePath = this.getWorkoutSvgPath(timeline);
    return `${linePath} L 320 90 L 0 90 Z`;
  }

  // Generates SVG path for 60-second Vagal Heart Rate Recovery Test
  public getRecoverySvgPath(samples: { sec: number; bpm: number }[]): string {
    if (!samples || samples.length < 2) {
      return 'M 0 30 L 320 60';
    }
    const width = 320;
    const height = 80;
    const startBpm = samples[0].bpm;
    const currentMin = Math.min(...samples.map((s) => s.bpm));
    const range = Math.max(15, startBpm - currentMin + 5);

    return samples.reduce((acc, pt, i) => {
      const x = (pt.sec / 60) * width;
      const drop = startBpm - pt.bpm;
      const y = 10 + (Math.max(0, drop) / range) * (height - 20);
      const roundedX = Math.round(x * 10) / 10;
      const roundedY = Math.round(y * 10) / 10;
      return i === 0 ? `M ${roundedX} ${roundedY}` : `${acc} L ${roundedX} ${roundedY}`;
    }, '');
  }

  public getRecoverySvgFillPath(samples: { sec: number; bpm: number }[]): string {
    const line = this.getRecoverySvgPath(samples);
    const lastX = samples && samples.length > 0 ? (samples[samples.length - 1].sec / 60) * 320 : 320;
    return `${line} L ${Math.round(lastX)} 80 L 0 80 Z`;
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

  // Fitbit JSON file importer
  public onFitbitFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      if (content) {
        await this.fitbit.parseAndIngestFitbitJson(content, this.activeUserId());
      }
    };
    reader.readAsText(file);
  }

  public async triggerFitbitSync(): Promise<void> {
    await this.fitbit.syncWithHealthConnect(this.activeUserId());
  }

  public async connectFitbitBroadcast(): Promise<void> {
    await this.fitbit.connectFitbitBroadcast();
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

  // GE Fit Profile Smart Scale Integration
  public readonly showScaleModal = signal<boolean>(false);
  public readonly scaleWeightInput = signal<number>(75);
  public readonly scaleBodyFatInput = signal<number | null>(null);

  public openManualScaleModal(): void {
    const demo = this.athleteDemographics();
    this.scaleWeightInput.set(this.smartScale.latestMeasurement()?.weightKg || demo.weightKg || 75);
    this.scaleBodyFatInput.set(this.smartScale.latestMeasurement()?.bodyFatPercent || demo.bodyFatPercent || null);
    this.showScaleModal.set(true);
  }

  public closeManualScaleModal(): void {
    this.showScaleModal.set(false);
  }

  public async saveManualScaleWeight(): Promise<void> {
    const w = Number(this.scaleWeightInput());
    const bf = this.scaleBodyFatInput() ? Number(this.scaleBodyFatInput()) : undefined;
    if (w > 20 && w < 350) {
      await this.smartScale.recordManualWeight(w, bf, this.activeUserId());
      this.closeManualScaleModal();
    }
  }

  public async syncScaleHealthConnect(): Promise<void> {
    await this.smartScale.syncWithHealthConnect(this.activeUserId());
  }

  public async openHealthConnectSettings(): Promise<void> {
    await this.smartScale.openHealthConnectSettings();
  }

  public async connectBleScale(): Promise<void> {
    await this.smartScale.connectBleScale(this.activeUserId());
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
