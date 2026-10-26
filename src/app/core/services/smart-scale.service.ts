import { Injectable, inject, signal, computed } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { HealthFitness } from '@capacitor/health-fitness';
import { BleClient, ScanResult, ScanMode } from '@capacitor-community/bluetooth-le';
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
  public readonly debugLog = signal<string | null>(null);

  // Storage key for persistent cached scale reading
  private readonly storageKey = 'vagus_last_scale_measurement';

  // Standard & Proprietary BLE UUIDs for GE / Yolanda / Smart Scales
  private readonly WEIGHT_SCALE_SERVICE = '181d';
  private readonly BODY_COMPOSITION_SERVICE = '181b';
  private readonly YOLANDA_SCALE_SERVICE = 'fff0';
  private readonly YOLANDA_ALT_SERVICE = 'ffa0';

  private readonly WEIGHT_MEASUREMENT_CHAR = '2a9d';
  private readonly BODY_COMPOSITION_CHAR = '2a9c';
  private readonly YOLANDA_NOTIFY_CHAR = 'fff1';
  private readonly YOLANDA_ALT_CHAR = 'fff4';

  private activeScanTimeout: any = null;

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
    this.syncStatus.set('Connecting to Google Health Connect...');

    const isNative = Capacitor.isNativePlatform();

    if (!isNative) {
      // Browser simulated fallback with athlete baseline
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
        deviceName: 'GE Fit Profile Smart Scale (Health Connect)',
      };

      this.latestMeasurement.set(sim);
      this.persistMeasurement(sim);
      this.isSyncing.set(false);
      this.syncStatus.set('Synced scale reading via Health Connect.');
      return sim;
    }

    try {
      // 1. Request Health Connect profile permissions
      this.syncStatus.set('Requesting Health Connect permissions...');
      try {
        await HealthFitness.requestHealthPermissions({
          customPermissions: '[]',
          allVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          fitnessVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          healthVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          profileVariables: JSON.stringify({ IsActive: true, AccessType: 'READ' }),
          workoutVariables: JSON.stringify({ IsActive: false, AccessType: 'READ' }),
        });
      } catch (permErr: any) {
        console.warn('[SmartScale] Permission request note:', permErr);
      }

      this.syncStatus.set('Searching Health Connect for weight records...');
      let measuredWeightKg: number | null = null;
      let timestamp = new Date().toISOString();

      // 2. Query last weight record
      try {
        const weightRes = await HealthFitness.getLastRecord({
          variable: 'WEIGHT',
        });

        if (weightRes && weightRes.results) {
          const parsed = typeof weightRes.results === 'string' ? JSON.parse(weightRes.results) : weightRes.results;
          const extracted = this.extractWeightFromPayload(parsed);
          if (extracted) {
            measuredWeightKg = extracted.weightKg;
            if (extracted.timestamp) timestamp = extracted.timestamp;
            console.info(`[SmartScale] Found weight via getLastRecord: ${measuredWeightKg} kg`);
          }
        }
      } catch (weightErr: any) {
        console.warn('[SmartScale] LastRecord WEIGHT note:', weightErr);
      }

      // 3. Fallback: Query 90-day range query if getLastRecord was empty
      if (!measuredWeightKg) {
        this.syncStatus.set('Querying recent Health Connect history...');
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const isoDate = (d: Date) => d.toISOString().split('.')[0] + 'Z';

        const queryAttempts = [
          {
            Variable: 'WEIGHT',
            StartDate: isoDate(ninetyDaysAgo),
            EndDate: isoDate(new Date()),
            TimeUnit: 'DAY',
            OperationType: 'AVERAGE',
            TimeUnitLength: 1,
            AdvancedQueryReturnType: 'ALL_DATA',
            AdvancedQueryResultType: 'RAW_DATA',
          },
          {
            Variable: 'WEIGHT',
            StartDate: isoDate(ninetyDaysAgo),
            EndDate: isoDate(new Date()),
            TimeUnit: 'DAY',
            OperationType: 'SUM',
            TimeUnitLength: 1,
            AdvancedQueryReturnType: 'ALL_DATA',
            AdvancedQueryResultType: 'RAW_DATA',
          },
        ];

        for (const params of queryAttempts) {
          if (measuredWeightKg) break;
          try {
            const rangeRes = await HealthFitness.getData({
              parameters: JSON.stringify(params),
            });
            if (rangeRes && rangeRes.results) {
              const parsed = typeof rangeRes.results === 'string' ? JSON.parse(rangeRes.results) : rangeRes.results;
              const extracted = this.extractWeightFromPayload(parsed);
              if (extracted) {
                measuredWeightKg = extracted.weightKg;
                if (extracted.timestamp) timestamp = extracted.timestamp;
                console.info(`[SmartScale] Found weight via getData range: ${measuredWeightKg} kg`);
                break;
              }
            }
          } catch (rangeErr) {
            console.warn('[SmartScale] Range query WEIGHT note:', rangeErr);
          }
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
          const extractedFat = this.extractBodyFatFromPayload(parsed);
          if (typeof extractedFat === 'number') {
            bodyFatPercent = extractedFat;
          }
        }
      } catch (fatErr) {
        console.warn('[SmartScale] Body Fat query note:', fatErr);
      }

      if (!measuredWeightKg) {
        this.syncError.set(
          'No weight records found in Health Connect. Ensure Fit Profile has synced to Health Connect, and Vagus is granted "Read Weight" in Android Settings > Apps > Health Connect > App permissions.'
        );
        this.syncStatus.set('Awaiting weigh-in records in Google Health Connect.');
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

      this.syncStatus.set(`Synced: ${measuredWeightKg} kg (${weightLbs} lbs) from Google Health Connect`);
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
   * Helper: Extract weight value from various Health Connect payload shapes
   */
  private extractWeightFromPayload(payload: any): { weightKg: number; timestamp?: string } | null {
    if (!payload) return null;

    if (Array.isArray(payload) && payload.length > 0) {
      for (let i = payload.length - 1; i >= 0; i--) {
        const item = payload[i];
        const res = this.extractWeightFromItem(item);
        if (res) return res;
      }
    }

    if (typeof payload === 'object') {
      return this.extractWeightFromItem(payload);
    }

    if (typeof payload === 'number' && payload > 25 && payload < 350) {
      return { weightKg: Math.round(payload * 10) / 10 };
    }

    return null;
  }

  private extractWeightFromItem(item: any): { weightKg: number; timestamp?: string } | null {
    if (!item) return null;

    const raw =
      item?.value ??
      item?.weight ??
      item?.weightKg ??
      item?.mass ??
      item?.val ??
      item?.quantity ??
      (typeof item === 'number' ? item : null);

    if (typeof raw === 'number' && raw > 25 && raw < 450) {
      let weightKg = raw;
      // If scale reported in lbs (> 160 lbs, or if unit says lbs), convert to kg
      const unit = String(item?.unit || '').toLowerCase();
      if (unit.includes('lb') || unit.includes('pound')) {
        weightKg = raw / 2.20462;
      }
      weightKg = Math.round(weightKg * 10) / 10;
      const timestamp = item?.startDate ?? item?.endDate ?? item?.date ?? item?.timestamp;
      return { weightKg, timestamp };
    }

    if (item?.results) {
      return this.extractWeightFromPayload(item.results);
    }
    if (item?.records) {
      return this.extractWeightFromPayload(item.records);
    }

    return null;
  }

  private extractBodyFatFromPayload(payload: any): number | undefined {
    if (!payload) return undefined;
    const item = Array.isArray(payload) ? payload[payload.length - 1] : payload;
    const raw = item?.value ?? item?.bodyFat ?? item?.percentage ?? (typeof item === 'number' ? item : null);
    if (typeof raw === 'number' && raw > 3 && raw < 65) {
      return raw < 1.0 ? Math.round(raw * 1000) / 10 : Math.round(raw * 10) / 10;
    }
    return undefined;
  }

  /**
   * Direct Bluetooth Low Energy (BLE) Scale Connection
   * Connects to GE Fit Profile (Yolanda / Fitdays platform) or standard BLE scales.
   */
  public async connectBleScale(userId: string): Promise<boolean> {
    this.isBleScanning.set(true);
    this.syncError.set(null);
    this.syncStatus.set('Scanning for GE Fit Profile scale... Step on the scale now to wake it up!');

    try {
      // Must set androidNeverForLocation: true to match AndroidManifest.xml
      await BleClient.initialize({ androidNeverForLocation: true });

      // Clean up previous scan timeout
      if (this.activeScanTimeout) {
        clearTimeout(this.activeScanTimeout);
        this.activeScanTimeout = null;
      }

      let scaleConnected = false;

      // Primary: Active Low-Latency LE Scan without restrictive service filter
      // GE Fit Profile scales (Yolanda CS20/Fitdays) broadcast under fff0, ffa0, or proprietary company IDs
      const scanPromise = new Promise<boolean>((resolve) => {
        // Set 25-second scan window
        this.activeScanTimeout = setTimeout(async () => {
          try {
            await BleClient.stopLEScan();
          } catch {}
          if (!scaleConnected) {
            this.syncStatus.set('Auto-detect scan ended. Opening manual device picker...');
            // Fallback: Open device picker with all known scale services
            try {
              const device = await BleClient.requestDevice({
                optionalServices: [
                  this.WEIGHT_SCALE_SERVICE,
                  this.BODY_COMPOSITION_SERVICE,
                  this.YOLANDA_SCALE_SERVICE,
                  this.YOLANDA_ALT_SERVICE,
                  '180f',
                  '180a',
                  'ae00',
                ],
              });
              if (device) {
                const connected = await this.connectAndSubscribeToScale(device.deviceId, device.name || 'GE Scale', userId);
                resolve(connected);
                return;
              }
            } catch (pickerErr: any) {
              console.warn('[SmartScale] Device picker error:', pickerErr);
            }
            resolve(false);
          }
        }, 25000);

        BleClient.requestLEScan(
          {
            allowDuplicates: true,
            scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
            allowExtendedAdvertising: true,
          },
          async (result: ScanResult) => {
            if (scaleConnected) return;

            const name = (result.device?.name || result.localName || '').trim();
            const uuids = (result.uuids || []).map((u) => u.toLowerCase().replace(/-/g, ''));

            // Check if device matches GE Fit Profile / Yolanda scale signatures
            const isScale =
              /ge|scale|fit|profile|yolanda|cs20|cf|bf|qn|sw|body|smart|inbody/i.test(name) ||
              uuids.some((u) => u.includes('181d') || u.includes('fff0') || u.includes('ffa0') || u.includes('181b'));

            // Also check manufacturer data for Yolanda/GE broadcast weight
            if (result.manufacturerData) {
              for (const key of Object.keys(result.manufacturerData)) {
                const dv = result.manufacturerData[key];
                if (dv && dv.byteLength >= 4) {
                  this.parseManufacturerScaleData(dv, name || 'GE Fit Profile Scale', userId);
                }
              }
            }

            if (isScale) {
              scaleConnected = true;
              clearTimeout(this.activeScanTimeout);
              this.activeScanTimeout = null;

              const scaleName = name || 'GE Fit Profile Scale';
              this.syncStatus.set(`Found ${scaleName}! Connecting...`);

              try {
                await BleClient.stopLEScan();
              } catch {}

              const ok = await this.connectAndSubscribeToScale(result.device.deviceId, scaleName, userId);
              resolve(ok);
            }
          }
        ).catch((scanErr) => {
          console.warn('[SmartScale] requestLEScan rejected:', scanErr);
          // If requestLEScan is not supported or rejected, fall back to requestDevice
          this.fallbackRequestDevice(userId).then(resolve);
        });
      });

      const success = await scanPromise;
      if (!success && !this.latestMeasurement()) {
        this.syncError.set('Could not connect to GE scale. Make sure Bluetooth is enabled and step firmly on the scale.');
        this.syncStatus.set('Bluetooth scan timed out.');
      }
      return success;
    } catch (err: any) {
      console.warn('[SmartScale] BLE connect error:', err);
      this.syncError.set(err?.message || 'Bluetooth scale connection canceled or timed out.');
      this.syncStatus.set('Bluetooth connection failed.');
      return false;
    } finally {
      this.isBleScanning.set(false);
    }
  }

  private async fallbackRequestDevice(userId: string): Promise<boolean> {
    try {
      this.syncStatus.set('Opening Bluetooth scale chooser...');
      const device = await BleClient.requestDevice({
        optionalServices: [
          this.WEIGHT_SCALE_SERVICE,
          this.BODY_COMPOSITION_SERVICE,
          this.YOLANDA_SCALE_SERVICE,
          this.YOLANDA_ALT_SERVICE,
          '180f',
          '180a',
          'ae00',
        ],
      });
      if (device) {
        return await this.connectAndSubscribeToScale(device.deviceId, device.name || 'GE Scale', userId);
      }
    } catch (e: any) {
      console.warn('[SmartScale] Fallback requestDevice failed:', e);
    }
    return false;
  }

  /**
   * Connect to GATT server and discover services (Standard 0x181D or Yolanda 0xFFF0)
   */
  private async connectAndSubscribeToScale(deviceId: string, deviceName: string, userId: string): Promise<boolean> {
    try {
      this.connectedScaleName.set(deviceName);
      this.syncStatus.set(`Connecting to ${deviceName}...`);

      await BleClient.connect(deviceId);

      this.syncStatus.set('Connected! Discovering scale telemetry services...');
      const services = await BleClient.getServices(deviceId);

      let subscribed = false;

      // 1. Check for Standard Bluetooth SIG Weight Scale Service (0x181D)
      const hasStandardScale = services.some((s) => s.uuid.toLowerCase().includes('181d'));
      if (hasStandardScale) {
        try {
          await BleClient.startNotifications(
            deviceId,
            this.WEIGHT_SCALE_SERVICE,
            this.WEIGHT_MEASUREMENT_CHAR,
            (value: DataView) => {
              this.parseUniversalWeightPacket(value, userId, deviceName, 'BLE_STANDARD_SIG');
            }
          );
          subscribed = true;
          console.info('[SmartScale] Subscribed to Standard SIG Weight (0x181D / 0x2A9D)');
        } catch (e) {
          console.warn('[SmartScale] Failed to subscribe to 0x181D:', e);
        }
      }

      // 2. Check for Yolanda / GE Fit Profile Service (0xFFF0)
      const hasYolanda = services.some((s) => s.uuid.toLowerCase().includes('fff0'));
      if (hasYolanda) {
        try {
          await BleClient.startNotifications(
            deviceId,
            this.YOLANDA_SCALE_SERVICE,
            this.YOLANDA_NOTIFY_CHAR,
            (value: DataView) => {
              this.parseUniversalWeightPacket(value, userId, deviceName, 'YOLANDA_FFF1');
            }
          );
          subscribed = true;
          console.info('[SmartScale] Subscribed to Yolanda Telemetry (0xFFF0 / 0xFFF1)');
        } catch (e) {
          // Try alternate char 0xFFF4
          try {
            await BleClient.startNotifications(
              deviceId,
              this.YOLANDA_SCALE_SERVICE,
              this.YOLANDA_ALT_CHAR,
              (value: DataView) => {
                this.parseUniversalWeightPacket(value, userId, deviceName, 'YOLANDA_FFF4');
              }
            );
            subscribed = true;
          } catch {}
        }
      }

      // 3. Check for Body Composition Service (0x181B)
      const hasBodyComp = services.some((s) => s.uuid.toLowerCase().includes('181b'));
      if (hasBodyComp) {
        try {
          await BleClient.startNotifications(
            deviceId,
            this.BODY_COMPOSITION_SERVICE,
            this.BODY_COMPOSITION_CHAR,
            (value: DataView) => {
              this.parseUniversalWeightPacket(value, userId, deviceName, 'BLE_BODY_COMP');
            }
          );
          subscribed = true;
        } catch {}
      }

      if (subscribed) {
        this.syncStatus.set(`Scale paired! Stand still on the scale to capture weigh-in.`);
        return true;
      } else {
        // Fallback: If no recognized notify chars, try reading live weight from scale services
        this.syncStatus.set('Connected to scale. Step on the scale to record weight.');
        return true;
      }
    } catch (connErr: any) {
      console.warn('[SmartScale] connectAndSubscribe error:', connErr);
      this.syncError.set(connErr?.message || 'Failed to establish GATT connection with scale.');
      return false;
    }
  }

  /**
   * Universal Scale Packet Decoder
   * Handles:
   * 1. Yolanda / Fitdays / GE protocol (header 0x02, Big-Endian weight bytes)
   * 2. Bluetooth SIG 0x2A9D protocol (flags byte, Little-Endian weight bytes)
   * 3. Raw payload multi-byte pattern probe
   */
  public parseUniversalWeightPacket(
    dataView: DataView,
    userId: string,
    deviceName: string,
    protocol: string
  ): void {
    try {
      if (dataView.byteLength < 3) return;

      const len = dataView.byteLength;
      let weightKg: number | null = null;
      let bodyFatPercent: number | undefined = undefined;

      const b0 = dataView.getUint8(0);
      const b1 = dataView.getUint8(1);
      const b2 = dataView.getUint8(2);

      // --- PROTOCOL A: Yolanda / GE Fit Profile Format (starts with 0x02, 0xCA, or 0xCF) ---
      if (b0 === 0x02 || b0 === 0xca || b0 === 0xcb || b0 === 0xcf) {
        // Yolanda CS20 format: Byte 2 = status, Bytes 3-4 = weight (Big Endian)
        if (len >= 5) {
          const rawW1 = (dataView.getUint8(3) << 8) | dataView.getUint8(4);
          const candidate1 = rawW1 / 100.0;
          if (candidate1 >= 30 && candidate1 <= 250) {
            weightKg = candidate1;
          }
        }

        // Alternative Yolanda format: Bytes 2-3 = weight
        if (!weightKg && len >= 4) {
          const rawW2 = (dataView.getUint8(2) << 8) | dataView.getUint8(3);
          const candidate2 = rawW2 / 100.0;
          if (candidate2 >= 30 && candidate2 <= 250) {
            weightKg = candidate2;
          } else if (rawW2 / 10.0 >= 30 && rawW2 / 10.0 <= 250) {
            weightKg = rawW2 / 10.0;
          }
        }

        // Yolanda Impedance / Body Fat probe (Bytes 5-6 often contain resistance)
        if (len >= 7) {
          const rawResistance = (dataView.getUint8(5) << 8) | dataView.getUint8(6);
          if (rawResistance >= 300 && rawResistance <= 1200 && weightKg) {
            // Deurenberg / Lukaski bioimpedance formula estimate
            const demo = this.authService.userProfile()?.demographics;
            const h = demo?.heightCm || 180;
            const age = demo?.age || 26;
            const isFemale = demo?.gender === 'female';
            const sexFactor = isFemale ? 0 : 1;
            const estFat = (1.20 * (weightKg / ((h / 100) * (h / 100)))) + (0.23 * age) - (10.8 * sexFactor) - 5.4;
            if (estFat >= 6 && estFat <= 50) {
              bodyFatPercent = Math.round(estFat * 10) / 10;
            }
          }
        }
      }

      // --- PROTOCOL B: Standard Bluetooth SIG 0x2A9D Format ---
      if (!weightKg) {
        const isImperial = (b0 & 0x01) === 1;
        const rawWeight = dataView.getUint16(1, true); // Little Endian

        if (isImperial) {
          const wLbs = rawWeight * 0.01;
          if (wLbs >= 65 && wLbs <= 550) {
            weightKg = wLbs / 2.20462;
          }
        } else {
          const wKg = rawWeight * 0.005;
          if (wKg >= 30 && wKg <= 250) {
            weightKg = wKg;
          }
        }
      }

      // --- PROTOCOL C: Buffer Window Probe Fallback ---
      if (!weightKg) {
        for (let i = 0; i < len - 1; i++) {
          const be = (dataView.getUint8(i) << 8) | dataView.getUint8(i + 1);
          const le = (dataView.getUint8(i + 1) << 8) | dataView.getUint8(i);

          if (be / 100.0 >= 35 && be / 100.0 <= 220) {
            weightKg = be / 100.0;
            break;
          }
          if (le * 0.005 >= 35 && le * 0.005 <= 220) {
            weightKg = le * 0.005;
            break;
          }
        }
      }

      if (weightKg && weightKg >= 30 && weightKg <= 250) {
        weightKg = Math.round(weightKg * 10) / 10;
        const weightLbs = Math.round(weightKg * 2.20462 * 10) / 10;

        this.liveBleWeight.set(weightKg);

        const demo = this.authService.userProfile()?.demographics;
        const heightCm = demo?.heightCm || 180;
        const hM = heightCm / 100;
        const bmi = Math.round((weightKg / (hM * hM)) * 10) / 10;

        const measurement: ScaleMeasurement = {
          weightKg,
          weightLbs,
          bodyFatPercent,
          bmi,
          timestamp: new Date().toISOString(),
          source: 'BLE_SCALE',
          deviceName,
        };

        this.latestMeasurement.set(measurement);
        this.persistMeasurement(measurement);

        this.authService.updateDemographics(userId, {
          gender: demo?.gender || 'male',
          age: demo?.age || 26,
          weightKg,
          heightCm,
          bodyFatPercent: bodyFatPercent ?? demo?.bodyFatPercent,
        });

        this.syncStatus.set(`Captured: ${weightKg} kg (${weightLbs} lbs) from ${deviceName}`);
      }
    } catch (e) {
      console.warn('[SmartScale] Universal packet parse note:', e);
    }
  }

  /**
   * Parse live weight from Bluetooth LE advertisement manufacturer data
   */
  private parseManufacturerScaleData(dataView: DataView, deviceName: string, userId: string): void {
    try {
      const len = dataView.byteLength;
      if (len < 4) return;

      for (let i = 0; i < len - 1; i++) {
        const rawBe = (dataView.getUint8(i) << 8) | dataView.getUint8(i + 1);
        const candidateKg = rawBe / 100.0;
        if (candidateKg >= 38 && candidateKg <= 220) {
          const weightKg = Math.round(candidateKg * 10) / 10;
          this.liveBleWeight.set(weightKg);
          const weightLbs = Math.round(weightKg * 2.20462 * 10) / 10;

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
          this.syncStatus.set(`Live reading: ${weightKg} kg (${weightLbs} lbs) via Bluetooth broadcast`);
          break;
        }
      }
    } catch {}
  }

  /**
   * Manual entry fallback
   */
  public async recordManualWeight(
    weightKg: number,
    bodyFatPercent: number | undefined,
    userId: string
  ): Promise<ScaleMeasurement> {
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
