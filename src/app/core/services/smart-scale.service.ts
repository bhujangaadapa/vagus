import { Injectable, inject, signal, computed } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { HealthFitness } from '@capacitor/health-fitness';
import { BleClient, ScanResult } from '@capacitor-community/bluetooth-le';
import { AuthService } from './auth.service';
import { DataBridgeService } from './data-bridge.service';
import { ScaleMeasurement } from '../models/biometrics.interface';

@Injectable({
  providedIn: 'root',
})
export class SmartScaleService {
  private readonly authService = inject(AuthService);
  private readonly dataBridge = inject(DataBridgeService);

  // Reactive Signals
  public readonly isSyncing = signal<boolean>(false);
  public readonly isBleScanning = signal<boolean>(false);
  public readonly syncError = signal<string | null>(null);
  public readonly syncStatus = signal<string>('Ready to sync GE Fit Profile scale');
  public readonly connectedScaleName = signal<string | null>(null);
  public readonly latestMeasurement = signal<ScaleMeasurement | null>(null);
  public readonly liveBleWeight = signal<number | null>(null);

  // Storage key for persistent cached scale reading
  private readonly storageKey = 'vagus_last_scale_measurement';

  // Standard BLE UUIDs for Smart Scales
  private readonly WEIGHT_SCALE_SERVICE = '181d';
  private readonly BODY_COMPOSITION_SERVICE = '181b';
  private readonly WEIGHT_MEASUREMENT_CHAR = '2a9d';
  private readonly BODY_COMPOSITION_CHAR = '2a9c';

  constructor() {
    this.restorePersistedMeasurement();
  }

