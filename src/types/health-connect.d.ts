// Type definitions for @capacitor-community/health-connect
declare module '@capacitor-community/health-connect' {
  export interface PermissionRequestResult {
    granted: string[];
    denied: string[];
  }

  export interface HealthConnectPlugin {
    checkAvailability(): Promise<{ available: boolean }>;
    requestPermissions(options: { permissions: string[] }): Promise<PermissionRequestResult>;
    getHeartRateData(options: { startDate: string; endDate: string }): Promise<{
      samples: Array<{ time: string; beatsPerMinute: number }>;
    }>;
    getSleepData(options: { startDate: string; endDate: string }): Promise<{
      sessions: Array<{
        startTime: string;
        endTime: string;
        stages: Array<{ stage: string; startTime: string; endTime: string }>;
      }>;
    }>;
  }

  export const HealthConnect: HealthConnectPlugin;
}
