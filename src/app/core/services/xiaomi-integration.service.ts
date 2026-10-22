import { Injectable, inject, signal } from '@angular/core';
import { DataBridgeService } from './data-bridge.service';
import { PhysicsEngineService } from './physics-engine.service';
import { DailyBiometricLog } from '../models/biometrics.interface';

export interface XiaomiImportSummary {
  date: string;
  totalSleepMin: number;
  deepSleepMin: number;
  remSleepMin: number;
  restingHR: number;
  steps: number;
  calculatedRecovery: number;
}

@Injectable({
  providedIn: 'root',
})
export class XiaomiIntegrationService {
  private readonly dataBridge = inject(DataBridgeService);
  private readonly physicsEngine = inject(PhysicsEngineService);

  public readonly lastImport = signal<XiaomiImportSummary | null>(null);
  public readonly isImporting = signal<boolean>(false);
  public readonly importError = signal<string | null>(null);

  constructor() {}

  /**
   * Parse exported JSON from Mi Fitness (Xiaomi Cloud export) or Gadgetbridge (open-source)
   */
  public async parseAndIngestXiaomiJson(fileContent: string, userId: string): Promise<XiaomiImportSummary | null> {
    this.isImporting.set(true);
    this.importError.set(null);

    try {
      const data = JSON.parse(fileContent);
      let sleepMinutes = 0;
      let deepMinutes = 0;
      let remMinutes = 0;
      let restingHR = 55;
      let steps = 0;
      let targetDate = new Date().toISOString().slice(0, 10);

      // 1. Check for Gadgetbridge Activity/Sleep format
      if (Array.isArray(data)) {
        // Gadgetbridge records array
        let totalDeep = 0;
        let totalLight = 0;
        let totalRem = 0;
        let totalSteps = 0;

        for (const item of data) {
          if (item.timestamp) {
            targetDate = new Date(item.timestamp * 1000).toISOString().slice(0, 10);
          }
          if (item.activity_type === 2 || item.type === 'deep_sleep') totalDeep += 1;
          if (item.activity_type === 1 || item.type === 'light_sleep') totalLight += 1;
          if (item.activity_type === 3 || item.type === 'rem_sleep') totalRem += 1;
          if (item.steps) totalSteps += item.steps;
          if (item.heart_rate && item.heart_rate > 35 && item.heart_rate < 100) {
            restingHR = item.heart_rate;
          }
        }

        deepMinutes = totalDeep;
        remMinutes = totalRem;
        sleepMinutes = totalDeep + totalLight + totalRem;
        steps = totalSteps;
      }
      // 2. Check for standard Mi Fitness export JSON structure
      else if (data.sleep || data.sleep_data || data.records) {
        const sleepObj = data.sleep || data.sleep_data || data;
        sleepMinutes = sleepObj.duration || sleepObj.total_sleep_time || (sleepObj.bedtime ? Math.round((sleepObj.wake_time - sleepObj.bedtime) / 60) : 450);
        deepMinutes = sleepObj.deep_sleep_duration || sleepObj.deep_sleep_minutes || Math.round(sleepMinutes * 0.20);
        remMinutes = sleepObj.rem_sleep_duration || sleepObj.rem_sleep_minutes || Math.round(sleepMinutes * 0.22);
        restingHR = data.resting_heart_rate || data.rhr || data.avg_heart_rate || 54;
        steps = data.steps || data.total_steps || (data.activity ? data.activity.steps : 8500);

        if (data.date) {
          targetDate = String(data.date).slice(0, 10);
        }
      }
      // 3. Generic fallback parser (key/value search)
      else {
        sleepMinutes = Number(data.sleepMinutes || data.sleep_minutes || data.duration || 440);
        deepMinutes = Number(data.deepSleepMinutes || data.deep_sleep || 85);
        remMinutes = Number(data.remSleepMinutes || data.rem_sleep || 95);
        restingHR = Number(data.restingHR || data.rhr || 56);
        steps = Number(data.steps || data.step_count || 7500);
      }

      // Safeguards
      sleepMinutes = Math.max(60, sleepMinutes);
      deepMinutes = Math.min(sleepMinutes, Math.max(10, deepMinutes));
      remMinutes = Math.min(sleepMinutes, Math.max(10, remMinutes));
      restingHR = Math.max(38, Math.min(100, restingHR));

      // Calculate estimated overnight RMSSD from nocturnal sleep architecture & resting HR
      const restorativeRatio = (deepMinutes + remMinutes) / sleepMinutes;
      const estimatedRMSSD = Math.round((55.0 * restorativeRatio * (60.0 / restingHR)) * 10) / 10;

      // Ingest into Vagus
      await this.dataBridge.recordReadinessScan(estimatedRMSSD, restingHR, userId);
      await this.dataBridge.updateLiveSteps(userId, targetDate, steps);

      const recoveryPercent = this.physicsEngine.computeDailyRecoveryPercent(
        estimatedRMSSD,
        58.0,
        restingHR,
        52.0
      );

      const summary: XiaomiImportSummary = {
        date: targetDate,
        totalSleepMin: sleepMinutes,
        deepSleepMin: deepMinutes,
        remSleepMin: remMinutes,
        restingHR,
        steps,
        calculatedRecovery: recoveryPercent,
      };

      this.lastImport.set(summary);
      return summary;
    } catch (err: any) {
      console.warn('[XiaomiIntegration] Parsing failed:', err);
      this.importError.set('Invalid JSON format. Please upload a valid Mi Fitness or Gadgetbridge export file.');
      return null;
    } finally {
      this.isImporting.set(false);
    }
  }
}