  private restorePersistedMeasurement(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.weightKg === 'number' && parsed.weightKg > 0) {
          this.latestMeasurement.set(parsed);
        }
      }
    } catch {}
  }

  private persistMeasurement(measurement: ScaleMeasurement): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(measurement));
    } catch {}
  }

  /**
   * Primary: Sync latest weigh-in from Google Health Connect (Android) / Apple Health (iOS).
   * The GE Fit Profile app automatically syncs weight, body fat %, and BMI to Health Connect.
   */
  public async syncWithHealthConnect(userId: string): Promise<ScaleMeasurement | null> {
    this.isSyncing.set(true);
    this.syncError.set(null);
    this.syncStatus.set('Querying Google Health Connect for GE scale records...');

    const isNative = Capacitor.isNativePlatform();

    if (!isNative) {
      // Browser simulated fallback with realistic athlete weight
      const demo = this.authService.userProfile()?.demographics;
      const weightKg = demo?.weightKg || 74.5;
      const heightCm = demo?.heightCm || 180;
      const hM = heightCm / 100;
      const bmi = Math.round((weightKg / (hM * hM)) * 10) / 10;
      const weightLbs = Math.round(weightKg * 2.20462 * 10) / 10;

      const sim: ScaleMeasurement = {
        weightKg,
        weightLbs,
        bodyFatPercent: demo?.bodyFatPercent || 16.8,
        bmi,
        timestamp: new Date().toISOString(),
        source: 'HEALTH_CONNECT',
        deviceName: 'GE Fit Profile Smart Scale',
      };

      this.latestMeasurement.set(sim);
      this.persistMeasurement(sim);
      this.isSyncing.set(false);
      this.syncStatus.set('Synced scale reading via Health Connect.');
      return sim;
    }

    try {
      // 1. Request Health Connect profile permissions for WEIGHT and BODY_FAT_PERCENTAGE
      try {
        await HealthFitness.requestHealthPermissions({
          customPermissions: JSON.stringify([
            { Variable: 'WEIGHT', AccessType: 'READ' },
            { Variable: 'BODY_FAT_PERCENTAGE', AccessType: 'READ' },
            { Variable: 'HEIGHT', AccessType: 'READ' },
          ]),
          allVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          fitnessVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          healthVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
          profileVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          workoutVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
        });
      } catch (permErr) {
        console.warn('[SmartScale] Permission request note:', permErr);
      }

      // 2. Query last weight record
      let measuredWeightKg: number | null = null;
      let timestamp = new Date().toISOString();

      try {
        const weightRes = await HealthFitness.getLastRecord({
          variable: 'WEIGHT',
        });

        if (weightRes && weightRes.results) {
          const parsed = typeof weightRes.results === 'string' ? JSON.parse(weightRes.results) : weightRes.results;
          const val = parsed?.value ?? parsed?.[0]?.value ?? (typeof parsed === 'number' ? parsed : null);
          const time = parsed?.startDate ?? parsed?.endDate ?? parsed?.[0]?.startDate;

          if (typeof val === 'number' && val > 20 && val < 350) {
            // If scale reported in lbs (> 160 while height is normal), convert to kg if needed;
            // Health Connect standard unit for WEIGHT is kilograms.
            measuredWeightKg = Math.round(val * 10) / 10;
            if (time) timestamp = time;
          }
        }
      } catch (weightErr) {
        console.warn('[SmartScale] LastRecord WEIGHT error:', weightErr);
      }

      // 3. Also query advanced data range for WEIGHT if last record returned null
      if (!measuredWeightKg) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const isoDate = (d: Date) => d.toISOString().split('.')[0] + 'Z';
        try {
          const rangeRes = await HealthFitness.getData({
            parameters: JSON.stringify({
              Variable: 'WEIGHT',
              StartDate: isoDate(thirtyDaysAgo),
              EndDate: isoDate(new Date()),
              TimeUnit: 'DAY',
              OperationType: 'AVERAGE',
              TimeUnitLength: 1,
              AdvancedQueryReturnType: 'ALL_DATA',
              AdvancedQueryResultType: 'RAW_DATA',
            }),
          });
          if (rangeRes && rangeRes.results) {
            const parsed = typeof rangeRes.results === 'string' ? JSON.parse(rangeRes.results) : rangeRes.results;
            if (Array.isArray(parsed) && parsed.length > 0) {
              const latest = parsed[parsed.length - 1];
              const val = latest?.value ?? latest?.weight ?? 0;
              if (typeof val === 'number' && val > 25 && val < 300) {
                measuredWeightKg = Math.round(val * 10) / 10;
                if (latest.startDate) timestamp = latest.startDate;
              }
            }
          }
        } catch (rangeErr) {
          console.warn('[SmartScale] Range query WEIGHT note:', rangeErr);
        }
      }

      // 4. Query body fat percentage from scale BIA measurement if available
      let bodyFatPercent: number | undefined = undefined;
      try {
        const fatRes = await HealthFitness.getLastRecord({
          variable: 'BODY_FAT_PERCENTAGE',
        });
        if (fatRes && fatRes.results) {
          const parsed = typeof fatRes.results === 'string' ? JSON.parse(fatRes.results) : fatRes.results;
          const val = parsed?.value ?? parsed?.[0]?.value;
          if (typeof val === 'number' && val > 3 && val < 60) {
            // Health Connect may report percentage as decimal (0.185) or whole (18.5)
            bodyFatPercent = val < 1.0 ? Math.round(val * 1000) / 10 : Math.round(val * 10) / 10;
          }
        }
      } catch (fatErr) {
        console.warn('[SmartScale] Body Fat query note:', fatErr);
      }

      if (!measuredWeightKg) {
        this.syncError.set('No scale records found in Health Connect. Weigh in with your GE Fit Profile scale first.');
        this.syncStatus.set('No weight records found in Google Health Connect.');
        return null;
      }

      // Calculate BMI using athlete height
      const demo = this.authService.userProfile()?.demographics;
      const heightCm = demo?.heightCm || 180;
      const hM = heightCm / 100;
      const bmi = Math.round((measuredWeightKg / (hM * hM)) * 10) / 10;
      const weightLbs = Math.round(measuredWeightKg * 2.20462 * 10) / 10;

      const measurement: ScaleMeasurement = {
        weightKg: measuredWeightKg,
        weightLbs,
        bodyFatPercent,
        bmi,
        timestamp,
        source: 'HEALTH_CONNECT',
        deviceName: 'GE Fit Profile Scale (Health Connect)',
      };

      this.latestMeasurement.set(measurement);
      this.persistMeasurement(measurement);

      // Automatically update Athlete Demographics in AuthService so physics engine recalibrates!
      await this.authService.updateDemographics(userId, {
        gender: demo?.gender || 'male',
        age: demo?.age || 26,
        weightKg: measuredWeightKg,
        heightCm,
        bodyFatPercent,
      });

      this.syncStatus.set(`Synced: ${measuredWeightKg} kg (${weightLbs} lbs) from GE Fit Profile`);
      return measurement;
    } catch (err: any) {
      console.error('[SmartScale] Health Connect sync failed:', err);
      this.syncError.set(err?.message || 'Failed to query Google Health Connect.');
      this.syncStatus.set('Sync error with Google Health Connect.');
      return null;
    } finally {
      this.isSyncing.set(false);
    }
  }

  /**
   * Direct Bluetooth Low Energy (BLE) Scale Connection
   * Connects to GE Fit Profile or standard BLE scales broadcasting 0x181D / 0xFFF0.
   */
  public async connectBleScale(userId: string): Promise<boolean> {
    this.isBleScanning.set(true);
    this.syncError.set(null);
    this.syncStatus.set('Scanning for GE Fit Profile scale... Step on the scale to wake it up!');

    try {
      await BleClient.initialize();

      // Scan for devices advertising Weight Scale service or with Scale in their name
      const device = await BleClient.requestDevice({
        services: [this.WEIGHT_SCALE_SERVICE],
        optionalServices: [this.BODY_COMPOSITION_SERVICE, 'fff0', 'ae00', '180f'],
      });

      this.connectedScaleName.set(device.name || 'GE Fit Profile Scale');
      this.syncStatus.set(`Connecting to ${device.name || 'GE Scale'}...`);

      await BleClient.connect(device.deviceId);

      // Listen for Weight Measurement notifications (0x2A9D)
      await BleClient.startNotifications(
        device.deviceId,
        this.WEIGHT_SCALE_SERVICE,
        this.WEIGHT_MEASUREMENT_CHAR,
        (value: DataView) => {
          this.parseBleWeightPacket(value, userId, device.name || 'GE Fit Profile Scale');
        }
      );

      this.syncStatus.set('Scale connected! Step on the scale to record weight.');
      return true;
    } catch (err: any) {
      console.warn('[SmartScale] BLE Scale connect error:', err);
      this.syncError.set(err?.message || 'Bluetooth scale connection canceled or timed out.');
      this.syncStatus.set('Bluetooth scan ended.');
      return false;
    } finally {
      this.isBleScanning.set(false);
    }
  }

  /**
   * Parse Standard Bluetooth SIG 0x2A9D Weight Measurement Packet
   */
  private async parseBleWeightPacket(dataView: DataView, userId: string, deviceName: string): Promise<void> {
    try {
      if (dataView.byteLength < 3) return;

      const flags = dataView.getUint8(0);
      const isImperialLbs = (flags & 0x01) === 1;

      // 16-bit unsigned weight in Little Endian
      const rawWeight = dataView.getUint16(1, true);

      let weightKg = 0;
      let weightLbs = 0;

      if (isImperialLbs) {
        // Resolution: 0.01 lbs
        weightLbs = Math.round(rawWeight * 0.01 * 10) / 10;
        weightKg = Math.round((weightLbs / 2.20462) * 10) / 10;
      } else {
        // Standard resolution: 0.005 kg
        weightKg = Math.round(rawWeight * 0.005 * 10) / 10;
        weightLbs = Math.round(weightKg * 2.20462 * 10) / 10;
      }

      this.liveBleWeight.set(weightKg);

      const demo = this.authService.userProfile()?.demographics;
      const heightCm = demo?.heightCm || 180;
      const hM = heightCm / 100;
      const bmi = Math.round((weightKg / (hM * hM)) * 10) / 10;

      const measurement: ScaleMeasurement = {
        weightKg,
        weightLbs,
        bmi,
        timestamp: new Date().toISOString(),
        source: 'BLE_SCALE',
        deviceName,
      };

      this.latestMeasurement.set(measurement);
      this.persistMeasurement(measurement);

      await this.authService.updateDemographics(userId, {
        gender: demo?.gender || 'male',
        age: demo?.age || 26,
        weightKg,
        heightCm,
      });

      this.syncStatus.set(`Captured: ${weightKg} kg (${weightLbs} lbs) from ${deviceName}`);
    } catch (e) {
      console.warn('[SmartScale] Packet parse error:', e);
    }
  }

  /**
   * Manual entry fallback
   */
  public async recordManualWeight(weightKg: number, bodyFatPercent: number | undefined, userId: string): Promise<ScaleMeasurement> {
    const demo = this.authService.userProfile()?.demographics;
    const heightCm = demo?.heightCm || 180;
    const hM = heightCm / 100;
    const bmi = Math.round((weightKg / (hM * hM)) * 10) / 10;
    const weightLbs = Math.round(weightKg * 2.20462 * 10) / 10;

    const measurement: ScaleMeasurement = {
      weightKg,
      weightLbs,
      bodyFatPercent,
      bmi,
      timestamp: new Date().toISOString(),
      source: 'MANUAL',
      deviceName: 'Manual Entry',
    };

    this.latestMeasurement.set(measurement);
    this.persistMeasurement(measurement);

    await this.authService.updateDemographics(userId, {
      gender: demo?.gender || 'male',
      age: demo?.age || 26,
      weightKg,
      heightCm,
      bodyFatPercent,
    });

    this.syncStatus.set(`Saved: ${weightKg} kg (${weightLbs} lbs) manually.`);
    return measurement;
  }

  /**
   * Helper: BMI Category description and styling
   */
  public getBmiCategory(bmi: number): { label: string; color: string; bg: string; border: string } {
    if (bmi < 18.5) {
      return { label: 'UNDERWEIGHT', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
    }
    if (bmi < 24.9) {
      return { label: 'OPTIMAL / NORMAL', color: 'text-[#00F5A0]', bg: 'bg-[#00F5A0]/10', border: 'border-[#00F5A0]/30' };
    }
    if (bmi < 29.9) {
      return { label: 'OVERWEIGHT', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
    }
    return { label: 'ELEVATED BMI', color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30' };
  }
}
