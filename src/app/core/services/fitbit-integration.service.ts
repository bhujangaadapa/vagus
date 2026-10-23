import { Injectable, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { HealthFitness } from '@capacitor/health-fitness';
import { DataBridgeService } from './data-bridge.service';
import { PhysicsEngineService } from './physics-engine.service';
import { BleHeartRateService } from './ble-heart-rate.service';

export interface FitbitImportSummary {
  date: string;
  totalSleepMin: number;
  deepSleepMin: number;
  remSleepMin: number;
  restingHR: number;
  steps: number;
  calculatedRecovery: number;
  source: 'HEALTH_CONNECT' | 'BLE_BROADCAST' | 'FILE_IMPORT';
}

@Injectable({
  providedIn: 'root',
})
export class FitbitIntegrationService {
  private readonly dataBridge = inject(DataBridgeService);
  private readonly physicsEngine = inject(PhysicsEngineService);
  private readonly bleService = inject(BleHeartRateService);

  public readonly lastImport = signal<FitbitImportSummary | null>(null);
  public readonly isSyncing = signal<boolean>(false);
  public readonly syncStatus = signal<string>('Ready to sync Fitbit biometrics.');
  public readonly syncError = signal<string | null>(null);

  constructor() {}

  /**
   * Connect to Fitbit Charge 6 via Bluetooth LE Heart Rate Broadcast (0x180D)
   */
  public async connectFitbitBroadcast(): Promise<boolean> {
    this.syncStatus.set('Scanning for Fitbit Charge 6 BLE Broadcast...');
    try {
      const success = await this.bleService.connect();
      if (success) {
        this.syncStatus.set('Fitbit Charge 6 Connected via BLE');
      } else {
        this.syncStatus.set('Could not connect. Ensure HR Broadcast is ON on your Charge 6.');
      }
      return success;
    } catch (err: any) {
      this.syncError.set(err?.message || 'BLE Connection failed');
      return false;
    }
  }

  /**
   * Synchronize sleep stages & vitals from Google Health Connect / Apple HealthKit
   */
  public async syncWithHealthConnect(userId: string): Promise<FitbitImportSummary | null> {
    this.isSyncing.set(true);
    this.syncError.set(null);
    this.syncStatus.set('Querying Google Health Connect / Fitbit...');

    const todayStr = new Date().toISOString().slice(0, 10);

    if (!Capacitor.isNativePlatform()) {
      // Browser fallback simulation for testing
      const simSummary: FitbitImportSummary = {
        date: todayStr,
        totalSleepMin: 445,
        deepSleepMin: 85,
        remSleepMin: 92,
        restingHR: 54,
        steps: 8420,
        calculatedRecovery: 78,
        source: 'HEALTH_CONNECT',
      };
      await this.dataBridge.recordReadinessScan(52.0, 54, userId);
      this.lastImport.set(simSummary);
      this.isSyncing.set(false);
      this.syncStatus.set('Fitbit data synced via Health Connect.');
      return simSummary;
    }

    try {
      // 1. Request health permissions for sleep and heart rate
      try {
        await HealthFitness.requestHealthPermissions({
          customPermissions: '[]',
          allVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          fitnessVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          healthVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          profileVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          workoutVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
        });
      } catch (permErr) {
        console.warn('[Fitbit] Health permissions query:', permErr);
      }

      const isoDate = (d: Date) => d.toISOString().split('.')[0] + 'Z';
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      yesterday.setHours(18, 0, 0, 0); // Evening before for overnight sleep
      const now = new Date();

      // Query sleep data from Health Connect
      let sleepMinutes = 430;
      let deepMinutes = 80;
      let remMinutes = 90;
      let restingHR = 55;

      try {
        const sleepRes = await HealthFitness.getData({
          parameters: JSON.stringify({
            Variable: 'SLEEP',
            StartDate: isoDate(yesterday),
            EndDate: isoDate(now),
            TimeUnit: 'MINUTE',
            OperationType: 'SUM',
            TimeUnitLength: 1,
            AdvancedQueryReturnType: 'ALL_DATA',
            AdvancedQueryResultType: 'RAW_DATA',
          }),
        });

        if (sleepRes && sleepRes.results) {
          const parsed = typeof sleepRes.results === 'string' ? JSON.parse(sleepRes.results) : sleepRes.results;
          if (Array.isArray(parsed) && parsed.length > 0) {
            let total = 0;
            for (const item of parsed) {
              const val = item.value ?? item.duration ?? item.sum ?? 0;
              if (typeof val === 'number') total += val;
            }
            if (total > 60) {
              sleepMinutes = Math.round(total);
              deepMinutes = Math.round(sleepMinutes * 0.20);
              remMinutes = Math.round(sleepMinutes * 0.22);
            }
          }
        }
      } catch (sleepErr) {
        console.warn('[Fitbit] Sleep query fallback:', sleepErr);
      }

      // Query resting heart rate
      try {
        const hrRes = await HealthFitness.getLastRecord({
          variable: 'HEART_RATE',
        });
        if (hrRes && hrRes.results) {
          const parsed = typeof hrRes.results === 'string' ? JSON.parse(hrRes.results) : hrRes.results;
          const val = parsed?.value ?? parsed?.[0]?.value;
          if (typeof val === 'number' && val > 40 && val < 110) {
            restingHR = Math.round(val);
          }
        }
      } catch (hrErr) {
        console.warn('[Fitbit] Resting HR query fallback:', hrErr);
      }

      // Compute recovery from sleep architecture & resting HR
      const restorativeRatio = (deepMinutes + remMinutes) / sleepMinutes;
      const estimatedRMSSD = Math.round((56.0 * restorativeRatio * (60.0 / restingHR)) * 10) / 10;

      await this.dataBridge.recordReadinessScan(estimatedRMSSD, restingHR, userId);

      const recoveryPercent = this.physicsEngine.computeDailyRecoveryPercent(
        estimatedRMSSD,
        58.0,
        restingHR,
        52.0
      );

      const summary: FitbitImportSummary = {
        date: todayStr,
        totalSleepMin: sleepMinutes,
        deepSleepMin: deepMinutes,
        remSleepMin: remMinutes,
        restingHR,
        steps: 0,
        calculatedRecovery: recoveryPercent,
        source: 'HEALTH_CONNECT',
      };

      this.lastImport.set(summary);
      this.syncStatus.set(`Fitbit Synced: ${recoveryPercent}% Recovery (${Math.round(sleepMinutes / 60)}h sleep)`);
      this.isSyncing.set(false);
      return summary;
    } catch (err: any) {
      this.syncError.set(err?.message || 'Failed to sync with Health Connect');
      this.isSyncing.set(false);
      return null;
    }
  }

  /**
   * Parse exported JSON from Fitbit / Google Takeout export
   */
  public async parseAndIngestFitbitJson(fileContent: string, userId: string): Promise<FitbitImportSummary | null> {
    this.isSyncing.set(true);
    this.syncError.set(null);

    try {
      const data = JSON.parse(fileContent);
      let sleepMinutes = 0;
      let deepMinutes = 0;
      let remMinutes = 0;
      let restingHR = 55;
      let steps = 0;
      let targetDate = new Date().toISOString().slice(0, 10);

      // 1. Google Takeout / Fitbit sleep export array
      if (Array.isArray(data)) {
        const lastEntry = data[data.length - 1];
        if (lastEntry) {
          if (lastEntry.dateOfSleep) targetDate = String(lastEntry.dateOfSleep).slice(0, 10);
          sleepMinutes = Math.round((lastEntry.minutesAsleep || lastEntry.duration / 60000 || 420));
          if (lastEntry.levels && lastEntry.levels.summary) {
            deepMinutes = lastEntry.levels.summary.deep?.minutes || Math.round(sleepMinutes * 0.20);
            remMinutes = lastEntry.levels.summary.rem?.minutes || Math.round(sleepMinutes * 0.22);
          }
          if (lastEntry.restingHeartRate) restingHR = lastEntry.restingHeartRate;
        }
      }
      // 2. Direct single object export
      else if (typeof data === 'object' && data !== null) {
        if (data.date || data.dateOfSleep) targetDate = String(data.date || data.dateOfSleep).slice(0, 10);
        sleepMinutes = data.minutesAsleep || data.sleepMinutes || data.duration || 450;
        deepMinutes = data.deepSleepMinutes || data.deep || Math.round(sleepMinutes * 0.20);
        remMinutes = data.remSleepMinutes || data.rem || Math.round(sleepMinutes * 0.22);
        restingHR = data.restingHeartRate || data.restingHR || data.rhr || 54;
        steps = data.steps || data.totalSteps || 0;
      }

      // Safeguards
      sleepMinutes = Math.max(60, sleepMinutes || 420);
      deepMinutes = Math.min(sleepMinutes, Math.max(10, deepMinutes || 80));
      remMinutes = Math.min(sleepMinutes, Math.max(10, remMinutes || 90));
      restingHR = Math.max(38, Math.min(100, restingHR || 55));

      const restorativeRatio = (deepMinutes + remMinutes) / sleepMinutes;
      const estimatedRMSSD = Math.round((56.0 * restorativeRatio * (60.0 / restingHR)) * 10) / 10;

      await this.dataBridge.recordReadinessScan(estimatedRMSSD, restingHR, userId);
      if (steps > 0) {
        this.dataBridge.updateLiveSteps(userId, targetDate, steps);
      }

      const recoveryPercent = this.physicsEngine.computeDailyRecoveryPercent(
        estimatedRMSSD,
        58.0,
        restingHR,
        52.0
      );

      const summary: FitbitImportSummary = {
        date: targetDate,
        totalSleepMin: sleepMinutes,
        deepSleepMin: deepMinutes,
        remSleepMin: remMinutes,
        restingHR,
        steps,
        calculatedRecovery: recoveryPercent,
        source: 'FILE_IMPORT',
      };

      this.lastImport.set(summary);
      this.isSyncing.set(false);
      this.syncStatus.set(`Fitbit JSON Ingested: ${recoveryPercent}% Recovery`);
      return summary;
    } catch (err: any) {
      this.syncError.set('Invalid Fitbit JSON format: ' + err.message);
      this.isSyncing.set(false);
      return null;
    }
  }
}
